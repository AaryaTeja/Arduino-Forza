import * as THREE from 'three';
import { clamp, clamp01, lerp, smoothstep, fbm2, segDist2 } from '../core/MathUtils.js';

export const WORLD = {
  size: 2400,          // metres, square
  half: 1200,
  segments: 300,       // terrain grid resolution (8 m cells)
  waterLevel: -6.5,
  // canyon: a river gorge running in from the west edge and petering out inland
  canyon: { ax: -1260, az: 292, bx: -120, bz: 486, bedY: -13.5, width: 82, taperFrom: 0.72 },
  city: { x: 402, z: -520, radius: 330, falloff: 260, flatY: 11 },
  mountainStart: 880,
  mountainRise: 0.0031,
};

/**
 * Terrain elevation before any road is carved into it. Pure function of XZ.
 * `withCanyon = false` skips the gorge so the bridge deck can be laid at grade.
 */
export function baseHeight(x, z, withCanyon = true) {
  let h = 0;
  h += 21.0 * fbm2(x * 0.00062, z * 0.00062, 3);
  h += 11.5 * fbm2(x * 0.0017 + 31.2, z * 0.0017 - 12.7, 4);
  h += 3.4 * fbm2(x * 0.0061 - 5.1, z * 0.0061 + 8.8, 3);
  h += 1.1 * fbm2(x * 0.019, z * 0.019, 2);
  h += 16;

  // a couple of distinct hills so the circuit has real elevation change
  h += 46 * Math.exp(-(((x - 690) ** 2 + (z + 60) ** 2) / (2 * 300 ** 2)));   // tunnel hill (east)
  h += 34 * Math.exp(-(((x + 260) ** 2 + (z + 210) ** 2) / (2 * 340 ** 2)));  // central rise
  h += 28 * Math.exp(-(((x + 620) ** 2 + (z - 40) ** 2) / (2 * 260 ** 2)));   // west ridge

  // flatten the city basin
  const cd = Math.hypot(x - WORLD.city.x, z - WORLD.city.z);
  const ct = smoothstep(WORLD.city.radius, WORLD.city.radius + WORLD.city.falloff, cd);
  h = lerp(WORLD.city.flatY + 2.2 * fbm2(x * 0.004, z * 0.004, 2), h, ct);

  // carve the canyon
  if (withCanyon) {
    const c = WORLD.canyon;
    const { d2, t } = segDist2(x, z, c.ax, c.az, c.bx, c.bz);
    const d = Math.sqrt(d2);
    const taper = 1 - smoothstep(c.taperFrom, 1.0, t);
    if (taper > 0.001) {
      const bank = smoothstep(c.width * 0.45, c.width * 2.4, d);
      const bed = c.bedY + (1 - taper) * 26;
      h = lerp(lerp(bed, h, bank), h, 1 - taper);
    }
  }

  // ring of mountains keeps the player inside the playable area
  const edge = Math.max(Math.abs(x), Math.abs(z));
  if (edge > WORLD.mountainStart) {
    const e = edge - WORLD.mountainStart;
    h += e * e * WORLD.mountainRise * (0.85 + 0.3 * fbm2(x * 0.0035, z * 0.0035, 3));
  }
  return h;
}

/**
 * Terrain that owns the shared height array used by both the Rapier heightfield
 * and the rendered mesh, so physics and visuals can never disagree.
 */
export class Terrain {
  constructor(spline) {
    this.spline = spline;
    this.N = WORLD.segments;
    this.size = WORLD.size;
    this.heights = new Float32Array((this.N + 1) * (this.N + 1));
    this._q = {};
  }

  /** Road-aware elevation: the corridor around the tarmac is levelled to just below it. */
  height(x, z) {
    const base = baseHeight(x, z);
    const sp = this.spline;
    if (!sp || !sp._lu) return base;
    const q = sp.query(x, z, this._q);
    if (q.far || q.index < 0) return base;

    const w = sp.flattenWeight ? sampleWeight(sp, q) : 1;
    if (w <= 0.001) return base;

    const inner = q.halfWidth + 2.5;
    const outer = q.halfWidth + 40;
    const blend = smoothstep(inner, outer, q.dist);
    const target = q.y - 0.55;
    const levelled = lerp(target, base, blend);
    return lerp(base, levelled, w);
  }

  /** Fill the shared array using Rapier's heightfield indexing: idx = ix*(N+1) + iz. */
  build() {
    const N = this.N, S = this.size, half = S / 2;
    for (let ix = 0; ix <= N; ix++) {
      const x = (ix / N) * S - half;
      for (let iz = 0; iz <= N; iz++) {
        const z = (iz / N) * S - half;
        this.heights[ix * (N + 1) + iz] = this.height(x, z);
      }
    }
    return this.heights;
  }

  heightAtGrid(ix, iz) {
    const N = this.N;
    const cx = clamp(ix, 0, N), cz = clamp(iz, 0, N);
    return this.heights[cx * (N + 1) + cz];
  }

