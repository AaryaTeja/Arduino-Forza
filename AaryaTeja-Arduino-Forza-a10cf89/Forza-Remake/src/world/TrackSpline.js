import * as THREE from 'three';
import { clamp, clamp01, lerp, smoothstep } from '../core/MathUtils.js';

/**
 * Closed, arc-length-parameterised centreline for the circuit.
 *
 * Everything downstream (road mesh, terrain flattening, AI racing line, checkpoints,
 * minimap, grip lookup) reads from the same sample arrays so they can never drift apart.
 */
export class TrackSpline {
  /**
   * @param {Array<[number,number]>} controlPoints XZ control points, closed loop.
   * @param {number} spacing target metres between samples.
   */
  constructor(controlPoints, spacing = 3.0) {
    this.controlPoints = controlPoints;

    const flat = controlPoints.map(([x, z]) => new THREE.Vector3(x, 0, z));
    this.curve = new THREE.CatmullRomCurve3(flat, true, 'centripetal', 0.5);

    const approxLen = this.curve.getLength();
    this.count = Math.max(256, Math.round(approxLen / spacing));

    // getSpacedPoints(n) returns n+1 points; on a closed curve the last duplicates the first.
    const raw = this.curve.getSpacedPoints(this.count);
    raw.length = this.count;

    const n = this.count;
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.z = new Float32Array(n);
    this.tx = new Float32Array(n);
    this.tz = new Float32Array(n);
    this.ty = new Float32Array(n);
    this.nx = new Float32Array(n);       // right-hand normal in XZ
    this.nz = new Float32Array(n);
    this.curvature = new Float32Array(n); // signed, 1/m
    this.bank = new Float32Array(n);
    this.s = new Float32Array(n);         // arc length at sample
    this.width = new Float32Array(n);     // road half-width
    this.flags = new Uint8Array(n);       // bit 1 = bridge, 2 = tunnel, 4 = city

    for (let i = 0; i < n; i++) {
      this.x[i] = raw[i].x;
      this.z[i] = raw[i].z;
    }

    this._computeArcLength();
    this._computeFrames();
  }

  static FLAG_BRIDGE = 1;
  static FLAG_TUNNEL = 2;
  static FLAG_CITY = 4;

  _computeArcLength() {
    const n = this.count;
    let acc = 0;
    for (let i = 0; i < n; i++) {
      this.s[i] = acc;
      const j = (i + 1) % n;
      acc += Math.hypot(this.x[j] - this.x[i], this.z[j] - this.z[i]);
    }
    this.length = acc;
  }

  _computeFrames() {
    const n = this.count;
    for (let i = 0; i < n; i++) {
      const a = (i - 1 + n) % n, b = (i + 1) % n;
      let dx = this.x[b] - this.x[a];
      let dz = this.z[b] - this.z[a];
      const l = Math.hypot(dx, dz) || 1;
      dx /= l; dz /= l;
      this.tx[i] = dx; this.tz[i] = dz;
      // right-hand normal (pointing to the driver's right when travelling +t)
      this.nx[i] = dz; this.nz[i] = -dx;
    }
    // signed curvature from the turn rate of the tangent per metre
    for (let i = 0; i < n; i++) {
      const a = (i - 2 + n) % n, b = (i + 2) % n;
      const cross = this.tx[a] * this.tz[b] - this.tz[a] * this.tx[b];
      const dot = clamp(this.tx[a] * this.tx[b] + this.tz[a] * this.tz[b], -1, 1);
      const ang = Math.atan2(cross, dot);
      const ds = this._arcBetween(a, b) || 1;
      this.curvature[i] = -ang / ds;
    }
    this._smoothArray(this.curvature, 3, 2);
  }

  _arcBetween(a, b) {
    const n = this.count;
    let d = this.s[b] - this.s[a];
    if (d < 0) d += this.length;
    if (d > this.length * 0.5) d = this.length - d;
    return Math.abs(d);
  }

  /** Circular box blur, in-place, `passes` times with a `radius`-sample window. */
  _smoothArray(arr, radius, passes = 1) {
    const n = arr.length;
    const tmp = new Float32Array(n);
    for (let p = 0; p < passes; p++) {
      for (let i = 0; i < n; i++) {
        let sum = 0, cnt = 0;
        for (let k = -radius; k <= radius; k++) {
          sum += arr[(i + k + n * 4) % n];
          cnt++;
        }
        tmp[i] = sum / cnt;
      }
      arr.set(tmp);
    }
    return arr;
  }

  smooth(arr, radius, passes) { return this._smoothArray(arr, radius, passes); }

