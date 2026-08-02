import * as THREE from 'three';
import { TrackSpline } from './TrackSpline.js';
import { Terrain, WORLD, baseHeight } from './Terrain.js';
import { RoadBuilder, SHOULDER, frameAt } from './RoadBuilder.js';
import {
  buildCity, buildVegetation, buildStreetFurniture, buildTunnel,
  buildBridge, buildStartGantry, buildFences,
} from './Props.js';
import { TRACK_CONTROL_POINTS, TUNNEL_ANCHOR, CHECKPOINT_COUNT } from '../data/track.js';
import { GROUP } from '../physics/Physics.js';
import { REFERENCE_LAT_ACCEL } from '../data/cars.js';
import { clamp, smoothstep, segDist2 } from '../core/MathUtils.js';

/** Yield to the browser between build steps. Races rAF against a timer so the
 *  loader still completes in a hidden/background tab, where rAF never fires. */
const nextFrame = () => new Promise((resolve) => {
  let done = false;
  const finish = () => { if (!done) { done = true; resolve(); } };
  requestAnimationFrame(finish);
  setTimeout(finish, 32);
});

const _R = new THREE.Vector3();
const _U = new THREE.Vector3();

/**
 * Owns the static world: spline, terrain, road, props and their physics colliders,
 * plus the surface queries the vehicles and AI depend on.
 */
export class WorldModel {
  constructor() {
    this.root = new THREE.Group();
    this.root.name = 'world';
    this.wetness = 0;
    this.spline = null;
    this.terrain = null;
    this._q = {};
    this.detailGroups = [];
  }

