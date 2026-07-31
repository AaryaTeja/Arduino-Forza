import * as THREE from 'three';
import { TrackSpline } from './TrackSpline.js';
import { lerp, smoothstep } from '../core/MathUtils.js';

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _tmp = new THREE.Vector3();

/**
 * Orthonormal frame at a spline sample, including road banking.
 * Writes into `outR`/`outU`; forward is returned.
 */
export function frameAt(sp, i, outR, outU) {
  _fwd.set(sp.tx[i], sp.ty[i], sp.tz[i]).normalize();
  outR.set(sp.nx[i], 0, sp.nz[i]).normalize();
  outU.crossVectors(outR, _fwd).normalize();
  if (outU.y < 0) outU.negate();
  const bank = sp.bank[i];
  if (bank !== 0) {
    outR.applyAxisAngle(_fwd, bank);
    outU.applyAxisAngle(_fwd, bank);
  }
  return _fwd;
}

/**
 * Loft a cross-section along a run of spline samples.
 * @param profileFn (i, sp, row) => Array<{x, y, u}>  cross-section in the local (right, up) frame
 */
export function buildRibbon(sp, indices, profileFn, { vScale = 1 / 24, closed = false } = {}) {
  const rows = indices.length;
  const first = profileFn(indices[0], sp, 0);
  const cols = first.length;
  const positions = new Float32Array(rows * cols * 3);
  const uvs = new Float32Array(rows * cols * 2);
  const idx = [];
  const R = new THREE.Vector3(), U = new THREE.Vector3();

  for (let r = 0; r < rows; r++) {
    const i = indices[r];
    frameAt(sp, i, R, U);
    const prof = r === 0 ? first : profileFn(i, sp, r);
    const cx = sp.x[i], cy = sp.y[i], cz = sp.z[i];
    const v = sp.s[i] * vScale;
    for (let c = 0; c < cols; c++) {
      const p = prof[c];
      const o = (r * cols + c) * 3;
      positions[o] = cx + R.x * p.x + U.x * p.y;
      positions[o + 1] = cy + R.y * p.x + U.y * p.y;
      positions[o + 2] = cz + R.z * p.x + U.z * p.y;
      const uo = (r * cols + c) * 2;
      uvs[uo] = p.u;
      uvs[uo + 1] = v;
    }
  }

  const rowCount = closed ? rows : rows - 1;
  for (let r = 0; r < rowCount; r++) {
    const r0 = r * cols;
    const r1 = ((r + 1) % rows) * cols;
    for (let c = 0; c < cols - 1; c++) {
      idx.push(r0 + c, r1 + c, r0 + c + 1);
      idx.push(r0 + c + 1, r1 + c, r1 + c + 1);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/** Contiguous index runs (with wrap) where predicate(i) holds. */
export function findRuns(sp, predicate, minLen = 3, pad = 0) {
  const n = sp.count;
  const hit = new Uint8Array(n);
  for (let i = 0; i < n; i++) hit[i] = predicate(i) ? 1 : 0;
  if (pad > 0) {
    const grown = hit.slice();
    for (let i = 0; i < n; i++) {
      if (!hit[i]) continue;
      for (let k = -pad; k <= pad; k++) grown[(i + k + n * 4) % n] = 1;
    }
    hit.set(grown);
  }
  const runs = [];
  let start = -1;
  // rotate so we never start mid-run
  let offset = 0;
  while (offset < n && hit[offset]) offset++;
  if (offset >= n) return [Array.from({ length: n }, (_, i) => i)];
  for (let k = 0; k <= n; k++) {
    const i = (offset + k) % n;
    const on = k < n ? hit[i] : 0;
    if (on && start < 0) start = k;
    else if (!on && start >= 0) {
      if (k - start >= minLen) {
        const arr = [];
        for (let q = start; q <= k; q++) arr.push((offset + Math.min(q, n - 1)) % n);
        runs.push(arr);
      }
      start = -1;
    }
  }
  return runs;
}

export const SHOULDER = 1.35;
const CROWN = 0.055;
const SHOULDER_DROP = 0.14;

/** Full road cross-section, normalised so u = 0..1 spans tarmac + both shoulders. */
function roadProfile(i, sp) {
  const hw = sp.width[i];
  const total = hw + SHOULDER;
  const pts = [];
  const xs = [-total, -hw, -hw * 0.5, 0, hw * 0.5, hw, total];
  for (let k = 0; k < xs.length; k++) {
    const x = xs[k];
    const a = Math.abs(x);
    let y;
    if (a <= hw) y = CROWN * (1 - (a / hw) ** 2);
    else y = -SHOULDER_DROP * smoothstep(hw, total, a);
    pts.push({ x, y, u: (x + total) / (2 * total) });
  }
  return pts;
}

export class RoadBuilder {
  constructor(spline, terrain) {
    this.sp = spline;
    this.terrain = terrain;
    this.colliderTris = { positions: [], indices: [] };
    this.boxColliders = [];   // {pos:[x,y,z], quat:[x,y,z,w], half:[hx,hy,hz]}
  }

  _appendCollider(geo) {
    const pos = geo.attributes.position.array;
    const index = geo.index.array;
    const base = this.colliderTris.positions.length / 3;
    for (let i = 0; i < pos.length; i++) this.colliderTris.positions.push(pos[i]);
    for (let i = 0; i < index.length; i++) this.colliderTris.indices.push(base + index[i]);
  }

  /** Main tarmac surface. */
  buildRoad(material) {
    const sp = this.sp;
    const all = Array.from({ length: sp.count }, (_, i) => i);
    const geo = buildRibbon(sp, all, roadProfile, { vScale: 1 / 24, closed: true });
    this._appendCollider(geo);
    const mesh = new THREE.Mesh(geo, material);
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.name = 'road';
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = 1;
    return mesh;
  }

  /** Red/white kerbs on the apex side of quick corners. */
  buildKerbs(material) {
    const sp = this.sp;
    const runs = findRuns(sp, (i) => Math.abs(sp.curvature[i]) > 0.0042 && !(sp.flags[i] & TrackSpline.FLAG_BRIDGE), 6, 3);
    const group = new THREE.Group();
    group.name = 'kerbs';
    for (const run of runs) {
      let signSum = 0;
      for (const i of run) signSum += Math.sign(sp.curvature[i]);
      const side = signSum >= 0 ? 1 : -1;   // apex side
      for (const s of [side, -side * 0]) {
        if (s === 0) continue;
        const profile = (i, _sp, row) => {
          const hw = sp.width[i];
          const t = runTaper(run.length, row);
          const h = 0.02 + 0.085 * t;
          const w = 1.3 * t;
          const inner = hw * s;
          const outer = (hw + w) * s;
          const pts = [
            { x: inner, y: 0.005, u: 0 },
            { x: lerp(inner, outer, 0.35), y: h, u: 0.35 },
            { x: outer, y: h * 0.82, u: 1 },
            { x: outer + 0.22 * s, y: -0.06, u: 1.06 },
          ];
          return s > 0 ? pts : pts.reverse();
        };
        const geo = buildRibbon(sp, run, profile, { vScale: 1 / 2.4 });
        this._appendCollider(geo);
        const m = new THREE.Mesh(geo, material);
        m.receiveShadow = true;
        m.matrixAutoUpdate = false;
        m.renderOrder = 2;
        group.add(m);
      }
    }
    return group;
  }

  /** Raised concrete sidewalks through the city district. */
  buildSidewalks(material) {
    const sp = this.sp;
    const runs = findRuns(sp, (i) => (sp.flags[i] & TrackSpline.FLAG_CITY) !== 0, 8, 0);
    const group = new THREE.Group();
    group.name = 'sidewalks';
    for (const run of runs) {
      for (const s of [1, -1]) {
        const profile = (i, _sp, row) => {
          const hw = sp.width[i] + SHOULDER;
          const t = runTaper(run.length, row);
          const h = 0.155 * t;
          const inner = hw * s;
          const outer = (hw + 3.4) * s;
          const pts = [
            { x: inner, y: -SHOULDER_DROP + 0.01, u: 0 },
            { x: inner + 0.10 * s, y: h, u: 0.05 },
            { x: outer, y: h + 0.02, u: 1.6 },
            { x: outer + 0.4 * s, y: -0.3, u: 1.8 },
          ];
          return s > 0 ? pts : pts.reverse();
        };
        const geo = buildRibbon(sp, run, profile, { vScale: 1 / 6 });
        this._appendCollider(geo);
        const m = new THREE.Mesh(geo, material);
        m.receiveShadow = true;
        m.matrixAutoUpdate = false;
        group.add(m);
      }
    }
    return group;
  }

  /**
   * Barriers: concrete on the bridge, Armco where the ground falls away.
   * Visual is a ribbon; physics is a chain of oriented boxes so nothing can tunnel through.
   */
  buildBarriers(concreteMat, metalMat, postMat) {
    const sp = this.sp;
    const terrain = this.terrain;
    const group = new THREE.Group();
    group.name = 'barriers';
    const R = new THREE.Vector3(), U = new THREE.Vector3();

    const needs = (i, s) => {
      if (sp.flags[i] & TrackSpline.FLAG_BRIDGE) return 'concrete';
      if (sp.flags[i] & TrackSpline.FLAG_TUNNEL) return null;
      frameAt(sp, i, R, U);
      const off = sp.width[i] + SHOULDER + 6;
      const px = sp.x[i] + R.x * off * s;
      const pz = sp.z[i] + R.z * off * s;
      const drop = sp.y[i] - terrain.sample(px, pz);
      if (drop > 2.6) return 'metal';
      return null;
    };

    for (const s of [1, -1]) {
      for (const kind of ['concrete', 'metal']) {
        const runs = findRuns(sp, (i) => needs(i, s) === kind, 5, 2);
        for (const run of runs) {
          const isConcrete = kind === 'concrete';
          const topY = isConcrete ? 1.05 : 0.86;
          const botY = isConcrete ? -0.15 : 0.42;
          const thick = isConcrete ? 0.34 : 0.09;
          const profile = (i, _sp, row) => {
            const t = runTaper(run.length, row);
            const off = (sp.width[i] + SHOULDER * 0.75) * s;
            const hi = lerp(botY, topY, t);
            const pts = [
              { x: off, y: botY, u: 0 },
              { x: off, y: hi, u: 1 },
              { x: off + thick * s, y: hi, u: 1.1 },
              { x: off + thick * s, y: botY, u: 0.1 },
            ];
            return s > 0 ? pts : pts.reverse();
          };
          const geo = buildRibbon(sp, run, profile, { vScale: 1 / 4 });
          const m = new THREE.Mesh(geo, isConcrete ? concreteMat : metalMat);
          m.castShadow = true; m.receiveShadow = true; m.matrixAutoUpdate = false;
          group.add(m);

          // physics boxes every few samples
          const stride = Math.max(2, Math.round(6 / (sp.length / sp.count)));
          for (let k = 0; k < run.length - 1; k += stride) {
            const a = run[k], b = run[Math.min(k + stride, run.length - 1)];
            if (a === b) continue;
            frameAt(sp, a, R, U);
            const offA = (sp.width[a] + SHOULDER * 0.75 + thick * 0.5) * s;
            const ax = sp.x[a] + R.x * offA, ay = sp.y[a], az = sp.z[a] + R.z * offA;
            frameAt(sp, b, R, U);
            const offB = (sp.width[b] + SHOULDER * 0.75 + thick * 0.5) * s;
            const bx = sp.x[b] + R.x * offB, by = sp.y[b], bz = sp.z[b] + R.z * offB;
            const mx = (ax + bx) / 2, my = (ay + by) / 2 + (topY + botY) / 2, mz = (az + bz) / 2;
            const len = Math.hypot(bx - ax, bz - az) / 2 + 0.35;
            const yaw = Math.atan2(bx - ax, bz - az);
            const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0));
            this.boxColliders.push({
              pos: [mx, my, mz],
              quat: [q.x, q.y, q.z, q.w],
              half: [thick * 0.6, (topY - botY) / 2 + 0.1, len],
              friction: isConcrete ? 0.55 : 0.35,
              restitution: isConcrete ? 0.08 : 0.18,
            });
          }

          // Armco posts
          if (!isConcrete) {
            const postGeo = new THREE.BoxGeometry(0.1, 0.9, 0.12);
            const step = Math.max(2, Math.round(4 / (sp.length / sp.count)));
            const count = Math.floor(run.length / step);
            if (count > 0) {
              const inst = new THREE.InstancedMesh(postGeo, postMat, count);
              inst.castShadow = true;
              const mtx = new THREE.Matrix4();
              const q = new THREE.Quaternion();
              let n = 0;
              for (let k = 0; k < run.length && n < count; k += step) {
                const i = run[k];
                frameAt(sp, i, R, U);
                const off = (sp.width[i] + SHOULDER * 0.75) * s;
                q.setFromEuler(new THREE.Euler(0, Math.atan2(sp.tx[i], sp.tz[i]), 0));
                mtx.compose(
                  new THREE.Vector3(sp.x[i] + R.x * off, sp.y[i] + 0.1, sp.z[i] + R.z * off),
                  q, new THREE.Vector3(1, 1, 1),
                );
                inst.setMatrixAt(n++, mtx);
              }
              inst.count = n;
              inst.instanceMatrix.needsUpdate = true;
              group.add(inst);
            }
          }
        }
      }
    }
    return group;
  }

  /** Painted start/finish line across the road. */
  buildStartLine(material, index) {
    const sp = this.sp;
    const n = sp.count;
    const span = Math.max(2, Math.round(1.6 / (sp.length / n)));
    const run = [];
    for (let k = -span; k <= span; k++) run.push((index + k + n) % n);
    const profile = (i) => {
      const hw = sp.width[i];
      return [
        { x: -hw, y: 0.012, u: 0 },
        { x: 0, y: 0.012 + CROWN, u: 0.5 },
        { x: hw, y: 0.012, u: 1 },
      ];
    };
    const geo = buildRibbon(sp, run, profile, { vScale: 1 / 3.2 });
    const m = new THREE.Mesh(geo, material);
    m.matrixAutoUpdate = false;
    m.renderOrder = 3;
    m.name = 'startline';
    return m;
  }
}

function runTaper(n, k) {
  if (n < 5) return 1;
  const fadeLen = Math.min(6, Math.floor(n / 3));
  return Math.min(smoothstep(0, fadeLen, k), smoothstep(0, fadeLen, n - 1 - k));
}
