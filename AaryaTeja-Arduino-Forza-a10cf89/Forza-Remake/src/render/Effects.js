import * as THREE from 'three';
import { clamp01, lerp, makeRng } from '../core/MathUtils.js';

/* ═══════════════════════════ skid marks ═══════════════════════════ */

const SKID_SEGMENTS = 1100;
const GAP_SEGMENTS = 10;

/**
 * Ring-buffered tyre-mark ribbon. Each contact patch that is sliding extends its
 * own strip; the oldest segments are recycled and a short gap is punched ahead of
 * the write head so the tail visibly ends instead of forming a loop.
 */
export class SkidMarks {
  constructor(material) {
    this.max = SKID_SEGMENTS;
    const verts = this.max * 4;
    this.positions = new Float32Array(verts * 3);
    this.colors = new Float32Array(verts * 4);
    this.uvs = new Float32Array(verts * 2);
    const idx = new Uint32Array(this.max * 6);
    for (let i = 0; i < this.max; i++) {
      const b = i * 4;
      idx[i * 6] = b; idx[i * 6 + 1] = b + 1; idx[i * 6 + 2] = b + 2;
      idx[i * 6 + 3] = b; idx[i * 6 + 4] = b + 2; idx[i * 6 + 5] = b + 3;
      this.uvs[b * 2 + 0] = 0; this.uvs[b * 2 + 1] = 0;
      this.uvs[b * 2 + 2] = 1; this.uvs[b * 2 + 3] = 0;
      this.uvs[b * 2 + 4] = 1; this.uvs[b * 2 + 5] = 1;
      this.uvs[b * 2 + 6] = 0; this.uvs[b * 2 + 7] = 1;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 4));
    geo.setAttribute('uv', new THREE.BufferAttribute(this.uvs, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.setDrawRange(0, 0);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 5000);

    this.material = material.clone();
    this.material.vertexColors = true;
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.name = 'skidmarks';
    this.geo = geo;
    this.head = 0;
    this.used = 0;
    this._prev = new Map();     // key -> {point, side}
    this._dirty = false;
    this.enabled = true;
  }

  /** @param {THREE.Vector3} point contact patch centre */
  addPoint(key, point, sideVec, width, strength, up) {
    if (!this.enabled) return;
    const prev = this._prev.get(key);
    const cur = {
      x: point.x, y: point.y + 0.022, z: point.z,
      sx: sideVec.x, sy: sideVec.y, sz: sideVec.z,
      s: strength,
    };
    if (prev) {
      const d = Math.hypot(cur.x - prev.x, cur.y - prev.y, cur.z - prev.z);
      if (d < 0.14) return;
      if (d < 6) this._pushQuad(prev, cur, width);
    }
    this._prev.set(key, cur);
  }

  breakStrip(key) { this._prev.delete(key); }

  _pushQuad(a, b, width) {
    const i = this.head;
    const base = i * 4;
    const hw = width * 0.5;
    const p = this.positions, c = this.colors;

    p[base * 3 + 0] = a.x + a.sx * hw; p[base * 3 + 1] = a.y + a.sy * hw; p[base * 3 + 2] = a.z + a.sz * hw;
    p[base * 3 + 3] = a.x - a.sx * hw; p[base * 3 + 4] = a.y - a.sy * hw; p[base * 3 + 5] = a.z - a.sz * hw;
    p[base * 3 + 6] = b.x - b.sx * hw; p[base * 3 + 7] = b.y - b.sy * hw; p[base * 3 + 8] = b.z - b.sz * hw;
    p[base * 3 + 9] = b.x + b.sx * hw; p[base * 3 + 10] = b.y + b.sy * hw; p[base * 3 + 11] = b.z + b.sz * hw;

    const aA = clamp01(a.s) * 0.85, aB = clamp01(b.s) * 0.85;
    for (let k = 0; k < 4; k++) {
      const alpha = k < 2 ? aA : aB;
      c[(base + k) * 4 + 0] = 0.09;
      c[(base + k) * 4 + 1] = 0.085;
      c[(base + k) * 4 + 2] = 0.085;
      c[(base + k) * 4 + 3] = alpha;
    }

    // punch a gap ahead of the write head so the oldest tail is visibly cut
    for (let g = 1; g <= GAP_SEGMENTS; g++) {
      const j = ((i + g) % this.max) * 4;
      for (let k = 0; k < 4; k++) c[(j + k) * 4 + 3] = 0;
    }

    this.head = (this.head + 1) % this.max;
    this.used = Math.min(this.used + 1, this.max);
    this._dirty = true;
  }

