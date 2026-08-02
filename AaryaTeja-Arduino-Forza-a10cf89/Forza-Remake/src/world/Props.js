import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { TrackSpline } from './TrackSpline.js';
import { buildRibbon, frameAt, findRuns, SHOULDER } from './RoadBuilder.js';
import { WORLD } from './Terrain.js';
import { clamp01, lerp, smoothstep, makeRng, fbm2 } from '../core/MathUtils.js';

const _R = new THREE.Vector3();
const _U = new THREE.Vector3();

/* ═══════════════════════════ buildings ═══════════════════════════ */

/**
 * Box building whose UVs are expressed in tiles (one tile = one window bay × one storey),
 * so windows keep a constant real-world size regardless of the building's dimensions.
 */
function buildingGeometry(w, h, d, bayW = 3.4, storeyH = 3.5) {
  const hw = w / 2, hd = d / 2;
  const nx = Math.max(1, Math.round(w / bayW));
  const nz = Math.max(1, Math.round(d / bayW));
  const ny = Math.max(1, Math.round(h / storeyH));

  const pos = [], nor = [], uv = [], idx = [];
  const quad = (a, b, c, e, n, uw, uh) => {
    const base = pos.length / 3;
    for (const p of [a, b, c, e]) pos.push(p[0], p[1], p[2]);
    for (let i = 0; i < 4; i++) nor.push(n[0], n[1], n[2]);
    uv.push(0, 0, uw, 0, uw, uh, 0, uh);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  // +Z, -Z, +X, -X
  quad([-hw, 0, hd], [hw, 0, hd], [hw, h, hd], [-hw, h, hd], [0, 0, 1], nx, ny);
  quad([hw, 0, -hd], [-hw, 0, -hd], [-hw, h, -hd], [hw, h, -hd], [0, 0, -1], nx, ny);
  quad([hw, 0, hd], [hw, 0, -hd], [hw, h, -hd], [hw, h, hd], [1, 0, 0], nz, ny);
  quad([-hw, 0, -hd], [-hw, 0, hd], [-hw, h, hd], [-hw, h, -hd], [-1, 0, 0], nz, ny);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

function roofGeometry(w, h, d, rng) {
  const parts = [];
  const slab = new THREE.BoxGeometry(w + 0.3, 0.5, d + 0.3);
  slab.translate(0, h + 0.15, 0);
  parts.push(slab);
  // parapet
  for (const [sx, sz, px, pz] of [[w + 0.6, 0.35, 0, d / 2], [w + 0.6, 0.35, 0, -d / 2], [0.35, d + 0.6, w / 2, 0], [0.35, d + 0.6, -w / 2, 0]]) {
    const b = new THREE.BoxGeometry(sx || 0.35, 0.85, sz || 0.35);
    b.translate(px, h + 0.75, pz);
    parts.push(b);
  }
  // rooftop plant
  const units = 1 + Math.floor(rng() * 3);
  for (let i = 0; i < units; i++) {
    const uw = 1.4 + rng() * 3.2, uh = 1.0 + rng() * 2.4, ud = 1.4 + rng() * 3.2;
    const b = new THREE.BoxGeometry(uw, uh, ud);
    b.translate((rng() - 0.5) * (w - uw - 1), h + 0.4 + uh / 2, (rng() - 0.5) * (d - ud - 1));
    parts.push(b);
  }
  if (rng() > 0.6) {
    const mast = new THREE.CylinderGeometry(0.12, 0.18, 4 + rng() * 8, 6);
    const my = h + 0.4 + (4 + rng() * 8) / 2;
    mast.translate((rng() - 0.5) * w * 0.5, my, (rng() - 0.5) * d * 0.5);
    parts.push(mast);
  }
  return mergeGeometries(parts, false);
}

export function buildCity(spline, terrain, materials, density = 1) {
  const rng = makeRng(0xc17a);
  const city = WORLD.city;
  const facadeBuckets = materials.facades.map(() => []);
  const roofParts = [];
  const boxes = [];
  const q = {};

  const grid = 34;
  const span = Math.ceil((city.radius + 120) / grid);
  const mtx = new THREE.Matrix4();

  for (let gx = -span; gx <= span; gx++) {
    for (let gz = -span; gz <= span; gz++) {
      const jitterX = (rng() - 0.5) * 11;
      const jitterZ = (rng() - 0.5) * 11;
      const cx = city.x + gx * grid + jitterX;
      const cz = city.z + gz * grid + jitterZ;
      const distCity = Math.hypot(cx - city.x, cz - city.z);
      if (distCity > city.radius + 80) continue;
      const densityHere = 1 - smoothstep(city.radius * 0.55, city.radius + 70, distCity);
      if (rng() > densityHere * 0.94 * density) continue;

      spline.query(cx, cz, q);
      const clearance = (q.far ? 999 : q.dist) - (q.far ? 0 : q.halfWidth + SHOULDER);
      if (clearance < 7.5) continue;

      const w = 12 + rng() * 15;
      const d = 12 + rng() * 15;
      if (!q.far && q.dist < q.halfWidth + SHOULDER + Math.max(w, d) * 0.5 + 4.5) continue;

      const coreT = 1 - smoothstep(0, city.radius * 0.8, distCity);
      const h = lerp(9, 16, rng()) + Math.pow(rng(), 1.7) * lerp(16, 74, coreT);

      const gy = terrain.sample(cx, cz) - 0.6;
      const yaw = Math.round(rng() * 4) * (Math.PI / 2) + (rng() - 0.5) * 0.09;

      const vi = Math.floor(rng() * facadeBuckets.length);
      const geo = buildingGeometry(w, h, d, 3.0 + rng() * 1.0, 3.3 + rng() * 0.6);
      mtx.makeRotationY(yaw);
      mtx.setPosition(cx, gy, cz);
      geo.applyMatrix4(mtx);
      facadeBuckets[vi].push(geo);

      const rg = roofGeometry(w, h, d, rng);
      rg.applyMatrix4(mtx);
      roofParts.push(rg);

      const qt = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0));
      boxes.push({
        pos: [cx, gy + h / 2, cz],
        quat: [qt.x, qt.y, qt.z, qt.w],
        half: [w / 2, h / 2 + 1.2, d / 2],
        friction: 0.6, restitution: 0.05,
      });
    }
  }

  const group = new THREE.Group();
  group.name = 'city';
  facadeBuckets.forEach((list, i) => {
    if (!list.length) return;
    const merged = mergeGeometries(list, false);
    list.forEach((g) => g.dispose());
    const m = new THREE.Mesh(merged, materials.facades[i]);
    m.castShadow = true; m.receiveShadow = true; m.matrixAutoUpdate = false;
    group.add(m);
  });
  if (roofParts.length) {
    const merged = mergeGeometries(roofParts, false);
    roofParts.forEach((g) => g.dispose());
    const m = new THREE.Mesh(merged, materials.concrete);
    m.castShadow = true; m.receiveShadow = true; m.matrixAutoUpdate = false;
    group.add(m);
  }
  return { group, boxes };
}

