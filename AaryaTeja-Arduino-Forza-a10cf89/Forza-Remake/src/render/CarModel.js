import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp, clamp01, smoothstep, TAU } from '../core/MathUtils.js';

const RADIAL = 26;
const CABIN_SEG = 18;

/* ═══════════════════════════ lofting helpers ═══════════════════════════ */

/** Superellipse ring, starting at the bottom and going anticlockwise. */
function ring(halfW, yBot, yTop, n, topTaper, samples, target) {
  const cy = (yBot + yTop) / 2;
  const ry = (yTop - yBot) / 2;
  const e = 2 / n;
  for (let k = 0; k < samples; k++) {
    const th = (k / samples) * TAU - Math.PI / 2;
    const c = Math.cos(th), s = Math.sin(th);
    let x = halfW * Math.sign(c) * Math.pow(Math.abs(c), e);
    const y = cy + ry * Math.sign(s) * Math.pow(Math.abs(s), e);
    x *= 1 - topTaper * clamp01(s);
    target.push(x, y);
  }
}

/** Loft a closed tube through stations {z, halfW, yBot, yTop, n, taper}. */
function loftClosed(stations, samples = RADIAL) {
  const rows = stations.length;
  const pos = [], uv = [], idx = [];
  for (let r = 0; r < rows; r++) {
    const st = stations[r];
    const flat = [];
    ring(st.halfW, st.yBot, st.yTop, st.n, st.taper, samples, flat);
    for (let k = 0; k < samples; k++) {
      pos.push(flat[k * 2], flat[k * 2 + 1], st.z);
      uv.push(k / samples, r / (rows - 1));
    }
  }
  for (let r = 0; r < rows - 1; r++) {
    for (let k = 0; k < samples; k++) {
      const k2 = (k + 1) % samples;
      const a = r * samples + k, b = r * samples + k2;
      const c = (r + 1) * samples + k, d = (r + 1) * samples + k2;
      // wound so face normals point away from the body axis
      idx.push(a, b, c, b, d, c);
    }
  }
  // caps
  const capFan = (rowIdx, flip) => {
    const base = pos.length / 3;
    let cx = 0, cy = 0;
    for (let k = 0; k < samples; k++) {
      cx += pos[(rowIdx * samples + k) * 3];
      cy += pos[(rowIdx * samples + k) * 3 + 1];
    }
    pos.push(cx / samples, cy / samples, stations[rowIdx].z);
    uv.push(0.5, 0.5);
    for (let k = 0; k < samples; k++) {
      const k2 = (k + 1) % samples;
      const a = rowIdx * samples + k, b = rowIdx * samples + k2;
      if (flip) idx.push(base, b, a); else idx.push(base, a, b);
    }
  };
  capFan(0, true);
  capFan(rows - 1, false);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Greenhouse shell: an open half-tube from the beltline over the roof. */
function loftCabin(stations, roofRange, samples = CABIN_SEG) {
  const rows = stations.length;
  const pos = [], uv = [];
  const paintIdx = [], glassIdx = [];
  for (let r = 0; r < rows; r++) {
    const st = stations[r];
    const e = 2 / st.n;
    for (let k = 0; k <= samples; k++) {
      const th = (k / samples) * Math.PI;
      const c = Math.cos(th), s = Math.sin(th);
      const x = st.halfW * Math.sign(c) * Math.pow(Math.abs(c), e);
      const y = st.yBot + (st.yTop - st.yBot) * Math.pow(Math.abs(s), e);
      pos.push(x, y, st.z);
      uv.push(k / samples, r / (rows - 1));
    }
  }
  const cols = samples + 1;
  for (let r = 0; r < rows - 1; r++) {
    const st = stations[r];
    for (let k = 0; k < samples; k++) {
      const a = r * cols + k, b = r * cols + k + 1;
      const c = (r + 1) * cols + k, d = (r + 1) * cols + k + 1;
      const th = ((k + 0.5) / samples) * Math.PI;
      const nearSide = Math.abs(Math.cos(th)) > 0.86;
      const midZ = (st.z + stations[r + 1].z) / 2;
      const isRoof = midZ >= roofRange[0] && midZ <= roofRange[1] && Math.abs(Math.cos(th)) < 0.93;
      const target = (isRoof || nearSide) ? paintIdx : glassIdx;
      target.push(a, c, b, b, c, d);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex([...paintIdx, ...glassIdx]);
  g.addGroup(0, paintIdx.length, 0);
  g.addGroup(paintIdx.length, glassIdx.length, 1);
  g.computeVertexNormals();
  return g;
}

/* ═══════════════════════════ body profiles ═══════════════════════════ */

/**
 * Interpolate a station field at an arbitrary z so detail parts can be pinned to
 * the actual body surface instead of hand-guessed offsets.
 */
function sampleStations(stations, z, field) {
  if (z >= stations[0].z) return stations[0][field];
  const last = stations[stations.length - 1];
  if (z <= last.z) return last[field];
  for (let i = 1; i < stations.length; i++) {
    if (z >= stations[i].z) {
      const a = stations[i - 1], b = stations[i];
      const t = (z - a.z) / (b.z - a.z || 1);
      return a[field] + (b[field] - a[field]) * t;
    }
  }
  return last[field];
}

function attachSamplers(p) {
  // body stations run front (+z) to rear (-z) after this sort
  const sorted = [...p.body].sort((a, b) => b.z - a.z);
  p.halfWidthAt = (z) => sampleStations(sorted, z, 'halfW');
  p.topAt = (z) => sampleStations(sorted, z, 'yTop');
  p.bottomAt = (z) => sampleStations(sorted, z, 'yBot');
  p.noseZ = sorted[0].z;
  p.tailZ = sorted[sorted.length - 1].z;
  p.cowlZ = p.cabin[0].z;
  p.cabinRearZ = p.cabin[p.cabin.length - 1].z;
  p.roofY = Math.max(...p.cabin.map((c) => c.yTop));
  const cabinSorted = [...p.cabin].sort((a, b) => b.z - a.z);
  p.cabinTopAt = (z) => sampleStations(cabinSorted, z, 'yTop');
  return p;
}

function profileFor(kind, W, L, hubY, ride) {
  const hw = W / 2, hl = L / 2;
  const S = (t, wf, yb, yt, n = 5, taper = 0) => ({ z: t * hl, halfW: hw * wf, yBot: yb, yTop: yt, n, taper });

  switch (kind) {
    case 'super': {
      const belt = hubY + 0.50, sill = ride + 0.03;
      return attachSamplers({
        body: [
          S(-1.00, 0.68, sill + 0.30, belt - 0.05, 4.0, 0.12),
          S(-0.94, 0.99, sill + 0.16, belt + 0.02, 4.6, 0.10),
          S(-0.72, 1.02, sill + 0.04, belt + 0.05, 5.2, 0.08),
          S(-0.40, 1.00, sill, belt + 0.02, 5.4, 0.10),
          S(-0.05, 0.97, sill, belt - 0.02, 5.4, 0.14),
          S(0.32, 0.99, sill + 0.01, belt - 0.06, 5.0, 0.16),
          S(0.66, 0.96, sill + 0.05, belt - 0.14, 4.6, 0.18),
          S(0.88, 0.86, sill + 0.12, belt - 0.20, 4.0, 0.16),
          S(1.00, 0.66, sill + 0.20, belt - 0.24, 3.4, 0.10),
        ],
        cabin: [
          S(0.30, 0.80, belt - 0.06, belt - 0.02, 2.9),
          S(0.14, 0.86, belt - 0.05, belt + 0.20, 3.1),
          S(-0.04, 0.88, belt - 0.04, belt + 0.38, 3.3),
          S(-0.22, 0.87, belt - 0.04, belt + 0.40, 3.3),
          S(-0.40, 0.84, belt - 0.05, belt + 0.30, 3.1),
          S(-0.56, 0.78, belt - 0.06, belt + 0.10, 2.9),
        ],
        roofRange: [-0.30 * hl, -0.02 * hl],
        beltline: belt, sill,
        wingZ: -0.90, splitter: 0.10, hasIntakes: true, exhaustCount: 2,
      });
    }
    case 'hatch': {
      const belt = hubY + 0.60, sill = ride + 0.06;
      return attachSamplers({
        body: [
          S(-1.00, 0.78, sill + 0.26, belt + 0.12, 4.4, 0.06),
          S(-0.92, 0.98, sill + 0.12, belt + 0.16, 5.0, 0.05),
          S(-0.62, 1.00, sill + 0.02, belt + 0.14, 5.4, 0.05),
          S(-0.20, 1.00, sill, belt + 0.10, 5.4, 0.06),
          S(0.22, 0.99, sill, belt + 0.04, 5.2, 0.08),
          S(0.58, 0.96, sill + 0.03, belt - 0.04, 4.8, 0.10),
          S(0.86, 0.88, sill + 0.10, belt - 0.12, 4.2, 0.10),
          S(1.00, 0.70, sill + 0.20, belt - 0.16, 3.6, 0.08),
        ],
        cabin: [
          S(0.34, 0.84, belt + 0.06, belt + 0.10, 2.9),
          S(0.16, 0.90, belt + 0.06, belt + 0.34, 3.1),
          S(-0.04, 0.93, belt + 0.06, belt + 0.56, 3.5),
          S(-0.34, 0.93, belt + 0.06, belt + 0.58, 3.5),
          S(-0.62, 0.90, belt + 0.06, belt + 0.54, 3.3),
          S(-0.82, 0.84, belt + 0.08, belt + 0.34, 2.9),
          S(-0.94, 0.76, belt + 0.10, belt + 0.18, 2.9),
        ],
        roofRange: [-0.62 * hl, -0.02 * hl],
        beltline: belt, sill,
        wingZ: -0.80, splitter: 0.05, hasIntakes: false, exhaustCount: 1, roofSpoiler: true,
      });
    }
    case 'suv': {
      const belt = hubY + 0.66, sill = ride + 0.02;
      return attachSamplers({
        body: [
          S(-1.00, 0.82, sill + 0.20, belt + 0.16, 5.0, 0.04),
          S(-0.90, 1.00, sill + 0.08, belt + 0.20, 5.6, 0.04),
          S(-0.58, 1.02, sill, belt + 0.18, 6.0, 0.04),
          S(-0.18, 1.02, sill - 0.02, belt + 0.16, 6.0, 0.05),
          S(0.24, 1.00, sill - 0.02, belt + 0.12, 5.8, 0.06),
          S(0.62, 0.97, sill + 0.02, belt + 0.04, 5.2, 0.08),
          S(0.88, 0.90, sill + 0.10, belt - 0.06, 4.4, 0.08),
          S(1.00, 0.74, sill + 0.18, belt - 0.10, 3.8, 0.06),
        ],
        cabin: [
          S(0.40, 0.86, belt + 0.12, belt + 0.16, 3.3),
          S(0.22, 0.92, belt + 0.12, belt + 0.40, 3.5),
          S(0.02, 0.95, belt + 0.12, belt + 0.62, 3.9),
          S(-0.34, 0.96, belt + 0.12, belt + 0.66, 4.1),
          S(-0.68, 0.94, belt + 0.12, belt + 0.64, 3.9),
          S(-0.88, 0.88, belt + 0.14, belt + 0.48, 3.3),
        ],
        roofRange: [-0.70 * hl, 0.04 * hl],
        beltline: belt, sill,
        wingZ: -0.86, splitter: 0.0, hasIntakes: false, exhaustCount: 2, roofRack: true, roofSpoiler: true,
      });
    }
    case 'gt3': {
      const belt = hubY + 0.48, sill = ride + 0.02;
      return attachSamplers({
        body: [
          S(-1.00, 0.76, sill + 0.24, belt + 0.02, 4.4, 0.10),
          S(-0.92, 1.04, sill + 0.10, belt + 0.08, 5.0, 0.10),
          S(-0.68, 1.08, sill + 0.01, belt + 0.10, 5.6, 0.08),
          S(-0.36, 1.02, sill, belt + 0.06, 5.6, 0.10),
          S(0.00, 0.98, sill, belt + 0.02, 5.4, 0.12),
          S(0.34, 1.02, sill, belt - 0.04, 5.2, 0.14),
          S(0.68, 1.05, sill + 0.03, belt - 0.12, 4.8, 0.16),
          S(0.90, 0.94, sill + 0.08, belt - 0.18, 4.2, 0.14),
          S(1.00, 0.74, sill + 0.14, belt - 0.22, 3.6, 0.10),
        ],
        cabin: [
          S(0.36, 0.82, belt + 0.02, belt + 0.06, 2.9),
          S(0.18, 0.88, belt + 0.02, belt + 0.28, 3.1),
          S(-0.02, 0.90, belt + 0.02, belt + 0.46, 3.5),
          S(-0.28, 0.90, belt + 0.02, belt + 0.48, 3.5),
          S(-0.52, 0.86, belt + 0.02, belt + 0.34, 3.1),
          S(-0.70, 0.80, belt + 0.04, belt + 0.14, 2.9),
        ],
        roofRange: [-0.34 * hl, -0.02 * hl],
        beltline: belt, sill,
        wingZ: -0.92, splitter: 0.16, hasIntakes: true, exhaustCount: 2, cage: true,
      });
    }
    default: { // coupe
      const belt = hubY + 0.56, sill = ride + 0.04;
      return attachSamplers({
        body: [
          S(-1.00, 0.70, sill + 0.28, belt + 0.02, 4.2, 0.10),
          S(-0.93, 0.96, sill + 0.14, belt + 0.06, 4.8, 0.08),
          S(-0.72, 1.01, sill + 0.02, belt + 0.08, 5.4, 0.07),
          S(-0.36, 1.00, sill, belt + 0.05, 5.4, 0.08),
          S(0.02, 0.99, sill, belt, 5.4, 0.10),
          S(0.40, 0.99, sill + 0.01, belt - 0.06, 5.2, 0.12),
          S(0.72, 0.95, sill + 0.04, belt - 0.14, 4.6, 0.14),
          S(0.92, 0.86, sill + 0.12, belt - 0.20, 4.0, 0.12),
          S(1.00, 0.68, sill + 0.20, belt - 0.24, 3.4, 0.08),
        ],
        cabin: [
          S(0.36, 0.84, belt + 0.01, belt + 0.05, 2.9),
          S(0.18, 0.90, belt + 0.01, belt + 0.26, 3.1),
          S(-0.04, 0.92, belt + 0.01, belt + 0.44, 3.5),
          S(-0.30, 0.92, belt + 0.01, belt + 0.46, 3.5),
          S(-0.54, 0.88, belt + 0.01, belt + 0.32, 3.1),
          S(-0.76, 0.80, belt + 0.03, belt + 0.12, 2.9),
        ],
        roofRange: [-0.34 * hl, -0.02 * hl],
        beltline: belt, sill,
        wingZ: -0.90, splitter: 0.06, hasIntakes: false, exhaustCount: 2,
      });
    }
  }
}

/* ═══════════════════════════ wheels ═══════════════════════════ */

function tyreGeometry(radius, width) {
  const hw = width / 2;
  const pts = [
    new THREE.Vector2(radius * 0.66, -hw),
    new THREE.Vector2(radius * 0.86, -hw * 1.0),
    new THREE.Vector2(radius * 0.98, -hw * 0.82),
    new THREE.Vector2(radius, -hw * 0.55),
    new THREE.Vector2(radius, hw * 0.55),
    new THREE.Vector2(radius * 0.98, hw * 0.82),
    new THREE.Vector2(radius * 0.86, hw * 1.0),
    new THREE.Vector2(radius * 0.66, hw),
  ];
  const g = new THREE.LatheGeometry(pts, 24);
  g.rotateZ(Math.PI / 2);   // lathe spins around Y; the wheel axle is X
  return g;
}

function rimGeometry(style, radius, width) {
  const rimR = radius * 0.68;
  const hw = width / 2;
  const parts = [];

  const barrel = new THREE.CylinderGeometry(rimR, rimR, width * 0.94, 24, 1, true);
  barrel.rotateZ(Math.PI / 2);
  parts.push(barrel);

  const faceZ = hw * 0.72;
  const hub = new THREE.CylinderGeometry(rimR * 0.26, rimR * 0.26, width * 0.30, 14);
  hub.rotateZ(Math.PI / 2);
  hub.translate(faceZ * 0.5, 0, 0);
  parts.push(hub);

  const lip = new THREE.TorusGeometry(rimR * 0.985, radius * 0.030, 6, 26);
  lip.rotateY(Math.PI / 2);
  lip.translate(faceZ, 0, 0);
  parts.push(lip);

  const addSpoke = (angle, w, len, thick, inner) => {
    const s = new THREE.BoxGeometry(thick, len, w);
    s.translate(0, inner + len / 2, 0);
    s.rotateX(angle);
    s.translate(faceZ * 0.72, 0, 0);
    parts.push(s);
  };

  if (style === 1) {          // 5-spoke
    for (let i = 0; i < 5; i++) addSpoke((i / 5) * TAU, rimR * 0.34, rimR * 0.74, radius * 0.075, rimR * 0.20);
  } else if (style === 2) {   // turbofan: a solid dish with slots
    const shape = new THREE.Shape();
    shape.absarc(0, 0, rimR * 0.96, 0, TAU, false);
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * TAU;
      const hole = new THREE.Path();
      const cx = Math.cos(a) * rimR * 0.60, cy = Math.sin(a) * rimR * 0.60;
      hole.absarc(cx, cy, rimR * 0.20, 0, TAU, true);
      shape.holes.push(hole);
    }
    // ExtrudeGeometry comes out non-indexed, which mergeGeometries refuses to mix
    const dish = mergeVertices(new THREE.ExtrudeGeometry(shape, {
      depth: radius * 0.05, bevelEnabled: false, curveSegments: 14,
    }));
    dish.clearGroups();
    dish.rotateY(Math.PI / 2);
    dish.translate(faceZ * 0.86, 0, 0);
    parts.push(dish);
  } else if (style === 3) {   // split 6
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU;
      addSpoke(a - 0.13, rimR * 0.16, rimR * 0.76, radius * 0.05, rimR * 0.18);
      addSpoke(a + 0.13, rimR * 0.16, rimR * 0.76, radius * 0.05, rimR * 0.18);
    }
  } else {                    // mesh
    for (let i = 0; i < 18; i++) addSpoke((i / 18) * TAU, rimR * 0.10, rimR * 0.78, radius * 0.032, rimR * 0.16);
  }

  return mergeGeometries(parts, false);
}

/* ═══════════════════════════ car model ═══════════════════════════ */

export class CarModel {
  /**
   * @param {object} car   catalogue entry
   * @param {object} build paint/wheel/tune selections
   * @param {object} lib   MaterialLibrary
   * @param {object} opts  { groundLocalY, quality }
   */
  constructor(car, build, lib, opts = {}) {
    this.car = car;
    this.build = build;
    this.lib = lib;
    this.groundLocalY = opts.groundLocalY ?? -0.45;

    const b = car.body;
    this.profile = profileFor(b.profile, b.width, b.length, b.wheelRadius, b.rideHeight);

    this.group = new THREE.Group();
    this.group.name = `car:${car.id}`;

    this.chassis = new THREE.Group();
    this.group.add(this.chassis);

    // everything inside `shell` is authored with y = 0 at the ground
    this.shell = new THREE.Group();
    this.shell.position.y = this.groundLocalY;
    this.chassis.add(this.shell);

    this._buildMaterials();
    this._buildBody();
    this._buildGreenhouse();
    this._buildDetails();
    this._buildInterior();
    this._buildLights();
    this._buildWheels();

    this.brakeGlow = 0;
    this.headlightsOn = false;
    this._dentAccum = 0;
  }

  /* ── materials ── */

  _buildMaterials() {
    const b = this.build;
    const colour = new THREE.Color(b.paint);
    const finish = b.finish || 'gloss';

    const base = {
      color: colour,
      envMapIntensity: 1.15,
      clearcoat: 1.0,
      clearcoatRoughness: 0.045,
    };
    if (finish === 'metallic') {
      Object.assign(base, { metalness: 0.72, roughness: 0.30, normalMap: this.lib.flakeNormal, normalScale: new THREE.Vector2(0.11, 0.11) });
    } else if (finish === 'matte') {
      Object.assign(base, { metalness: 0.02, roughness: 0.68, clearcoat: 0.16, clearcoatRoughness: 0.5 });
    } else if (finish === 'pearl') {
      Object.assign(base, { metalness: 0.30, roughness: 0.20, iridescence: 0.55, iridescenceIOR: 1.4, clearcoatRoughness: 0.02 });
    } else {
      Object.assign(base, { metalness: 0.05, roughness: 0.28 });
    }

    this.paint = new THREE.MeshPhysicalMaterial(base);
    this._installStripes(this.paint);

    this.trim = new THREE.MeshStandardMaterial({ color: 0x14171b, roughness: 0.55, metalness: 0.35, envMapIntensity: 1.1 });
    this.darkPlastic = new THREE.MeshStandardMaterial({ color: 0x0d1013, roughness: 0.82, metalness: 0.08 });
    this.chrome = new THREE.MeshStandardMaterial({ color: 0xc8cdd4, roughness: 0.16, metalness: 1.0, envMapIntensity: 2.0 });
    this.glass = new THREE.MeshPhysicalMaterial({
      color: 0x121a22, roughness: 0.075, metalness: 0.0,
      transparent: true, opacity: 0.26, envMapIntensity: 1.25,
      clearcoat: 1, clearcoatRoughness: 0.02, side: THREE.DoubleSide, depthWrite: false,
    });
    this.interiorMat = new THREE.MeshStandardMaterial({ color: 0x15181d, roughness: 0.86, metalness: 0.04 });
    this.headliner = new THREE.MeshStandardMaterial({ color: 0x1b1f25, roughness: 0.9, metalness: 0.02, side: THREE.BackSide });
    this.glazingHole = new THREE.MeshBasicMaterial({ visible: false });
    this.seatMat = new THREE.MeshStandardMaterial({ color: 0x22262c, roughness: 0.9 });

    this.rimMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(this.build.rimColour || '#d6dae2'),
      roughness: 0.24, metalness: 0.92, envMapIntensity: 1.8,
    });
    this.tyreMat = new THREE.MeshStandardMaterial({ color: 0x131417, roughness: 0.93, metalness: 0.0 });
    this.caliperMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(this.build.caliperColour || '#e03a1a'),
      roughness: 0.4, metalness: 0.4,
    });
    this.discMat = new THREE.MeshStandardMaterial({
      color: 0x3b3f45, roughness: 0.35, metalness: 0.85,
      emissive: new THREE.Color(0xff3300), emissiveIntensity: 0,
    });

    this.headlightMat = new THREE.MeshStandardMaterial({
      color: 0xdfe8f2, roughness: 0.26, metalness: 0.1,
      emissive: new THREE.Color(0xfff2d8), emissiveIntensity: 0.15,
    });
    this.taillightMat = new THREE.MeshStandardMaterial({
      color: 0x3a0508, roughness: 0.20, metalness: 0.1,
      emissive: new THREE.Color(0xff1a22), emissiveIntensity: 0.5,
    });
    this.reverseMat = new THREE.MeshStandardMaterial({
      color: 0xe8eef4, roughness: 0.2, emissive: new THREE.Color(0xffffff), emissiveIntensity: 0,
    });
  }

  /** Racing stripes injected into the paint shader, masked on object-space X/Y. */
  _installStripes(mat) {
    const mode = this.build.stripe || 'none';
    const uniforms = {
      uStripeColour: { value: new THREE.Color(this.build.stripeColour || '#f2f4f8') },
      uStripeMode: { value: mode === 'dual' ? 1 : mode === 'centre' ? 2 : 0 },
      uHalfWidth: { value: this.car.body.width / 2 },
      uBeltline: { value: this.profile.beltline },
    };
    mat.userData.stripeUniforms = uniforms;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vLocalPos;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLocalPos = position;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
varying vec3 vLocalPos;
uniform vec3 uStripeColour;
uniform int uStripeMode;
uniform float uHalfWidth;
uniform float uBeltline;`)
        .replace('#include <color_fragment>', `#include <color_fragment>
{
  float ax = abs(vLocalPos.x) / max(uHalfWidth, 0.001);
  float m = 0.0;
  if (uStripeMode == 1) {
    m = smoothstep(0.34, 0.30, ax) * smoothstep(0.08, 0.12, ax);
  } else if (uStripeMode == 2) {
    m = smoothstep(0.15, 0.11, ax);
  }
  m *= smoothstep(uBeltline * 0.34, uBeltline * 0.62, vLocalPos.y);
  diffuseColor.rgb = mix(diffuseColor.rgb, uStripeColour, clamp(m, 0.0, 1.0));
}`);
    };
    mat.customProgramCacheKey = () => `stripe${uniforms.uStripeMode.value}`;
  }

  /* ── body ── */

  _buildBody() {
    const geo = loftClosed(this.profile.body, RADIAL);
    this.bodyGeometry = geo;
    this._basePositions = Float32Array.from(geo.attributes.position.array);
    this.bodyMesh = new THREE.Mesh(geo, this.paint);
    this.bodyMesh.castShadow = true;
    this.bodyMesh.receiveShadow = true;
    this.shell.add(this.bodyMesh);
  }

  _buildGreenhouse() {
    const geo = loftCabin(this.profile.cabin, this.profile.roofRange, CABIN_SEG);
    this.cabinMesh = new THREE.Mesh(geo, [this.paint, this.glass]);
    this.cabinMesh.castShadow = true;
    this.cabinMesh.renderOrder = 1;
    this.shell.add(this.cabinMesh);

    // Opaque inner skin behind the ROOF and PILLARS only — keeping it out of the
    // glazed groups is what lets the cockpit camera see out of the windscreen.
    const inner = loftCabin(
      this.profile.cabin.map((s) => ({ ...s, halfW: s.halfW * 0.93, yTop: s.yBot + (s.yTop - s.yBot) * 0.93 })),
      this.profile.roofRange, CABIN_SEG,
    );
    const innerMesh = new THREE.Mesh(inner, [this.headliner, this.glazingHole]);
    this.shell.add(innerMesh);
  }

  /* ── exterior details ── */

  _buildDetails() {
    const b = this.car.body;
    const p = this.profile;
    const hw = b.width / 2, hl = b.length / 2;
    const dark = [], chromeParts = [], paintParts = [];

    // front splitter, sized to the nose it hangs off
    const noseZ = hl * 0.94;
    const noseHW = p.halfWidthAt(noseZ);
    if (p.splitter > 0) {
      const sp = new THREE.BoxGeometry(noseHW * 2.02, 0.05, 0.26 + p.splitter * 0.8);
      sp.translate(0, p.bottomAt(noseZ) + 0.02, noseZ + 0.02);
      dark.push(sp);
    }

    // rear diffuser
    const tailZ = -hl * 0.90;
    const tailHW = p.halfWidthAt(tailZ);
    const diff = new THREE.BoxGeometry(tailHW * 1.72, 0.16, 0.5);
    diff.translate(0, p.bottomAt(tailZ) + 0.07, tailZ - 0.02);
    dark.push(diff);
    for (let i = -2; i <= 2; i++) {
      const fin = new THREE.BoxGeometry(0.045, 0.20, 0.5);
      fin.translate(i * tailHW * 0.34, p.bottomAt(tailZ) + 0.09, tailZ - 0.02);
      dark.push(fin);
    }

    // grille, recessed into the nose
    const grille = new THREE.BoxGeometry(noseHW * 1.24, 0.20, 0.12);
    grille.translate(0, p.bottomAt(noseZ) + 0.26, hl * 0.965);
    dark.push(grille);

    // side skirts, hugging the sill line
    for (const s of [1, -1]) {
      const skirt = new THREE.BoxGeometry(0.09, 0.13, b.wheelbase * 0.70);
      skirt.translate(s * (p.halfWidthAt(0) - 0.03), p.bottomAt(0) + 0.05, 0);
      dark.push(skirt);
    }

    // wheel arch lips, proud of the body surface
    for (const zc of [b.wheelbase / 2, -b.wheelbase / 2]) {
      const bw = p.halfWidthAt(zc);
      for (const s of [1, -1]) {
        const arch = new THREE.TorusGeometry(b.wheelRadius * 1.20, 0.05, 6, 20, Math.PI);
        arch.rotateY(Math.PI / 2);
        arch.translate(s * (bw + 0.012), b.wheelRadius * 0.98, zc);
        dark.push(arch);
      }
    }

    // mirrors on the beltline, just behind the cowl
    const mirrorZ = p.cowlZ - 0.10;
    const mirrorHW = p.halfWidthAt(mirrorZ);
    for (const s of [1, -1]) {
      const stalk = new THREE.BoxGeometry(0.17, 0.035, 0.05);
      stalk.translate(s * (mirrorHW + 0.06), p.topAt(mirrorZ) - 0.04, mirrorZ);
      dark.push(stalk);
      const cap = new THREE.BoxGeometry(0.11, 0.10, 0.17);
      cap.translate(s * (mirrorHW + 0.16), p.topAt(mirrorZ) - 0.01, mirrorZ);
      paintParts.push(cap);
    }

    // exhaust tips
    const exZ = -hl * 0.985;
    const exY = p.bottomAt(exZ) + 0.14;
    const exOffsets = p.exhaustCount === 1 ? [0] : [-tailHW * 0.55, tailHW * 0.55];
    for (const ox of exOffsets) {
      const tip = new THREE.CylinderGeometry(0.055, 0.062, 0.18, 12);
      tip.rotateX(Math.PI / 2);
      tip.translate(ox, exY, exZ);
      chromeParts.push(tip);
    }

    // rear wing, standing off the deck it is bolted to
    const wingSize = b.wingSize ?? 0.3;
    if (wingSize > 0.12) {
      const wz = p.wingZ * hl;
      const deckY = p.roofSpoiler ? Math.max(p.topAt(wz), p.cabinTopAt(wz)) : p.topAt(wz);
      const standH = p.roofSpoiler ? 0.06 : 0.14 + wingSize * 0.38;
      const wingY = deckY + standH + 0.03;
      const span = p.halfWidthAt(wz) * 2 * (0.94 + wingSize * 0.10);
      const chord = 0.16 + wingSize * 0.26;
      const wing = new THREE.BoxGeometry(span, 0.04, chord);
      wing.translate(0, wingY, wz);
      paintParts.push(wing);
      const gurney = new THREE.BoxGeometry(span, 0.05, 0.02);
      gurney.translate(0, wingY + 0.04, wz - chord / 2);
      dark.push(gurney);
      for (const s of [1, -1]) {
        const end = new THREE.BoxGeometry(0.03, 0.14 + wingSize * 0.12, chord * 1.15);
        end.translate(s * span * 0.5, wingY, wz);
        dark.push(end);
        const stand = new THREE.BoxGeometry(0.05, standH, chord * 0.45);
        stand.translate(s * span * 0.30, deckY + standH / 2, wz);
        dark.push(stand);
      }
    }

    // bonnet vents
    if (p.hasIntakes) {
      const vz = (p.cowlZ + noseZ) * 0.5;
      for (const s of [1, -1]) {
        const v = new THREE.BoxGeometry(0.22, 0.05, 0.42);
        v.translate(s * p.halfWidthAt(vz) * 0.48, p.topAt(vz) - 0.02, vz);
        dark.push(v);
      }
    }
    if (p.roofRack) {
      for (const s of [1, -1]) {
        const rz = (p.cowlZ + p.cabinRearZ) * 0.5;
        const rail = new THREE.BoxGeometry(0.05, 0.06, b.length * 0.40);
        rail.translate(s * p.halfWidthAt(rz) * 0.60, p.roofY + 0.04, rz);
        dark.push(rail);
      }
    }
    if (p.cage) {
      const cz = (p.cowlZ + p.cabinRearZ) * 0.5;
      for (const s of [1, -1]) {
        const bar = new THREE.CylinderGeometry(0.028, 0.028, 0.85, 6);
        bar.rotateZ(s * 0.26);
        bar.translate(s * p.halfWidthAt(cz) * 0.58, p.beltline + 0.24, cz - 0.1);
        dark.push(bar);
      }
      const hoopR = Math.max(0.35, p.cabinTopAt(cz) - p.beltline - 0.06);
      const hoop = new THREE.TorusGeometry(hoopR, 0.028, 6, 16, Math.PI);
      hoop.rotateY(Math.PI / 2);
      hoop.translate(0, p.beltline, cz - 0.1);
      dark.push(hoop);
    }
    const push = (parts, mat, cast = true) => {
      if (!parts.length) return null;
      const m = new THREE.Mesh(mergeGeometries(parts, false), mat);
      m.castShadow = cast; m.receiveShadow = true;
      this.shell.add(m);
      parts.forEach((g) => g.dispose());
      return m;
    };
    push(dark, this.darkPlastic);
    push(chromeParts, this.chrome);
    push(paintParts, this.paint);

    // underbody tray, tucked inside the sills
    const tray = new THREE.Mesh(
      new THREE.BoxGeometry(p.halfWidthAt(0) * 1.62, 0.04, b.wheelbase * 1.02),
      this.darkPlastic,
    );
    tray.position.set(0, p.bottomAt(0) + 0.01, 0);
    this.shell.add(tray);
  }

  /* ── interior ── */

  _buildInterior() {
    const b = this.car.body;
    const p = this.profile;
    const g = this.car.grid;
    const parts = [];

    const belt = p.beltline;
    const dashZ = p.cowlZ - 0.24;
    const seatZ = g.seatZ;

    const floor = new THREE.BoxGeometry(b.width * 0.74, 0.05, b.wheelbase * 0.72);
    floor.translate(0, belt - 0.44, -0.05);
    parts.push(floor);

    // dashboard sits behind the cowl, topping out at the beltline
    const dash = new THREE.BoxGeometry(p.halfWidthAt(dashZ) * 1.52, 0.20, 0.30);
    dash.translate(0, belt - 0.13, dashZ);
    parts.push(dash);
    const centre = new THREE.BoxGeometry(0.24, 0.22, 0.66);
    centre.translate(0, belt - 0.26, dashZ - 0.44);
    parts.push(centre);

    // seats: driver on +X, which is the car's left in this basis
    for (const s of [1, -1]) {
      const base = new THREE.BoxGeometry(0.44, 0.12, 0.48);
      base.translate(s * g.seatX, belt - 0.34, seatZ);
      parts.push(base);
      const back = new THREE.BoxGeometry(0.44, 0.52, 0.14);
      back.rotateX(-0.16);
      back.translate(s * g.seatX, belt - 0.06, seatZ - 0.26);
      parts.push(back);
      const head = new THREE.BoxGeometry(0.24, 0.17, 0.12);
      head.translate(s * g.seatX, belt + 0.19, seatZ - 0.32);
      parts.push(head);
    }

    const interior = new THREE.Mesh(mergeGeometries(parts, false), this.seatMat);
    interior.castShadow = false;
    this.shell.add(interior);
    parts.forEach((x) => x.dispose());

    // steering wheel
    this.steeringWheel = new THREE.Group();
    const rimW = new THREE.Mesh(new THREE.TorusGeometry(0.165, 0.022, 8, 24), this.darkPlastic);
    this.steeringWheel.add(rimW);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * TAU;
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.15, 0.018), this.darkPlastic);
      spoke.position.set(Math.sin(a) * 0.075, -Math.cos(a) * 0.075, 0);
      spoke.rotation.z = -a;
      this.steeringWheel.add(spoke);
    }
    const boss = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.04, 12), this.trim);
    boss.rotation.x = Math.PI / 2;
    this.steeringWheel.add(boss);
    this.steeringWheel.position.set(g.seatX, belt - 0.06, dashZ - 0.22);
    this.steeringWheel.rotation.x = -0.36;
    this.shell.add(this.steeringWheel);

    // camera anchors — eye height sits above the beltline so the view clears the
    // bonnet, and the hood cam sits at the base of the windscreen looking out
    this.cockpitAnchor = new THREE.Object3D();
    this.cockpitAnchor.position.set(g.seatX * 0.85, belt + 0.30, seatZ + 0.22);
    this.shell.add(this.cockpitAnchor);

    this.hoodAnchor = new THREE.Object3D();
    const hz = p.cowlZ + 0.05;
    this.hoodAnchor.position.set(0, p.topAt(hz) + 0.16, hz);
    this.shell.add(this.hoodAnchor);

    this.bumperAnchor = new THREE.Object3D();
    this.bumperAnchor.position.set(0, p.bottomAt(p.noseZ * 0.90) + 0.36, p.noseZ * 0.92);
    this.shell.add(this.bumperAnchor);
  }

  /* ── lights ── */

  _buildLights() {
    const b = this.car.body;
    const p = this.profile;
    const hl = b.length / 2;

    const heads = [], tails = [], reverses = [];
    const hz = hl * 0.955;
    const hHW = p.halfWidthAt(hz);
    const hY = (p.topAt(hz) + p.bottomAt(hz)) * 0.5 + 0.14;
    for (const s of [1, -1]) {
      const h = new THREE.BoxGeometry(hHW * 0.62, 0.11, 0.10);
      h.translate(s * hHW * 0.58, hY, hz);
      heads.push(h);
      const drl = new THREE.BoxGeometry(hHW * 0.55, 0.035, 0.06);
      drl.translate(s * hHW * 0.58, hY - 0.10, hz + 0.01);
      heads.push(drl);
    }

    const tz = -hl * 0.965;
    const tHW = p.halfWidthAt(tz);
    const tY = (p.topAt(tz) + p.bottomAt(tz)) * 0.5 + 0.16;
    const tailBar = new THREE.BoxGeometry(tHW * 1.52, 0.075, 0.06);
    tailBar.translate(0, tY, tz);
    tails.push(tailBar);
    for (const s of [1, -1]) {
      const t = new THREE.BoxGeometry(tHW * 0.56, 0.13, 0.07);
      t.translate(s * tHW * 0.66, tY, tz);
      tails.push(t);
      const rv = new THREE.BoxGeometry(0.10, 0.06, 0.05);
      rv.translate(s * tHW * 0.30, tY - 0.15, tz);
      reverses.push(rv);
    }

    this.headlightMesh = new THREE.Mesh(mergeGeometries(heads, false), this.headlightMat);
    this.taillightMesh = new THREE.Mesh(mergeGeometries(tails, false), this.taillightMat);
    this.reverseMesh = new THREE.Mesh(mergeGeometries(reverses, false), this.reverseMat);
    this.shell.add(this.headlightMesh, this.taillightMesh, this.reverseMesh);
    [...heads, ...tails, ...reverses].forEach((g) => g.dispose());

    this.headlightAnchors = [
      new THREE.Vector3(hHW * 0.58, hY, hz),
      new THREE.Vector3(-hHW * 0.58, hY, hz),
    ];
  }

  /** Optional real headlight beams — only worth the cost for the player car. */
  attachHeadlightBeams() {
    if (this.beams) return;
    this.beams = [];
    for (const a of this.headlightAnchors) {
      const spot = new THREE.SpotLight(0xfff0d6, 0, 260, 0.46, 0.72, 1.7);
      spot.position.copy(a);
      // aim well down the road so the pool lands ~25 m out, not at the bumper
      spot.target.position.set(a.x * 0.40, a.y - 1.1, a.z + 78);
      this.shell.add(spot);
      this.shell.add(spot.target);
      this.beams.push(spot);
    }
  }

  detachHeadlightBeams() {
    if (!this.beams) return;
    for (const s of this.beams) { this.shell.remove(s.target); this.shell.remove(s); s.dispose(); }
    this.beams = null;
  }

  /* ── wheels ── */

  _buildWheels() {
    const b = this.car.body;
    const tyre = tyreGeometry(b.wheelRadius, b.wheelWidth);
    const rim = rimGeometry(this.build.wheelStyle | 0, b.wheelRadius, b.wheelWidth);

    const discGeo = new THREE.CylinderGeometry(b.wheelRadius * 0.62, b.wheelRadius * 0.62, b.wheelWidth * 0.16, 20);
    discGeo.rotateZ(Math.PI / 2);
    const caliperGeo = new THREE.BoxGeometry(b.wheelWidth * 0.26, b.wheelRadius * 0.44, b.wheelRadius * 0.22);

    this.wheels = [];
    this.brakeDiscs = [];
    for (let i = 0; i < 4; i++) {
      const g = new THREE.Group();
      const isLeft = i % 2 === 0;

      const t = new THREE.Mesh(tyre, this.tyreMat);
      t.castShadow = true;
      g.add(t);

      const r = new THREE.Mesh(rim, this.rimMat);
      r.castShadow = true;
      if (!isLeft) r.scale.x = -1;   // mirror so the dish faces outward on both sides
      g.add(r);

      const d = new THREE.Mesh(discGeo, this.discMat);
      d.scale.x = 0.9;
      g.add(d);
      this.brakeDiscs.push(d);

      // caliper stays upright with the hub rather than spinning with the wheel
      const cal = new THREE.Mesh(caliperGeo, this.caliperMat);
      cal.position.set((isLeft ? -1 : 1) * b.wheelWidth * 0.16, 0, -b.wheelRadius * 0.52);
      const hub = new THREE.Group();
      hub.add(cal);

      const wrap = new THREE.Group();
      wrap.add(g);
      wrap.add(hub);
      wrap.userData.spin = g;
      wrap.userData.hub = hub;

      this.group.add(wrap);
      this.wheels.push(wrap);
    }
  }

  /* ── per-frame ── */

  /**
   * @param {Vehicle} v
   */
  update(v, dt, nightFactor = 0) {
    this.chassis.position.copy(v.position);
    this.chassis.quaternion.copy(v.quaternion);

    for (let i = 0; i < 4; i++) {
      const ws = v.wheelState[i];
      const wrap = this.wheels[i];
      wrap.position.copy(ws.position);
      wrap.userData.spin.quaternion.copy(ws.quaternion);
      // hub keeps the wheel's steer/lean but not its spin
      wrap.userData.hub.quaternion.copy(v.quaternion);
    }

    const t = v.telemetry;

    // brake lights + disc glow
    const braking = t.brake > 0.05 || (t.gear >= 0 && v.controls.brake > 0.05);
    this.taillightMat.emissiveIntensity = braking ? 4.2 : (this.headlightsOn ? 1.5 : 0.35 + nightFactor * 0.4);
    this.reverseMat.emissiveIntensity = t.gear < 0 ? 3.0 : 0;

    const targetGlow = clamp01((t.brake * Math.min(t.speedKmh / 130, 1)) * 1.4);
    this.brakeGlow = this.brakeGlow + (targetGlow - this.brakeGlow) * Math.min(1, dt * (targetGlow > this.brakeGlow ? 2.2 : 0.55));
    this.discMat.emissiveIntensity = this.brakeGlow * 1.8;

    // headlights
    const wantLights = this.headlightsOn || nightFactor > 0.45;
    this.headlightMat.emissiveIntensity = wantLights ? 1.6 : 0.12;
    if (this.beams) {
      const target = wantLights ? 900 : 0;
      for (const s of this.beams) s.intensity += (target - s.intensity) * Math.min(1, dt * 6);
      for (const s of this.beams) s.visible = s.intensity > 1;
    }

    if (this.steeringWheel) this.steeringWheel.rotation.z = -t.steer * 2.4;
  }

  /** Push body panels inward around an impact point. */
  applyDent(worldPoint, strength) {
    if (!this.bodyGeometry) return;
    const local = this.shell.worldToLocal(worldPoint.clone());
    const pos = this.bodyGeometry.attributes.position;
    const arr = pos.array;
    const radius = 0.55 + strength * 0.9;
    const depth = clamp(strength * 0.16, 0.01, 0.16);
    let touched = false;
    for (let i = 0; i < pos.count; i++) {
      const bx = this._basePositions[i * 3], by = this._basePositions[i * 3 + 1], bz = this._basePositions[i * 3 + 2];
      const d = Math.hypot(arr[i * 3] - local.x, arr[i * 3 + 1] - local.y, arr[i * 3 + 2] - local.z);
      if (d > radius) continue;
      const f = Math.pow(1 - d / radius, 2) * depth;
      const dirX = (local.x - arr[i * 3]) / (d || 1);
      const dirY = (local.y - arr[i * 3 + 1]) / (d || 1);
      const dirZ = (local.z - arr[i * 3 + 2]) / (d || 1);
      let nx = arr[i * 3] + dirX * f;
      let ny = arr[i * 3 + 1] + dirY * f;
      let nz = arr[i * 3 + 2] + dirZ * f;
      // never let a panel collapse more than 22 cm from where it started
      const ddx = nx - bx, ddy = ny - by, ddz = nz - bz;
      const dd = Math.hypot(ddx, ddy, ddz);
      if (dd > 0.22) { const k = 0.22 / dd; nx = bx + ddx * k; ny = by + ddy * k; nz = bz + ddz * k; }
      arr[i * 3] = nx; arr[i * 3 + 1] = ny; arr[i * 3 + 2] = nz;
      touched = true;
    }
    if (touched) {
      pos.needsUpdate = true;
      this.bodyGeometry.computeVertexNormals();
    }
  }

  resetDamage() {
    if (!this.bodyGeometry) return;
    this.bodyGeometry.attributes.position.array.set(this._basePositions);
    this.bodyGeometry.attributes.position.needsUpdate = true;
    this.bodyGeometry.computeVertexNormals();
  }

  setPaint(colour, finish, stripe, stripeColour) {
    this.build.paint = colour;
    this.build.finish = finish;
    this.build.stripe = stripe;
    this.build.stripeColour = stripeColour;
    this.paint.color.set(colour);
    const u = this.paint.userData.stripeUniforms;
    u.uStripeColour.value.set(stripeColour);
    const mode = stripe === 'dual' ? 1 : stripe === 'centre' ? 2 : 0;
    if (u.uStripeMode.value !== mode) {
      u.uStripeMode.value = mode;
      this.paint.needsUpdate = true;
    }
    if (finish === 'metallic') {
      this.paint.metalness = 0.72; this.paint.roughness = 0.30; this.paint.clearcoat = 1; this.paint.clearcoatRoughness = 0.06;
      this.paint.normalMap = this.lib.flakeNormal; this.paint.iridescence = 0;
    } else if (finish === 'matte') {
      this.paint.metalness = 0.02; this.paint.roughness = 0.68; this.paint.clearcoat = 0.16; this.paint.clearcoatRoughness = 0.5;
      this.paint.normalMap = null; this.paint.iridescence = 0;
    } else if (finish === 'pearl') {
      this.paint.metalness = 0.30; this.paint.roughness = 0.20; this.paint.clearcoat = 1; this.paint.clearcoatRoughness = 0.02;
      this.paint.normalMap = null; this.paint.iridescence = 0.55;
    } else {
      this.paint.metalness = 0.05; this.paint.roughness = 0.28; this.paint.clearcoat = 1; this.paint.clearcoatRoughness = 0.045;
      this.paint.normalMap = null; this.paint.iridescence = 0;
    }
    this.paint.needsUpdate = true;
  }

  setWheels(style, rimColour, caliperColour) {
    this.rimMat.color.set(rimColour);
    this.caliperMat.color.set(caliperColour);
    if ((this.build.wheelStyle | 0) !== (style | 0)) {
      this.build.wheelStyle = style | 0;
      const b = this.car.body;
      const geo = rimGeometry(style | 0, b.wheelRadius, b.wheelWidth);
      for (const wrap of this.wheels) {
        const spin = wrap.userData.spin;
        const rim = spin.children[1];
        rim.geometry.dispose();
        rim.geometry = geo;
      }
    }
  }

  setVisible(v) { this.group.visible = v; }

  dispose() {
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
    });
    for (const m of [this.paint, this.trim, this.darkPlastic, this.chrome, this.glass,
      this.interiorMat, this.headliner, this.glazingHole, this.seatMat, this.rimMat,
      this.tyreMat, this.caliperMat, this.discMat, this.headlightMat, this.taillightMat,
      this.reverseMat]) m.dispose();
    this.detachHeadlightBeams();
  }
}