  async build(physics, materials, gfx, onProgress = () => {}) {
    const timings = [];
    const step = async (frac, label, fn) => {
      onProgress(frac, label);
      await nextFrame();
      const t0 = performance.now();
      const r = fn();
      timings.push([label, Math.round(performance.now() - t0)]);
      return r;
    };
    this.timings = timings;

    /* ── 1. centreline ── */
    await step(0.06, 'Surveying the circuit', () => {
      this.spline = new TrackSpline(TRACK_CONTROL_POINTS, 3.0);
    });
    const sp = this.spline;

    /* ── 2. section flags ── */
    await step(0.12, 'Marking sections', () => {
      const canyon = WORLD.canyon;
      for (let i = 0; i < sp.count; i++) {
        const { d2, t } = segDist2(sp.x[i], sp.z[i], canyon.ax, canyon.az, canyon.bx, canyon.bz);
        const taper = 1 - smoothstep(canyon.taperFrom, 1.0, t);
        if (Math.sqrt(d2) < 95 && taper > 0.35) sp.flags[i] |= TrackSpline.FLAG_BRIDGE;

        const cd = Math.hypot(sp.x[i] - WORLD.city.x, sp.z[i] - WORLD.city.z);
        if (cd < WORLD.city.radius) sp.flags[i] |= TrackSpline.FLAG_CITY;
      }
      // tunnel: a fixed arc either side of the anchor point
      const anchor = sp.nearestIndexSlow(TUNNEL_ANCHOR.x, TUNNEL_ANCHOR.z);
      const per = sp.length / sp.count;
      const span = Math.round(TUNNEL_ANCHOR.halfLength / per);
      sp.markFlag((anchor - span + sp.count) % sp.count, (anchor + span) % sp.count, TrackSpline.FLAG_TUNNEL);
      this.tunnelAnchorIndex = anchor;
    });

    /* ── 3. elevation ── */
    await step(0.18, 'Raising the terrain', () => {
      // road height ignores the gorge so the bridge spans it at natural ground level
      sp.buildElevation((x, z) => baseHeight(x, z, false), {
        smoothRadius: 26, passes: 5, maxGrade: 0.075, lift: 0.28,
      });
      sp.buildBanking(0.085);
      sp.buildWidth(8.2, 7.0);

      // terrain is levelled beside the road everywhere except across the bridge
      sp.flattenWeight = new Float32Array(sp.count);
      for (let i = 0; i < sp.count; i++) {
        sp.flattenWeight[i] = (sp.flags[i] & TrackSpline.FLAG_BRIDGE) ? 0 : 1;
      }
      sp.smooth(sp.flattenWeight, 8, 3);

      sp.buildLookup({ minX: -WORLD.half, minZ: -WORLD.half, maxX: WORLD.half, maxZ: WORLD.half }, 24, 96);
    });

    await step(0.28, 'Sculpting the landscape', () => {
      this.terrain = new Terrain(sp);
      this.terrain.build();
    });

    /* ── 4. physics: terrain ── */
    await step(0.34, 'Baking terrain collision', () => {
      const N = this.terrain.N;
      physics.addHeightfield(
        this.terrain.heights, N, N,
        { x: WORLD.size, y: 1, z: WORLD.size },
        { friction: 0.86 },
      );
    });

    /* ── 5. terrain + water meshes ── */
    await step(0.42, 'Painting the ground', () => {
      this.terrainMesh = this.terrain.buildMesh(materials);
      this.root.add(this.terrainMesh);
      this.waterMesh = this.terrain.buildWater(materials.water);
      this.root.add(this.waterMesh);
    });

    /* ── 6. road surface ── */
    const rb = new RoadBuilder(sp, this.terrain);
    this.roadBuilder = rb;
    await step(0.50, 'Laying tarmac', () => {
      this.roadMesh = rb.buildRoad(materials.road);
      this.root.add(this.roadMesh);
      this.kerbMesh = rb.buildKerbs(materials.kerb);
      this.root.add(this.kerbMesh);
      this.sidewalkMesh = rb.buildSidewalks(materials.sidewalk);
      this.root.add(this.sidewalkMesh);
    });

    /* ── 7. structures ── */
    await step(0.58, 'Erecting the bridge', () => {
      const bridge = buildBridge(sp, this.terrain, materials.propMaterials);
      this.root.add(bridge.group);
      this._bridgeGeos = bridge.colliderGeos;
    });

    await step(0.64, 'Boring the tunnel', () => {
      const tunnel = buildTunnel(sp, materials.propMaterials);
      this.root.add(tunnel.group);
      this._tunnelGeos = tunnel.colliderGeos;
      this.tunnelLights = tunnel.lights;
    });

    await step(0.70, 'Installing barriers', () => {
      this.barrierMesh = rb.buildBarriers(materials.concrete, materials.barrierMetal, materials.metalPole);
      this.root.add(this.barrierMesh);
    });

    /* ── 8. start/finish ── */
    await step(0.74, 'Painting the start line', () => {
      this.startIndex = this._findStraightest();
      this.startLineMesh = rb.buildStartLine(materials.startLine, this.startIndex);
      this.root.add(this.startLineMesh);
      this.gantry = buildStartGantry(sp, this.startIndex, materials.propMaterials);
      this.root.add(this.gantry);
    });

    /* ── 9. props ── */
    await step(0.80, 'Building the city', () => {
      const city = buildCity(sp, this.terrain, materials, gfx.propDensity);
      this.root.add(city.group);
      this._cityBoxes = city.boxes;
      this.cityGroup = city.group;
    });

    await step(0.87, 'Planting the countryside', () => {
      const veg = buildVegetation(sp, this.terrain, materials.propMaterials, gfx.propDensity);
      this.root.add(veg.group);
      this._treeColliders = veg.colliders;
      this.vegetationGroup = veg.group;
      this.detailGroups.push(veg.group);
    });

    await step(0.91, 'Adding street furniture', () => {
      const furn = buildStreetFurniture(sp, this.terrain, materials.propMaterials, gfx.propDensity);
      this.root.add(furn.group);
      this.streetLamps = furn.lamps;
      this.fenceGroup = buildFences(sp, this.terrain, materials.propMaterials, gfx.propDensity);
      this.root.add(this.fenceGroup);
      this.detailGroups.push(this.fenceGroup);
    });

    /* ── 10. remaining colliders ── */
    await step(0.95, 'Baking collision', () => {
      const tris = rb.colliderTris;
      physics.addTrimesh(new Float32Array(tris.positions), new Uint32Array(tris.indices), {
        friction: 1.0, restitution: 0.02, group: GROUP.ROAD,
      });
      for (const g of [...(this._bridgeGeos || []), ...(this._tunnelGeos || [])]) {
        physics.addTrimesh(g.attributes.position.array, g.index.array, {
          friction: 0.9, restitution: 0.05, group: GROUP.STATIC,
        });
      }
      for (const b of rb.boxColliders) physics.addBox({ ...b, group: GROUP.STATIC });
      for (const b of this._cityBoxes) physics.addBox({ ...b, group: GROUP.STATIC });
      for (const t of this._treeColliders) {
        physics.addCapsule({ pos: t.pos, radius: t.radius, halfHeight: t.halfHeight, friction: 0.7, restitution: 0.25 });
      }
      this._buildWorldBounds(physics);
    });

    await step(0.98, 'Finalising', () => {
      this.checkpoints = this._buildCheckpoints();
      this.racingLine = this._buildRacingLine();
      this.root.updateMatrixWorld(true);
    });

    onProgress(1, 'Ready');
    const total = timings.reduce((a, [, ms]) => a + ms, 0);
    console.debug(`[apex] world built in ${total} ms`, Object.fromEntries(timings));
    return this;
  }