/* ═══════════════════════════ vegetation ═══════════════════════════ */

function canopyGeometry(seed) {
  const g = new THREE.IcosahedronGeometry(1, 1);
  const rng = makeRng(seed);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const s = 0.72 + rng() * 0.5;
    p.setXYZ(i, p.getX(i) * s, p.getY(i) * s * 0.92, p.getZ(i) * s);
  }
  g.computeVertexNormals();
  return g;
}

export function buildVegetation(spline, terrain, materials, density = 1) {
  const rng = makeRng(0x77ee);
  const q = {};
  const half = WORLD.half - 60;

  const broadleaf = { trunks: [], canopies: [] };
  const conifer = { trunks: [], canopies: [] };
  const bushes = [];
  const rocks = [];
  const colliders = [];

  const target = Math.round(6200 * density);
  const attempts = target * 4;
  const mtx = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  const posV = new THREE.Vector3();

  for (let a = 0; a < attempts && (broadleaf.trunks.length + conifer.trunks.length) < target; a++) {
    const x = (rng() * 2 - 1) * half;
    const z = (rng() * 2 - 1) * half;

    const cityD = Math.hypot(x - WORLD.city.x, z - WORLD.city.z);
    if (cityD < WORLD.city.radius * 0.9) continue;

    spline.query(x, z, q);
    const roadClear = q.far ? 999 : q.dist - q.halfWidth - SHOULDER;
    if (roadClear < 5.5) continue;

    const y = terrain.sample(x, z);
    if (y < WORLD.waterLevel + 1.6) continue;
    if (y > 128) continue;

    const hx = terrain.sample(x + 4, z) - terrain.sample(x - 4, z);
    const hz = terrain.sample(x, z + 4) - terrain.sample(x, z - 4);
    const slope = Math.hypot(hx, hz) / 8;
    if (slope > 0.68) { if (rng() > 0.12) continue; }

    // forest clumping
    const clump = fbm2(x * 0.0026, z * 0.0026, 3);
    if (rng() > clamp01(0.28 + clump * 1.5)) continue;

    const isConifer = y > 62 || fbm2(x * 0.0012 + 90, z * 0.0012, 2) > 0.12;
    const s = 0.72 + rng() * 0.75;
    const yaw = rng() * Math.PI * 2;
    quat.setFromEuler(new THREE.Euler((rng() - 0.5) * 0.06, yaw, (rng() - 0.5) * 0.06));

    const bucket = isConifer ? conifer : broadleaf;
    const trunkH = (isConifer ? 5.2 : 3.4) * s;
    posV.set(x, y, z);
    scl.set(s, s, s);
    mtx.compose(posV, quat, scl);
    bucket.trunks.push(mtx.clone());

    const canopyY = y + trunkH * (isConifer ? 0.62 : 0.92);
    posV.set(x, canopyY, z);
    const cs = (isConifer ? 2.1 : 3.1) * s;
    scl.set(cs * (0.85 + rng() * 0.3), (isConifer ? cs * 1.9 : cs * 0.92), cs * (0.85 + rng() * 0.3));
    mtx.compose(posV, quat, scl);
    bucket.canopies.push(mtx.clone());

    if (roadClear < 48) {
      colliders.push({ pos: [x, y + trunkH * 0.7, z], radius: 0.24 * s, halfHeight: trunkH * 0.7 });
    }
  }

  // bushes and rocks scattered near the road for close-range detail
  const detailTarget = Math.round(1500 * density);
  for (let a = 0; a < detailTarget * 5 && bushes.length < detailTarget; a++) {
    const x = (rng() * 2 - 1) * half;
    const z = (rng() * 2 - 1) * half;
    spline.query(x, z, q);
    const roadClear = q.far ? 999 : q.dist - q.halfWidth - SHOULDER;
    if (roadClear < 2.2 || roadClear > 110) continue;
    const y = terrain.sample(x, z);
    if (y < WORLD.waterLevel + 1) continue;
    const s = 0.5 + rng() * 0.9;
    quat.setFromEuler(new THREE.Euler(0, rng() * 6.28, 0));
    posV.set(x, y + 0.25 * s, z);
    scl.set(s, s * 0.7, s);
    mtx.compose(posV, quat, scl);
    if (rng() > 0.34) bushes.push(mtx.clone());
    else {
      scl.set(s * 1.3, s * (0.6 + rng() * 0.7), s * 1.3);
      posV.set(x, y + 0.1 * s, z);
      mtx.compose(posV, quat, scl);
      rocks.push(mtx.clone());
    }
  }

  const group = new THREE.Group();
  group.name = 'vegetation';

  const trunkGeo = new THREE.CylinderGeometry(0.16, 0.26, 1, 6, 1);
  trunkGeo.translate(0, 0.5, 0);
  const coniferTrunk = new THREE.CylinderGeometry(0.12, 0.30, 1, 6, 1);
  coniferTrunk.translate(0, 0.5, 0);
  const broadCanopy = canopyGeometry(11);
  const coniferCanopy = new THREE.ConeGeometry(1, 1, 8, 3);
  coniferCanopy.translate(0, 0.28, 0);
  const bushGeo = canopyGeometry(23);
  const rockGeo = new THREE.IcosahedronGeometry(1, 0);

  const addInstanced = (geo, mat, matrices, castShadow = true) => {
    if (!matrices.length) return null;
    const inst = new THREE.InstancedMesh(geo, mat, matrices.length);
    matrices.forEach((m, i) => inst.setMatrixAt(i, m));
    inst.instanceMatrix.needsUpdate = true;
    inst.castShadow = castShadow;
    inst.receiveShadow = true;
    inst.frustumCulled = false;
    group.add(inst);
    return inst;
  };

  addInstanced(trunkGeo, materials.bark, broadleaf.trunks.map((m) => scaleTrunk(m, 3.4)));
  addInstanced(coniferTrunk, materials.bark, conifer.trunks.map((m) => scaleTrunk(m, 5.2)));
  addInstanced(broadCanopy, materials.leafBroad, broadleaf.canopies);
  addInstanced(coniferCanopy, materials.leafConifer, conifer.canopies);
  addInstanced(bushGeo, materials.bush, bushes, false);
  addInstanced(rockGeo, materials.rock, rocks);

  return { group, colliders, count: broadleaf.trunks.length + conifer.trunks.length };
}