  /** Bilinear sample of the built array — matches the collider exactly. */
  sample(x, z) {
    const N = this.N, S = this.size, half = S / 2;
    const fx = clamp(((x + half) / S) * N, 0, N);
    const fz = clamp(((z + half) / S) * N, 0, N);
    const ix = Math.floor(fx), iz = Math.floor(fz);
    const tx = fx - ix, tz = fz - iz;
    const h00 = this.heightAtGrid(ix, iz);
    const h10 = this.heightAtGrid(ix + 1, iz);
    const h01 = this.heightAtGrid(ix, iz + 1);
    const h11 = this.heightAtGrid(ix + 1, iz + 1);
    return lerp(lerp(h00, h10, tx), lerp(h01, h11, tx), tz);
  }

  /** Renderable mesh generated straight from the collider's height array. */
  buildMesh(materials) {
    const N = this.N, S = this.size, half = S / 2;
    const vcount = (N + 1) * (N + 1);
    const pos = new Float32Array(vcount * 3);
    const col = new Float32Array(vcount * 3);
    const uv = new Float32Array(vcount * 2);
    const idx = new Uint32Array(N * N * 6);

    const c = new THREE.Color();
    const grassA = new THREE.Color('#33632a');
    const grassB = new THREE.Color('#4f7a2c');
    const dryGrass = new THREE.Color('#7d8339');
    const dirt = new THREE.Color('#5e4a30');
    const rock = new THREE.Color('#63605b');
    const sand = new THREE.Color('#96875f');
    const snow = new THREE.Color('#e8edf2');

    const cellSize = S / N;

    for (let ix = 0; ix <= N; ix++) {
      for (let iz = 0; iz <= N; iz++) {
        const vi = ix * (N + 1) + iz;
        const x = (ix / N) * S - half;
        const z = (iz / N) * S - half;
        const y = this.heights[vi];
        pos[vi * 3] = x; pos[vi * 3 + 1] = y; pos[vi * 3 + 2] = z;
        uv[vi * 2] = x / 44; uv[vi * 2 + 1] = z / 44;

        // slope from neighbouring samples
        const hx = this.heightAtGrid(ix + 1, iz) - this.heightAtGrid(ix - 1, iz);
        const hz = this.heightAtGrid(ix, iz + 1) - this.heightAtGrid(ix, iz - 1);
        const slope = Math.hypot(hx, hz) / (2 * cellSize);

        const n1 = fbm2(x * 0.0042, z * 0.0042, 3);
        const n2 = fbm2(x * 0.021, z * 0.021, 2);

        c.copy(grassA).lerp(grassB, clamp01(0.5 + n1 * 0.9));
        c.lerp(dryGrass, clamp01(smoothstep(0.1, 0.55, n1 * 0.7 + 0.2) * 0.55));
        c.lerp(dirt, smoothstep(0.30, 0.62, slope));
        c.lerp(rock, smoothstep(0.60, 1.05, slope));
        c.lerp(sand, smoothstep(4.0, -1.5, y - WORLD.waterLevel) * 0.85);
        c.lerp(snow, smoothstep(118, 172, y + n2 * 14));
        const shade = 0.9 + n2 * 0.12;
        col[vi * 3] = c.r * shade; col[vi * 3 + 1] = c.g * shade; col[vi * 3 + 2] = c.b * shade;
      }
    }

    let o = 0;
    for (let ix = 0; ix < N; ix++) {
      for (let iz = 0; iz < N; iz++) {
        const a = ix * (N + 1) + iz;
        const b = (ix + 1) * (N + 1) + iz;
        const cc = (ix + 1) * (N + 1) + (iz + 1);
        const d = ix * (N + 1) + (iz + 1);
        // winding chosen so the surface normal points +Y
        idx[o++] = a; idx[o++] = d; idx[o++] = b;
        idx[o++] = b; idx[o++] = d; idx[o++] = cc;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();

    const mesh = new THREE.Mesh(geo, materials.terrain);
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.name = 'terrain';
    mesh.matrixAutoUpdate = false;
    return mesh;
  }

  /** Water ribbon following the canyon floor. */
  buildWater(material) {
    const c = WORLD.canyon;
    const steps = 60;
    const pos = [], uv = [], idx = [];
    const dx = c.bx - c.ax, dz = c.bz - c.az;
    const len = Math.hypot(dx, dz);
    const ux = dx / len, uz = dz / len;
    const px = uz, pz = -ux;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const cx = c.ax + dx * t, cz = c.az + dz * t;
      const taper = 1 - smoothstep(c.taperFrom, 1.0, t);
      const w = c.width * 0.62 * taper;
      const y = WORLD.waterLevel + (1 - taper) * 22;
      pos.push(cx + px * w, y, cz + pz * w);
      pos.push(cx - px * w, y, cz - pz * w);
      uv.push(0, t * len / 30, 1, t * len / 30);
      if (i < steps) {
        const a = i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, material);
    m.name = 'water';
    m.matrixAutoUpdate = false;
    return m;
  }
}

function sampleWeight(sp, q) {
  const n = sp.count;
  const i = q.index, j = (i + 1) % n;
  return lerp(sp.flattenWeight[i], sp.flattenWeight[j], q.t || 0);
}