  _buildWorldBounds(physics) {
    const h = WORLD.half + 20;
    for (const [x, z, sx, sz] of [[0, h, h, 4], [0, -h, h, 4], [h, 0, 4, h], [-h, 0, 4, h]]) {
      physics.addBox({ pos: [x, 160, z], half: [sx, 260, sz], friction: 0.2, restitution: 0.1, group: GROUP.STATIC });
    }
  }

  /** Pick the flattest, straightest stretch for the start/finish line. */
  _findStraightest() {
    const sp = this.spline;
    const n = sp.count;
    const win = Math.round(70 / (sp.length / n));
    let best = 0, bestScore = Infinity;
    for (let i = 0; i < n; i++) {
      if (sp.flags[i] & (TrackSpline.FLAG_TUNNEL | TrackSpline.FLAG_BRIDGE | TrackSpline.FLAG_CITY)) continue;
      let score = 0;
      for (let k = -win; k <= win; k++) {
        const j = (i + k + n * 2) % n;
        score += Math.abs(sp.curvature[j]) * 1000 + Math.abs(sp.ty[j]) * 3;
      }
      if (score < bestScore) { bestScore = score; best = i; }
    }
    return best;
  }

  /** Evenly spaced checkpoints, with index 0 on the start/finish line. */
  _buildCheckpoints() {
    const sp = this.spline;
    const list = [];
    const startS = sp.s[this.startIndex];
    for (let k = 0; k < CHECKPOINT_COUNT; k++) {
      const s = (startS + (k / CHECKPOINT_COUNT) * sp.length) % sp.length;
      const smp = sp.sampleAt(s, {});
      frameAt(sp, smp.index, _R, _U);
      list.push({
        index: k,
        s,
        splineIndex: smp.index,
        position: new THREE.Vector3(smp.x, smp.y, smp.z),
        right: _R.clone(),
        up: _U.clone(),
        forward: new THREE.Vector3(smp.tx, smp.ty, smp.tz).normalize(),
        halfWidth: smp.halfWidth + SHOULDER,
        isFinish: k === 0,
      });
    }
    return list;
  }

  /**
   * Pre-computed racing line: lateral offsets that straighten the corners, plus a
   * physically-derived speed profile with a backward braking pass.
   */
  _buildRacingLine() {
    const sp = this.spline;
    const n = sp.count;
    const offset = new Float32Array(n);
    const targetSpeed = new Float32Array(n);

    // out-in-out: sit wide on entry, hug the apex, drift wide on exit
    const curveSmooth = new Float32Array(n);
    curveSmooth.set(sp.curvature);
    sp.smooth(curveSmooth, 8, 3);
    for (let i = 0; i < n; i++) {
      const k = curveSmooth[i];
      const limit = Math.max(1.5, sp.width[i] - 2.6);
      offset[i] = clamp(-Math.sign(k) * smoothstep(0.0008, 0.010, Math.abs(k)) * limit, -limit, limit);
    }
    sp.smooth(offset, 16, 4);

    // curvature of the offset line, then the grip-limited speed
    const step = sp.length / n;
    for (let i = 0; i < n; i++) {
      const a = (i - 6 + n) % n, b = (i + 6) % n;
      const ax = sp.x[a] + sp.nx[a] * offset[a], az = sp.z[a] + sp.nz[a] * offset[a];
      const bx = sp.x[b] + sp.nx[b] * offset[b], bz = sp.z[b] + sp.nz[b] * offset[b];
      const cx = sp.x[i] + sp.nx[i] * offset[i], cz = sp.z[i] + sp.nz[i] * offset[i];
      const radius = circumRadius(ax, az, cx, cz, bx, bz);
      const latAccel = REFERENCE_LAT_ACCEL;      // AI rescale this to their own tyre grip
      let v = Math.sqrt(latAccel * Math.max(radius, 8));
      if (sp.flags[i] & TrackSpline.FLAG_CITY) v = Math.min(v, 58);
      targetSpeed[i] = Math.min(v, 95);
    }
    // backward pass: make sure each point is reachable under braking
    const decel = 11.0;
    for (let pass = 0; pass < 3; pass++) {
      for (let k = n - 1; k >= 0; k--) {
        const i = k, j = (i + 1) % n;
        const vmax = Math.sqrt(targetSpeed[j] * targetSpeed[j] + 2 * decel * step);
        if (targetSpeed[i] > vmax) targetSpeed[i] = vmax;
      }
      // forward pass for acceleration limits
      for (let k = 0; k < n; k++) {
        const i = k, j = (i + 1) % n;
        const vmax = Math.sqrt(targetSpeed[i] * targetSpeed[i] + 2 * 7.5 * step);
        if (targetSpeed[j] > vmax) targetSpeed[j] = vmax;
      }
    }
    sp.smooth(targetSpeed, 4, 2);

    return { offset, targetSpeed };
  }