function scaleTrunk(m, height) {
  const out = m.clone();
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  out.decompose(p, q, s);
  s.y *= height;
  s.x *= 1; s.z *= 1;
  out.compose(p, q, s);
  return out;
}

/* ═══════════════════════════ street furniture ═══════════════════════════ */

export function buildStreetFurniture(spline, terrain, materials, density = 1) {
  const group = new THREE.Group();
  group.name = 'streetFurniture';
  const sp = spline;
  const step = Math.max(2, Math.round(30 / (sp.length / sp.count)));
  const poles = [], heads = [], lamps = [], signs = [], markers = [];
  const mtx = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const rng = makeRng(0x5a1e);

  for (let i = 0; i < sp.count; i += step) {
    if (sp.flags[i] & TrackSpline.FLAG_TUNNEL) continue;
    const inCity = (sp.flags[i] & TrackSpline.FLAG_CITY) !== 0;
    if (!inCity && rng() > 0.42 * density) continue;
    const side = (Math.floor(i / step) % 2) ? 1 : -1;
    frameAt(sp, i, _R, _U);
    const off = (sp.width[i] + SHOULDER + (inCity ? 2.4 : 1.6)) * side;
    const px = sp.x[i] + _R.x * off;
    const pz = sp.z[i] + _R.z * off;
    const py = Math.min(sp.y[i], terrain.sample(px, pz) + 0.4) - 0.2;
    // local +Z points from the pole toward the road centre, so the merged arm overhangs it
    const inX = -_R.x * side, inZ = -_R.z * side;
    quat.setFromEuler(new THREE.Euler(0, Math.atan2(inX, inZ), 0));

    mtx.compose(new THREE.Vector3(px, py, pz), quat, new THREE.Vector3(1, 1, 1));
    poles.push(mtx.clone());
    const ARM = 2.45;
    const hx = px + inX * ARM, hz = pz + inZ * ARM;
    mtx.compose(new THREE.Vector3(hx, py + 7.94, hz), quat, new THREE.Vector3(1, 1, 1));
    heads.push(mtx.clone());
    lamps.push({ x: hx, y: py + 7.9, z: hz });
  }

  // corner marker boards on quick corners
  const runs = findRuns(sp, (i) => Math.abs(sp.curvature[i]) > 0.005 && !(sp.flags[i] & TrackSpline.FLAG_TUNNEL), 5, 0);
  for (const run of runs) {
    const s = Math.sign(sp.curvature[run[Math.floor(run.length / 2)]]) >= 0 ? -1 : 1;
    for (let k = 0; k < run.length; k += Math.max(2, Math.round(9 / (sp.length / sp.count)))) {
      const i = run[k];
      frameAt(sp, i, _R, _U);
      const off = (sp.width[i] + SHOULDER + 1.1) * s;
      const px = sp.x[i] + _R.x * off, pz = sp.z[i] + _R.z * off;
      const py = sp.y[i] - 0.1;
      quat.setFromEuler(new THREE.Euler(0, Math.atan2(sp.tx[i], sp.tz[i]), 0));
      mtx.compose(new THREE.Vector3(px, py, pz), quat, new THREE.Vector3(1, 1, 1));
      markers.push(mtx.clone());
    }
  }

  const poleGeo = new THREE.CylinderGeometry(0.10, 0.14, 8, 6);
  poleGeo.translate(0, 4, 0);
  const armGeo = new THREE.BoxGeometry(0.09, 0.12, 2.9);
  armGeo.translate(0, 8.02, 1.25);
  const poleMerged = mergeGeometries([poleGeo, armGeo], false);
  const headGeo = new THREE.BoxGeometry(0.44, 0.15, 0.95);
  const markerGeo = new THREE.BoxGeometry(0.36, 0.9, 0.06);
  markerGeo.translate(0, 0.62, 0);
  const markerPost = new THREE.CylinderGeometry(0.045, 0.045, 0.6, 5);
  markerPost.translate(0, 0.3, 0);
  const markerMerged = mergeGeometries([markerGeo, markerPost], false);

  const add = (geo, mat, mats, cast = true) => {
    if (!mats.length) return null;
    const inst = new THREE.InstancedMesh(geo, mat, mats.length);
    mats.forEach((m, i) => inst.setMatrixAt(i, m));
    inst.instanceMatrix.needsUpdate = true;
    inst.castShadow = cast; inst.receiveShadow = true;
    inst.frustumCulled = false;
    group.add(inst);
    return inst;
  };

  add(poleMerged, materials.metalPole, poles);
  const headMesh = add(headGeo, materials.lampHead, heads, false);
  add(markerMerged, materials.marker, markers);

  return { group, lamps, headMesh };
}