  /**
   * Assign elevation from a base terrain function, then smooth it so the road
   * rolls over hills instead of tracing every bump, and clamp the gradient.
   */
  buildElevation(baseHeightFn, opts = {}) {
    const { smoothRadius = 26, passes = 5, maxGrade = 0.085, lift = 0.0 } = opts;
    const n = this.count;
    for (let i = 0; i < n; i++) this.y[i] = baseHeightFn(this.x[i], this.z[i]);
    this._smoothArray(this.y, smoothRadius, passes);

    // enforce a maximum gradient with a few relaxation sweeps (forward then backward)
    const step = this.length / n;
    for (let pass = 0; pass < 24; pass++) {
      let changed = 0;
      for (let dir = 0; dir < 2; dir++) {
        for (let k = 0; k < n; k++) {
          const i = dir === 0 ? k : n - 1 - k;
          const j = (i + 1) % n;
          const dy = this.y[j] - this.y[i];
          const maxDy = maxGrade * step;
          if (Math.abs(dy) > maxDy) {
            const excess = (Math.abs(dy) - maxDy) * 0.5 * Math.sign(dy);
            this.y[i] += excess;
            this.y[j] -= excess;
            changed++;
          }
        }
      }
      if (!changed) break;
    }
    this._smoothArray(this.y, 6, 2);
    if (lift) for (let i = 0; i < n; i++) this.y[i] += lift;

    // vertical tangent component for road pitch
    for (let i = 0; i < n; i++) {
      const a = (i - 1 + n) % n, b = (i + 1) % n;
      const ds = this._arcBetween(a, b) || 1;
      this.ty[i] = (this.y[b] - this.y[a]) / ds;
    }
  }

  /** Bank the road into corners; capped so it never feels like a wall of death. */
  buildBanking(maxBankRad = 0.10) {
    const n = this.count;
    for (let i = 0; i < n; i++) {
      const k = this.curvature[i];
      this.bank[i] = clamp(k * 260, -1, 1) * maxBankRad;
    }
    this._smoothArray(this.bank, 14, 3);
  }

  /** Vary road width — wider through fast sweepers, tighter in town. */
  buildWidth(base = 8.0, cityHalf = 7.0) {
    const n = this.count;
    for (let i = 0; i < n; i++) {
      const inCity = (this.flags[i] & TrackSpline.FLAG_CITY) !== 0;
      const k = Math.abs(this.curvature[i]);
      let w = base + smoothstep(0.006, 0.0, k) * 1.4;
      if (inCity) w = Math.min(w, cityHalf);
      if (this.flags[i] & TrackSpline.FLAG_TUNNEL) w = Math.min(w, base);
      this.width[i] = w;
    }
    this._smoothArray(this.width, 16, 3);
  }

  markFlag(startIdx, endIdx, flag) {
    const n = this.count;
    let i = startIdx % n;
    const guard = n + 2;
    for (let c = 0; c < guard; c++) {
      this.flags[i] |= flag;
      if (i === endIdx % n) break;
      i = (i + 1) % n;
    }
  }