  /* ═══════════ queries ═══════════ */

  /** Surface classification used by tyre grip and the AI. */
  querySurface(x, z, out = {}) {
    const q = this.spline.query(x, z, out);
    if (q.far) {
      q.edgeDistance = 60;
      q.onRoad = false;
      q.halfWidth = 8;
      return q;
    }
    q.edgeDistance = Math.max(0, q.dist - (q.halfWidth + SHOULDER * 0.6));
    q.onRoad = q.edgeDistance <= 0.01;
    return q;
  }

  groundHeight(x, z) {
    return this.terrain.sample(x, z);
  }

  /** Grid slots behind the start line: two staggered columns. */
  gridSlots(count) {
    const sp = this.spline;
    const startS = sp.s[this.startIndex];
    const slots = [];
    for (let i = 0; i < count; i++) {
      const row = Math.floor(i / 2);
      const col = i % 2;
      const back = 12 + row * 9.5;
      const s = (startS - back + sp.length * 4) % sp.length;
      const smp = sp.sampleAt(s, {});
      frameAt(sp, smp.index, _R, _U);
      const lateral = (col === 0 ? 1 : -1) * (smp.halfWidth * 0.42);
      slots.push({
        x: smp.x + _R.x * lateral,
        y: smp.y + 0.35,
        z: smp.z + _R.z * lateral,
        yaw: Math.atan2(smp.tx, smp.tz),
        s,
      });
    }
    return slots;
  }

  /** Nearest safe spot on the road, facing the right way. */
  respawnPoint(x, z, backOff = 6) {
    const sp = this.spline;
    const q = sp.query(x, z, {});
    const s = (q.far ? sp.s[this.startIndex] : q.s) - backOff;
    const smp = sp.sampleAt((s + sp.length * 2) % sp.length, {});
    frameAt(sp, smp.index, _R, _U);
    return {
      x: smp.x, y: smp.y + 1.2, z: smp.z,
      yaw: Math.atan2(smp.tx, smp.tz),
      s: smp.index,
    };
  }

  /** Point on the racing line at arc length s, with a lateral bias. */
  linePoint(s, bias, out = new THREE.Vector3()) {
    const sp = this.spline;
    const smp = sp.sampleAt(s, this._q);
    const off = this.racingLine.offset[smp.index] + (bias || 0);
    const limit = smp.halfWidth - 1.4;
    const clamped = clamp(off, -limit, limit);
    out.set(smp.x + sp.nx[smp.index] * clamped, smp.y, smp.z + sp.nz[smp.index] * clamped);
    return out;
  }

  setQuality(gfx) {
    for (const g of this.detailGroups) g.visible = gfx.propDensity > 0.4;
    if (this.terrainMesh) this.terrainMesh.receiveShadow = gfx.shadows;
    this.root.traverse((o) => {
      if (o.isMesh || o.isInstancedMesh) {
        if (o.name === 'terrain' || o.name === 'road') return;
        o.castShadow = gfx.shadows && o.castShadow !== false;
      }
    });
  }
}

function circumRadius(ax, az, bx, bz, cx, cz) {
  const A = Math.hypot(bx - ax, bz - az);
  const B = Math.hypot(cx - bx, cz - bz);
  const C = Math.hypot(cx - ax, cz - az);
  const area = Math.abs((bx - ax) * (cz - az) - (cx - ax) * (bz - az)) * 0.5;
  if (area < 1e-6) return 1e6;
  return (A * B * C) / (4 * area);
}