/* ═══════════════════════════ tunnel ═══════════════════════════ */

function archProfile(hw, k, K) {
  // ordered right-bottom → over the top → left-bottom
  const R = hw + 2.2;
  const springY = 1.7;
  const H = R * 0.92;
  if (k === 0) return { x: R, y: -0.4 };
  if (k === K) return { x: -R, y: -0.4 };
  if (k === 1) return { x: R, y: springY };
  if (k === K - 1) return { x: -R, y: springY };
  const t = (k - 1) / (K - 2);
  const a = t * Math.PI;
  return { x: R * Math.cos(a), y: springY + H * Math.sin(a) };
}

function hillProfile(hw, k, K, taper, x2, z2) {
  const W = (hw + 2.2) + 46 * taper;
  const H = 12 + 30 * taper;
  if (k === 0) return { x: W, y: -3.0 };
  if (k === K) return { x: -W, y: -3.0 };
  const t = (k - 1) / (K - 2);
  const a = t * Math.PI;
  const n = 1 + 0.16 * fbm2(x2 * 0.02 + k * 0.7, z2 * 0.02, 2);
  return { x: W * Math.cos(a) * n, y: 1.0 + H * Math.pow(Math.sin(a), 0.72) * n };
}

export function buildTunnel(spline, materials) {
  const sp = spline;
  const runs = findRuns(sp, (i) => (sp.flags[i] & TrackSpline.FLAG_TUNNEL) !== 0, 4, 0);
  const group = new THREE.Group();
  group.name = 'tunnel';
  const colliderGeos = [];
  const lights = [];
  if (!runs.length) return { group, colliderGeos, lights };

  const K = 22;
  const PORTAL_TAPER = 0.20;

  for (const run of runs) {
    const n = run.length;

    const arch = buildRibbon(sp, run, (i, _s, row) => {
      const hw = sp.width[i];
      const pts = [];
      for (let k = 0; k <= K; k++) {
        const p = archProfile(hw, k, K);
        pts.push({ x: p.x, y: p.y, u: k / K * 2.2 });
      }
      return pts;
    }, { vScale: 1 / 8 });
    const archMesh = new THREE.Mesh(arch, materials.tunnelWall);
    archMesh.receiveShadow = true;
    archMesh.matrixAutoUpdate = false;
    group.add(archMesh);
    colliderGeos.push(arch);

    const hill = buildRibbon(sp, run, (i, _s, row) => {
      const hw = sp.width[i];
      const taper = PORTAL_TAPER + (1 - PORTAL_TAPER) * Math.min(smoothstep(0, n * 0.30, row), smoothstep(0, n * 0.30, n - 1 - row));
      const pts = [];
      for (let k = 0; k <= K; k++) {
        const p = hillProfile(hw, k, K, taper, sp.x[i], sp.z[i]);
        pts.push({ x: p.x, y: p.y, u: k / K * 5 });
      }
      return pts;
    }, { vScale: 1 / 14 });
    const hillMesh = new THREE.Mesh(hill, materials.rockFace);
    hillMesh.castShadow = true; hillMesh.receiveShadow = true;
    hillMesh.matrixAutoUpdate = false;
    group.add(hillMesh);
    colliderGeos.push(hill);

    // portal facades: quad strip between the arch outline and the hill outline
    for (const end of [0, n - 1]) {
      const i = run[end];
      const hw = sp.width[i];
      const taper = PORTAL_TAPER;
      frameAt(sp, i, _R, _U);
      const cx = sp.x[i], cy = sp.y[i], cz = sp.z[i];
      const pos = [], idx = [], uvs = [];
      for (let k = 0; k <= K; k++) {
        const a = archProfile(hw, k, K);
        const h = hillProfile(hw, k, K, taper, cx, cz);
        pos.push(cx + _R.x * a.x + _U.x * a.y, cy + _R.y * a.x + _U.y * a.y, cz + _R.z * a.x + _U.z * a.y);
        pos.push(cx + _R.x * h.x + _U.x * h.y, cy + _R.y * h.x + _U.y * h.y, cz + _R.z * h.x + _U.z * h.y);
        uvs.push(k / K * 4, 0, k / K * 4, 1);
        if (k < K) {
          const b = k * 2;
          if (end === 0) idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
          else idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      g.setIndex(idx);
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, materials.portal);
      m.castShadow = true; m.receiveShadow = true; m.matrixAutoUpdate = false;
      group.add(m);
      colliderGeos.push(g);
    }

    // ceiling light strips
    const strip = buildRibbon(sp, run, (i) => {
      const hw = sp.width[i];
      const p = archProfile(hw, Math.round(K / 2), K);
      return [
        { x: -0.55, y: p.y - 0.28, u: 0 },
        { x: 0.55, y: p.y - 0.28, u: 1 },
      ];
    }, { vScale: 1 / 6 });
    const stripMesh = new THREE.Mesh(strip, materials.tunnelLight);
    stripMesh.matrixAutoUpdate = false;
    group.add(stripMesh);

    const lightStep = Math.max(3, Math.round(26 / (sp.length / sp.count)));
    for (let k = 0; k < n; k += lightStep) {
      const i = run[k];
      lights.push({ x: sp.x[i], y: sp.y[i] + 5.4, z: sp.z[i] });
    }
  }

  return { group, colliderGeos, lights };
}

/* ═══════════════════════════ bridge ═══════════════════════════ */

export function buildBridge(spline, terrain, materials) {
  const sp = spline;
  const runs = findRuns(sp, (i) => (sp.flags[i] & TrackSpline.FLAG_BRIDGE) !== 0, 4, 0);
  const group = new THREE.Group();
  group.name = 'bridge';
  const colliderGeos = [];
  if (!runs.length) return { group, colliderGeos };

  for (const run of runs) {
    const n = run.length;

    // box girder under the deck
    const deck = buildRibbon(sp, run, (i) => {
      const hw = sp.width[i] + SHOULDER;
      return [
        { x: hw + 0.5, y: -0.16, u: 0 },
        { x: hw + 0.1, y: -1.7, u: 0.2 },
        { x: hw * 0.55, y: -2.5, u: 0.4 },
        { x: -hw * 0.55, y: -2.5, u: 0.6 },
        { x: -hw - 0.1, y: -1.7, u: 0.8 },
        { x: -hw - 0.5, y: -0.16, u: 1 },
      ];
    }, { vScale: 1 / 9 });
    const deckMesh = new THREE.Mesh(deck, materials.concrete);
    deckMesh.castShadow = true; deckMesh.receiveShadow = true; deckMesh.matrixAutoUpdate = false;
    group.add(deckMesh);
    colliderGeos.push(deck);

    // tied arches either side, with hangers
    const archH = 22;
    const parts = [];
    const arcPts = { l: [], r: [] };
    for (let k = 0; k < n; k++) {
      const i = run[k];
      const t = k / (n - 1);
      const y = sp.y[i] + Math.sin(t * Math.PI) * archH;
      frameAt(sp, i, _R, _U);
      const off = sp.width[i] + SHOULDER + 0.9;
      arcPts.r.push(new THREE.Vector3(sp.x[i] + _R.x * off, y, sp.z[i] + _R.z * off));
      arcPts.l.push(new THREE.Vector3(sp.x[i] - _R.x * off, y, sp.z[i] - _R.z * off));
    }
    for (const side of ['l', 'r']) {
      const pts = arcPts[side];
      const curve = new THREE.CatmullRomCurve3(pts);
      const tube = new THREE.TubeGeometry(curve, Math.max(24, n), 0.42, 7, false);
      parts.push(tube);
    }
    // hangers + cross bracing
    const hangerStep = Math.max(2, Math.round(11 / (sp.length / sp.count)));
    for (let k = hangerStep; k < n - hangerStep; k += hangerStep) {
      const i = run[k];
      const t = k / (n - 1);
      const top = sp.y[i] + Math.sin(t * Math.PI) * archH;
      const h = top - sp.y[i];
      if (h < 2) continue;
      frameAt(sp, i, _R, _U);
      const off = sp.width[i] + SHOULDER + 0.9;
      for (const s of [1, -1]) {
        const g = new THREE.CylinderGeometry(0.075, 0.075, h, 5);
        g.translate(sp.x[i] + _R.x * off * s, sp.y[i] + h / 2, sp.z[i] + _R.z * off * s);
        parts.push(g);
      }
      if (Math.sin(t * Math.PI) > 0.34) {
        const w = off * 2;
        const g = new THREE.BoxGeometry(0.3, 0.3, w);
        const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.atan2(_R.x, _R.z), 0));
        const m = new THREE.Matrix4().compose(new THREE.Vector3(sp.x[i], top - 0.3, sp.z[i]), q, new THREE.Vector3(1, 1, 1));
        g.applyMatrix4(m);
        parts.push(g);
      }
    }
    const steel = new THREE.Mesh(mergeGeometries(parts, false), materials.steel);
    steel.castShadow = true; steel.receiveShadow = true; steel.matrixAutoUpdate = false;
    group.add(steel);
    parts.forEach((p) => p.dispose());

    // piers down to the canyon floor
    const pierParts = [];
    const pierStep = Math.max(3, Math.round(34 / (sp.length / sp.count)));
    for (let k = pierStep; k < n - pierStep * 0.5; k += pierStep) {
      const i = run[k];
      const ground = terrain.sample(sp.x[i], sp.z[i]);
      const top = sp.y[i] - 2.4;
      const h = top - ground;
      if (h < 3) continue;
      const g = new THREE.CylinderGeometry(1.5, 2.4, h + 2, 10);
      g.translate(sp.x[i], ground + (h + 2) / 2 - 1, sp.z[i]);
      pierParts.push(g);
    }
    if (pierParts.length) {
      const piers = new THREE.Mesh(mergeGeometries(pierParts, false), materials.concrete);
      piers.castShadow = true; piers.receiveShadow = true; piers.matrixAutoUpdate = false;
      group.add(piers);
      pierParts.forEach((p) => p.dispose());
    }
  }
  return { group, colliderGeos };
}