  /** Index of the sample nearest a world XZ position — brute force, used only at setup. */
  nearestIndexSlow(x, z) {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < this.count; i++) {
      const d = (this.x[i] - x) ** 2 + (this.z[i] - z) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  /** Build a uniform-grid accelerator for nearest-sample queries. */
  buildLookup(bounds, cell = 24, searchRadius = 90) {
    this._lu = { minX: bounds.minX, minZ: bounds.minZ, cell };
    const cols = Math.ceil((bounds.maxX - bounds.minX) / cell) + 1;
    const rows = Math.ceil((bounds.maxZ - bounds.minZ) / cell) + 1;
    this._lu.cols = cols; this._lu.rows = rows;
    const buckets = new Array(cols * rows);
    const r = Math.ceil(searchRadius / cell);
    for (let i = 0; i < this.count; i++) {
      const cx = Math.floor((this.x[i] - bounds.minX) / cell);
      const cz = Math.floor((this.z[i] - bounds.minZ) / cell);
      for (let a = -r; a <= r; a++) {
        for (let b = -r; b <= r; b++) {
          const gx = cx + a, gz = cz + b;
          if (gx < 0 || gz < 0 || gx >= cols || gz >= rows) continue;
          const key = gz * cols + gx;
          (buckets[key] || (buckets[key] = [])).push(i);
        }
      }
    }
    this._lu.buckets = buckets;
    this._lu.searchRadius = searchRadius;
  }

  /**
   * Nearest-point query.
   * @returns {{index:number, dist:number, signedDist:number, y:number, s:number, onRoad:boolean, far:boolean}}
   */
  query(x, z, out = {}) {
    const lu = this._lu;
    out.far = false;
    let best = -1, bestD2 = Infinity;
    if (lu) {
      const gx = Math.floor((x - lu.minX) / lu.cell);
      const gz = Math.floor((z - lu.minZ) / lu.cell);
      if (gx >= 0 && gz >= 0 && gx < lu.cols && gz < lu.rows) {
        const list = lu.buckets[gz * lu.cols + gx];
        if (list) {
          for (let k = 0; k < list.length; k++) {
            const i = list[k];
            const d2 = (this.x[i] - x) ** 2 + (this.z[i] - z) ** 2;
            if (d2 < bestD2) { bestD2 = d2; best = i; }
          }
        }
      }
    }
    if (best < 0) {
      out.far = true;
      out.index = -1; out.dist = lu ? lu.searchRadius : 1e5;
      out.signedDist = out.dist; out.y = 0; out.s = 0; out.onRoad = false;
      return out;
    }

    // refine to the exact perpendicular foot on the two adjacent segments
    const n = this.count;
    const prev = (best - 1 + n) % n, next = (best + 1) % n;
    const cand = [[prev, best], [best, next]];
    let bt = 0, bi = best, bd2 = Infinity;
    for (const [a, b] of cand) {
      const ax = this.x[a], az = this.z[a];
      const bx = this.x[b], bz = this.z[b];
      const abx = bx - ax, abz = bz - az;
      const len2 = abx * abx + abz * abz || 1e-6;
      let t = ((x - ax) * abx + (z - az) * abz) / len2;
      t = clamp01(t);
      const px = ax + abx * t, pz = az + abz * t;
      const d2 = (px - x) ** 2 + (pz - z) ** 2;
      if (d2 < bd2) { bd2 = d2; bt = t; bi = a; }
    }
    const j = (bi + 1) % n;
    const dist = Math.sqrt(bd2);
    const cx = lerp(this.x[bi], this.x[j], bt);
    const cz = lerp(this.z[bi], this.z[j], bt);
    const side = (x - cx) * this.nx[bi] + (z - cz) * this.nz[bi];

    let sVal = this.s[bi] + bt * (((this.s[j] - this.s[bi]) + this.length) % this.length);
    if (sVal >= this.length) sVal -= this.length;

    out.index = bi;
    out.t = bt;
    out.dist = dist;
    out.signedDist = side >= 0 ? dist : -dist;
    out.y = lerp(this.y[bi], this.y[j], bt);
    out.s = sVal;
    out.halfWidth = lerp(this.width[bi], this.width[j], bt);
    out.onRoad = dist <= out.halfWidth;
    return out;
  }

  /** Interpolated sample data at arc length s. */
  sampleAt(s, out = {}) {
    const n = this.count;
    let ss = s % this.length;
    if (ss < 0) ss += this.length;
    let i = Math.floor((ss / this.length) * n) % n;
    // s is not perfectly uniform (samples are equidistant in 3D-projected XZ), so nudge
    let guard = 0;
    while (guard++ < 8) {
      const j = (i + 1) % n;
      const sa = this.s[i];
      let sb = this.s[j]; if (sb <= sa) sb += this.length;
      if (ss < sa) { i = (i - 1 + n) % n; continue; }
      if (ss > sb) { i = (i + 1) % n; continue; }
      break;
    }
    const j = (i + 1) % n;
    const sa = this.s[i];
    let sb = this.s[j]; if (sb <= sa) sb += this.length;
    const t = clamp01((ss - sa) / (sb - sa || 1));
    out.index = i; out.t = t;
    out.x = lerp(this.x[i], this.x[j], t);
    out.z = lerp(this.z[i], this.z[j], t);
    out.y = lerp(this.y[i], this.y[j], t);
    out.tx = this.tx[i]; out.tz = this.tz[i]; out.ty = this.ty[i];
    out.nx = this.nx[i]; out.nz = this.nz[i];
    out.curvature = lerp(this.curvature[i], this.curvature[j], t);
    out.halfWidth = lerp(this.width[i], this.width[j], t);
    out.bank = lerp(this.bank[i], this.bank[j], t);
    out.flags = this.flags[i];
    return out;
  }

  /** Forward arc distance from a to b, in [0, length). */
  forwardArc(sa, sb) {
    let d = sb - sa;
    while (d < 0) d += this.length;
    while (d >= this.length) d -= this.length;
    return d;
  }

  /** Signed shortest arc from a to b, in [-length/2, length/2]. */
  signedArc(sa, sb) {
    let d = this.forwardArc(sa, sb);
    if (d > this.length * 0.5) d -= this.length;
    return d;
  }
}