  flush() {
    if (!this._dirty) return;
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
    this.geo.setDrawRange(0, this.used * 6);
    this._dirty = false;
  }

  clear() {
    this.colors.fill(0);
    this.head = 0; this.used = 0;
    this._prev.clear();
    this._dirty = true;
    this.flush();
  }
}

/* ═══════════════════════════ particles ═══════════════════════════ */

const MAX_PARTICLES = 1500;

export const PARTICLE = {
  DUST: 0,
  SMOKE: 1,
  SPRAY: 2,
  SPARK: 3,
  DEBRIS: 4,
};

const PRESETS = {
  [PARTICLE.DUST]: { colour: [0.62, 0.55, 0.42], size: [0.7, 2.4], grow: 2.6, life: [0.7, 1.5], drag: 1.6, gravity: -1.0, alpha: 0.34 },
  [PARTICLE.SMOKE]: { colour: [0.82, 0.82, 0.84], size: [0.6, 1.8], grow: 3.4, life: [0.9, 2.0], drag: 1.2, gravity: 0.5, alpha: 0.30 },
  [PARTICLE.SPRAY]: { colour: [0.78, 0.84, 0.90], size: [0.3, 1.1], grow: 2.2, life: [0.35, 0.8], drag: 2.6, gravity: -3.5, alpha: 0.26 },
  [PARTICLE.SPARK]: { colour: [1.0, 0.62, 0.18], size: [0.08, 0.20], grow: 0.2, life: [0.25, 0.6], drag: 0.6, gravity: -9.0, alpha: 1.0 },
  [PARTICLE.DEBRIS]: { colour: [0.35, 0.33, 0.30], size: [0.10, 0.26], grow: 0.4, life: [0.6, 1.3], drag: 0.8, gravity: -9.5, alpha: 0.85 },
};

export class Particles {
  constructor(smokeSprite, softSprite) {
    this.max = MAX_PARTICLES;
    this.count = 0;
    this.rng = makeRng(0x77f1);

    this.px = new Float32Array(this.max);
    this.py = new Float32Array(this.max);
    this.pz = new Float32Array(this.max);
    this.vx = new Float32Array(this.max);
    this.vy = new Float32Array(this.max);
    this.vz = new Float32Array(this.max);
    this.life = new Float32Array(this.max);
    this.maxLife = new Float32Array(this.max);
    this.size = new Float32Array(this.max);
    this.grow = new Float32Array(this.max);
    this.drag = new Float32Array(this.max);
    this.grav = new Float32Array(this.max);
    this.alpha0 = new Float32Array(this.max);
    this.type = new Uint8Array(this.max);
    this.cr = new Float32Array(this.max);
    this.cg = new Float32Array(this.max);
    this.cb = new Float32Array(this.max);

    // two draw batches: soft smoke (normal blend) and additive sparks
    this.batches = [
      this._makeBatch(smokeSprite, THREE.NormalBlending),
      this._makeBatch(softSprite, THREE.AdditiveBlending),
    ];
    this.group = new THREE.Group();
    this.group.name = 'particles';
    this.batches.forEach((b) => this.group.add(b.points));
    this.intensity = 1;
  }