/* ═══════════════════════════ start gantry ═══════════════════════════ */

export function buildStartGantry(spline, index, materials) {
  const sp = spline;
  frameAt(sp, index, _R, _U);
  const hw = sp.width[index] + SHOULDER + 1.6;
  const g = new THREE.Group();
  g.name = 'gantry';
  const legH = 8.4;
  const parts = [];
  for (const s of [1, -1]) {
    const leg = new THREE.BoxGeometry(0.5, legH, 0.5);
    leg.translate(_R.x * hw * s, legH / 2, _R.z * hw * s);
    parts.push(leg);
  }
  const beam = new THREE.BoxGeometry(0.55, 0.75, hw * 2);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), _R.clone().normalize());
  beam.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(0, legH, 0), q, new THREE.Vector3(1, 1, 1)));
  parts.push(beam);
  const frame = new THREE.Mesh(mergeGeometries(parts, false), materials.steel);
  frame.castShadow = true; frame.receiveShadow = true;
  g.add(frame);
  parts.forEach((p) => p.dispose());

  // banner panel
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(hw * 1.75, 1.9), materials.banner);
  panel.position.set(0, legH - 1.25, 0);
  panel.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(-sp.tx[index], 0, -sp.tz[index]).normalize());
  panel.castShadow = false;
  g.add(panel);

  g.position.set(sp.x[index], sp.y[index], sp.z[index]);
  g.updateMatrixWorld(true);
  return g;
}

/* ═══════════════════════════ fences ═══════════════════════════ */

export function buildFences(spline, terrain, materials, density = 1) {
  const rng = makeRng(0x3f11);
  const group = new THREE.Group();
  group.name = 'fences';
  const posts = [];
  const rails = [];
  const mtx = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const sp = spline;
  const step = Math.max(2, Math.round(4 / (sp.length / sp.count)));

  for (let i = 0; i < sp.count; i += step) {
    const f = sp.flags[i];
    if (f & (TrackSpline.FLAG_BRIDGE | TrackSpline.FLAG_TUNNEL | TrackSpline.FLAG_CITY)) continue;
    if (rng() > 0.55 * density) continue;
    for (const s of [1, -1]) {
      frameAt(sp, i, _R, _U);
      const off = (sp.width[i] + SHOULDER + 9 + rng() * 4) * s;
      const px = sp.x[i] + _R.x * off, pz = sp.z[i] + _R.z * off;
      const py = terrain.sample(px, pz);
      if (py < WORLD.waterLevel + 1) continue;
      const yaw = Math.atan2(sp.tx[i], sp.tz[i]);
      quat.setFromEuler(new THREE.Euler(0, yaw, 0));
      mtx.compose(new THREE.Vector3(px, py - 0.15, pz), quat, new THREE.Vector3(1, 1, 1));
      posts.push(mtx.clone());
      const len = (sp.length / sp.count) * step * 1.12;
      mtx.compose(new THREE.Vector3(px, py + 0.62, pz), quat, new THREE.Vector3(1, 1, len));
      rails.push(mtx.clone());
    }
  }

  const postGeo = new THREE.CylinderGeometry(0.06, 0.075, 1.25, 5);
  postGeo.translate(0, 0.62, 0);
  const railGeo = new THREE.BoxGeometry(0.05, 0.09, 1);

  for (const [geo, mats] of [[postGeo, posts], [railGeo, rails]]) {
    if (!mats.length) continue;
    const inst = new THREE.InstancedMesh(geo, materials.fence, mats.length);
    mats.forEach((m, i) => inst.setMatrixAt(i, m));
    inst.instanceMatrix.needsUpdate = true;
    inst.castShadow = true;
    inst.frustumCulled = false;
    group.add(inst);
  }
  return group;
}