  _makeBatch(sprite, blending) {
    const positions = new Float32Array(this.max * 3);
    const colors = new Float32Array(this.max * 4);
    const sizes = new Float32Array(this.max);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(colors, 4));
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geo.setDrawRange(0, 0);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 5000);

    const mat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: sprite }, uScale: { value: 620 } },
      vertexShader: /* glsl */`
        attribute vec4 aColor; attribute float aSize;
        uniform float uScale;
        varying vec4 vColor;
        void main() {
          vColor = aColor;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = max(1.0, aSize * uScale / max(-mv.z, 0.5));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D uMap;
        varying vec4 vColor;
        void main() {
          vec4 t = texture2D(uMap, gl_PointCoord);
          float a = t.a * vColor.a;
          if (a < 0.004) discard;
          gl_FragColor = vec4(vColor.rgb * t.rgb, a);
        }`,
      transparent: true,
      depthWrite: false,
      blending,
      depthTest: true,
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    points.renderOrder = 6;
    return { points, geo, positions, colors, sizes, count: 0 };
  }

  emit(type, x, y, z, vx, vy, vz, scale = 1, tint = null) {
    if (this.count >= this.max) return;
    const p = PRESETS[type];
    const i = this.count++;
    const r = this.rng;
    this.px[i] = x; this.py[i] = y; this.pz[i] = z;
    this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.maxLife[i] = lerp(p.life[0], p.life[1], r()) ;
    this.life[i] = this.maxLife[i];
    this.size[i] = lerp(p.size[0], p.size[1], r()) * scale;
    this.grow[i] = p.grow * scale;
    this.drag[i] = p.drag;
    this.grav[i] = p.gravity;
    this.alpha0[i] = p.alpha;
    this.type[i] = type;
    const c = tint || p.colour;
    const v = 0.86 + r() * 0.28;
    this.cr[i] = c[0] * v; this.cg[i] = c[1] * v; this.cb[i] = c[2] * v;
  }

  update(dt) {
    let n = this.count;
    for (let i = 0; i < n; i++) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        // swap-remove
        n--;
        if (i !== n) {
          this.px[i] = this.px[n]; this.py[i] = this.py[n]; this.pz[i] = this.pz[n];
          this.vx[i] = this.vx[n]; this.vy[i] = this.vy[n]; this.vz[i] = this.vz[n];
          this.life[i] = this.life[n]; this.maxLife[i] = this.maxLife[n];
          this.size[i] = this.size[n]; this.grow[i] = this.grow[n];
          this.drag[i] = this.drag[n]; this.grav[i] = this.grav[n];
          this.alpha0[i] = this.alpha0[n]; this.type[i] = this.type[n];
          this.cr[i] = this.cr[n]; this.cg[i] = this.cg[n]; this.cb[i] = this.cb[n];
        }
        i--;
        continue;
      }
      const k = Math.exp(-this.drag[i] * dt);
      this.vx[i] *= k; this.vz[i] *= k;
      this.vy[i] = this.vy[i] * k + this.grav[i] * dt;
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;
    }
    this.count = n;

    // pack into the two draw batches
    for (const b of this.batches) b.count = 0;
    for (let i = 0; i < this.count; i++) {
      const additive = this.type[i] === PARTICLE.SPARK;
      const b = this.batches[additive ? 1 : 0];
      const j = b.count++;
      b.positions[j * 3] = this.px[i];
      b.positions[j * 3 + 1] = this.py[i];
      b.positions[j * 3 + 2] = this.pz[i];
      const t = this.life[i] / this.maxLife[i];
      const age = 1 - t;
      b.sizes[j] = this.size[i] + this.grow[i] * age;
      const fade = Math.sin(Math.min(t, 1) * Math.PI * 0.5) * Math.min(1, age * 6 + 0.15);
      b.colors[j * 4] = this.cr[i];
      b.colors[j * 4 + 1] = this.cg[i];
      b.colors[j * 4 + 2] = this.cb[i];
      b.colors[j * 4 + 3] = this.alpha0[i] * fade * this.intensity;
    }
    for (const b of this.batches) {
      b.geo.setDrawRange(0, b.count);
      b.geo.attributes.position.needsUpdate = true;
      b.geo.attributes.aColor.needsUpdate = true;
      b.geo.attributes.aSize.needsUpdate = true;
    }
  }

  setPixelScale(height) {
    for (const b of this.batches) b.points.material.uniforms.uScale.value = height * 0.62;
  }

  clear() {
    this.count = 0;
    this.update(0.016);
  }
}
