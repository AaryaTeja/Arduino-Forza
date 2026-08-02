import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { clamp01, lerp, smoothstep, damp, makeRng, fbm2 } from '../core/MathUtils.js';

export const WEATHERS = {
  clear:    { label: 'Clear',    turbidity: 2.6, rayleigh: 1.35, mie: 0.006, mieG: 0.80, fog: 0.00016, sunScale: 1.00, ambient: 1.00, wetness: 0.0, rain: 0.0, cloud: 0.28, grade: 1.00 },
  overcast: { label: 'Overcast', turbidity: 11,  rayleigh: 0.55, mie: 0.022, mieG: 0.72, fog: 0.00075, sunScale: 0.30, ambient: 1.00, wetness: 0.18, rain: 0.0, cloud: 0.94, grade: 0.80 },
  rain:     { label: 'Rain',     turbidity: 15,  rayleigh: 0.40, mie: 0.030, mieG: 0.70, fog: 0.00115, sunScale: 0.16, ambient: 0.88, wetness: 1.0, rain: 1.0, cloud: 1.00, grade: 0.66 },
  fog:      { label: 'Fog',      turbidity: 8,   rayleigh: 0.85, mie: 0.045, mieG: 0.65, fog: 0.00520, sunScale: 0.42, ambient: 1.05, wetness: 0.32, rain: 0.0, cloud: 0.70, grade: 0.74 },
};

/* ── sky/fog colour palette keyed on sun elevation ── */
const SKY_KEYS = [
  { e: -18, horizon: 0x05070d, zenith: 0x020306, sun: 0x223047, amb: 0x0b1220 },
  { e: -6,  horizon: 0x1b2340, zenith: 0x080c1b, sun: 0x3b4a6b, amb: 0x161f36 },
  { e: 0,   horizon: 0xd8734a, zenith: 0x2c4470, sun: 0xff9d5c, amb: 0x4a5878 },
  { e: 6,   horizon: 0xf0a878, zenith: 0x5b86b8, sun: 0xffc089, amb: 0x8fa4c0 },
  { e: 18,  horizon: 0xcfe0ee, zenith: 0x5f9ada, sun: 0xfff0d8, amb: 0xa8c0dc },
  { e: 45,  horizon: 0xdaeaf6, zenith: 0x3f86d8, sun: 0xfffdf6, amb: 0xbcd2e8 },
  { e: 80,  horizon: 0xe4f0fa, zenith: 0x2f7ad4, sun: 0xffffff, amb: 0xc4dcf0 },
];

const asColours = (k) => ({
  horizon: new THREE.Color(k.horizon),
  zenith: new THREE.Color(k.zenith),
  sun: new THREE.Color(k.sun),
  amb: new THREE.Color(k.amb),
});

function samplePalette(elevDeg) {
  const keys = SKY_KEYS;
  if (elevDeg <= keys[0].e) return asColours(keys[0]);
  if (elevDeg >= keys[keys.length - 1].e) return asColours(keys[keys.length - 1]);
  for (let i = 1; i < keys.length; i++) {
    if (elevDeg <= keys[i].e) {
      const a = keys[i - 1], b = keys[i];
      const t = (elevDeg - a.e) / (b.e - a.e);
      return {
        horizon: new THREE.Color(a.horizon).lerp(new THREE.Color(b.horizon), t),
        zenith: new THREE.Color(a.zenith).lerp(new THREE.Color(b.zenith), t),
        sun: new THREE.Color(a.sun).lerp(new THREE.Color(b.sun), t),
        amb: new THREE.Color(a.amb).lerp(new THREE.Color(b.amb), t),
      };
    }
  }
  return asColours(keys[keys.length - 1]);
}

function cloudTexture() {
  const s = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(s, s);
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      // tile-safe fbm by blending four wrapped samples
      const u = x / s, v = y / s;
      const f = (uu, vv) => fbm2(uu * 7, vv * 7, 4) * 0.5 + 0.5;
      const a = f(u, v), b = f(u - 1, v), c = f(u, v - 1), d = f(u - 1, v - 1);
      const n = a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
      const val = clamp01((n - 0.42) * 3.0);
      const i = (y * s + x) * 4;
      img.data[i] = 255; img.data[i + 1] = 255; img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(Math.pow(val, 1.35) * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ═══════════════════════════ rain ═══════════════════════════ */

class RainSystem {
  constructor(sprite, count = 9000) {
    this.box = new THREE.Vector3(52, 34, 52);
    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.attributes.position = quad.attributes.position;
    geo.attributes.uv = quad.attributes.uv;

    const offsets = new Float32Array(count * 3);
    const rnd = new Float32Array(count * 2);
    const rng = makeRng(0x9911);
    for (let i = 0; i < count; i++) {
      offsets[i * 3] = (rng() * 2 - 1) * this.box.x;
      offsets[i * 3 + 1] = rng() * this.box.y * 2;
      offsets[i * 3 + 2] = (rng() * 2 - 1) * this.box.z;
      rnd[i * 2] = 0.75 + rng() * 0.5;      // speed multiplier
      rnd[i * 2 + 1] = 0.6 + rng() * 0.8;   // length / opacity multiplier
    }
    geo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(offsets, 3));
    geo.setAttribute('aRand', new THREE.InstancedBufferAttribute(rnd, 2));
    geo.instanceCount = count;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uCam: { value: new THREE.Vector3() },
        uBox: { value: this.box },
        uWind: { value: new THREE.Vector3(4, 0, 1.5) },
        uFall: { value: 26 },
        uOpacity: { value: 0 },
        uMap: { value: sprite },
        uTint: { value: new THREE.Color(0xcfe2f2) },
      },
      vertexShader: /* glsl */`
        attribute vec3 aOffset;
        attribute vec2 aRand;
        uniform float uTime; uniform vec3 uCam; uniform vec3 uBox;
        uniform vec3 uWind; uniform float uFall;
        varying vec2 vUv; varying float vFade;
        void main() {
          vUv = uv;
          float speed = uFall * aRand.x;
          vec3 drift = uWind * uTime;
          vec3 p = aOffset + vec3(drift.x, -speed * uTime, drift.z);
          vec3 span = uBox * 2.0;
          p = mod(p + uBox * 3.0, span) - uBox;
          vec3 world = uCam + p;

          // velocity direction defines the streak axis
          vec3 vel = normalize(vec3(uWind.x, -speed, uWind.z));
          vec3 toCam = normalize(cameraPosition - world);
          vec3 side = normalize(cross(vel, toCam));
          float len = 0.85 * aRand.y * (speed / uFall);
          float wid = 0.028;
          vec3 offset = side * (position.x * wid) + vel * (position.y * len);
          vec4 mv = modelViewMatrix * vec4(world + offset, 1.0);
          vFade = aRand.y;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D uMap; uniform float uOpacity; uniform vec3 uTint;
        varying vec2 vUv; varying float vFade;
        void main() {
          vec4 t = texture2D(uMap, vUv);
          float a = t.a * uOpacity * vFade;
          if (a < 0.01) discard;
          gl_FragColor = vec4(uTint * t.rgb, a);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 8;
    this.mesh.visible = false;
    this.mesh.name = 'rain';
  }

  update(dt, camPos, intensity, windSpeed) {
    this.material.uniforms.uTime.value += dt;
    this.material.uniforms.uCam.value.copy(camPos);
    this.material.uniforms.uOpacity.value = intensity * 0.85;
    this.material.uniforms.uWind.value.set(3 + windSpeed * 0.4, 0, 1.2);
    this.mesh.visible = intensity > 0.01;
  }
}

/* ═══════════════════════════ environment ═══════════════════════════ */

export class Environment {
  constructor(scene, renderer, materials) {
    this.scene = scene;
    this.renderer = renderer;
    this.materials = materials;

    this.timeOfDay = 13;
    this.timeScale = 0;
    this.weather = 'clear';
    this._weatherBlend = { ...WEATHERS.clear };
    this._targetWeather = WEATHERS.clear;

    // ── sky dome ──
    this.sky = new Sky();
    this.sky.scale.setScalar(2000);   // shader pins it to the far plane, so it only needs to enclose the camera
    this.sky.name = 'sky';
    scene.add(this.sky);

    this.sunDir = new THREE.Vector3(0, 1, 0);

    // ── lights ──
    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 620;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.55;
    this.setShadowExtent(150);
    scene.add(this.sun);
    scene.add(this.sun.target);

    this.hemi = new THREE.HemisphereLight(0xbcd2e8, 0x3c4535, 0.9);
    scene.add(this.hemi);

    this.fill = new THREE.DirectionalLight(0x8fb0d8, 0.35);
    this.fill.position.set(-1, 0.6, -0.6);
    scene.add(this.fill);

    scene.fog = new THREE.FogExp2(0x9fb6c9, 0.0002);
    // the sky probe is a full-brightness outdoor capture; it only needs to supply fill
    scene.environmentIntensity = 0.35;

    // ── clouds ──
    const cloudTex = cloudTexture();
    cloudTex.repeat.set(3, 3);
    this.cloudMat = new THREE.MeshBasicMaterial({
      map: cloudTex, transparent: true, depthWrite: false, opacity: 0.6,
      color: 0xffffff, fog: false, side: THREE.DoubleSide,
    });
    this.clouds = new THREE.Mesh(new THREE.PlaneGeometry(7000, 7000, 1, 1), this.cloudMat);
    this.clouds.rotation.x = -Math.PI / 2;
    this.clouds.position.y = 620;
    this.clouds.renderOrder = -1;
    this.clouds.frustumCulled = false;
    scene.add(this.clouds);

    // ── stars ──
    this.stars = this._buildStars();
    scene.add(this.stars);

    // ── rain ──
    this.rain = new RainSystem(materials.rainSprite, 9000);
    scene.add(this.rain.mesh);

    // ── PMREM for reflections ──
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.pmrem.compileEquirectangularShader();
    this._envRT = null;
    this._envDirty = true;
    this._envCooldown = 0;

    this._skyScene = new THREE.Scene();
    this._skyForEnv = new Sky();
    this._skyForEnv.scale.setScalar(2000);
    this._skyScene.add(this._skyForEnv);

    this.nightFactor = 0;
    this.wetness = 0;
    this.windSpeed = 4;
    this._cloudOffset = 0;
  }

  _buildStars() {
    const count = 2600;
    const pos = new Float32Array(count * 3);
    const size = new Float32Array(count);
    const rng = makeRng(0x2c48);
    for (let i = 0; i < count; i++) {
      let y = 0, x = 0, z = 0;
      do {
        x = rng() * 2 - 1; y = rng(); z = rng() * 2 - 1;
      } while (x * x + y * y + z * z > 1 || y < 0.02);
      const l = Math.hypot(x, y, z);
      const r = 3000;
      pos[i * 3] = (x / l) * r; pos[i * 3 + 1] = (y / l) * r; pos[i * 3 + 2] = (z / l) * r;
      size[i] = 6 + Math.pow(rng(), 6) * 42;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uOpacity: { value: 0 } },
      vertexShader: /* glsl */`
        attribute float aSize; varying float vTw;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * (300.0 / -mv.z);
          vTw = aSize / 48.0;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform float uOpacity; varying float vTw;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float a = smoothstep(0.5, 0.06, length(d));
          gl_FragColor = vec4(vec3(1.0, 0.98, 0.94), a * uOpacity * (0.4 + vTw));
        }`,
      transparent: true, depthWrite: false, depthTest: false, fog: false,
      blending: THREE.AdditiveBlending,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    pts.renderOrder = -2;
    pts.name = 'stars';
    return pts;
  }

  setShadowExtent(extent) {
    const c = this.sun.shadow.camera;
    c.left = -extent; c.right = extent; c.top = extent; c.bottom = -extent;
    c.updateProjectionMatrix();
  }

  setShadowMapSize(size) {
    if (this.sun.shadow.mapSize.x === size) return;
    this.sun.shadow.mapSize.set(size, size);
    if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
  }

  setWeather(name, immediate = false) {
    this.weather = name;
    this._targetWeather = WEATHERS[name] || WEATHERS.clear;
    if (immediate) {
      for (const k of Object.keys(this._targetWeather)) {
        if (typeof this._targetWeather[k] === 'number') this._weatherBlend[k] = this._targetWeather[k];
      }
      this._envDirty = true;
    }
  }

  setTimeOfDay(h, immediate = false) {
    this.timeOfDay = ((h % 24) + 24) % 24;
    if (immediate) this._envDirty = true;
  }

  /** Sun elevation in degrees for the current time of day. */
  get sunElevation() {
    const t = this.timeOfDay;
    return 72 * Math.sin(((t - 6) / 12) * Math.PI);
  }

  get sunAzimuth() {
    return -90 + 180 * ((this.timeOfDay - 6) / 12);
  }

  update(dt, cameraPos) {
    // advance clock
    if (this.timeScale > 0) {
      this.timeOfDay = (this.timeOfDay + (dt * this.timeScale) / 60) % 24;
      this._envCooldown -= dt;
      if (this._envCooldown <= 0) { this._envDirty = true; this._envCooldown = 2.5; }
    }

    // blend weather parameters
    const tw = this._targetWeather;
    let moved = false;
    for (const k of Object.keys(tw)) {
      if (typeof tw[k] !== 'number') continue;
      const prev = this._weatherBlend[k];
      const next = damp(prev, tw[k], 1.1, dt);
      if (Math.abs(next - prev) > 1e-6) moved = true;
      this._weatherBlend[k] = next;
    }
    if (moved) this._envDirty = true;
    const w = this._weatherBlend;

    // sun direction
    const elev = this.sunElevation;
    const phi = THREE.MathUtils.degToRad(90 - elev);
    const theta = THREE.MathUtils.degToRad(this.sunAzimuth);
    this.sunDir.setFromSphericalCoords(1, phi, theta);

    const pal = samplePalette(elev);
    const dayT = clamp01(smoothstep(-5, 8, elev));
    this.nightFactor = 1 - dayT;

    // sky shader
    const u = this.sky.material.uniforms;
    u.turbidity.value = w.turbidity;
    u.rayleigh.value = w.rayleigh;
    u.mieCoefficient.value = w.mie;
    u.mieDirectionalG.value = w.mieG;
    u.sunPosition.value.copy(this.sunDir);   // Sky expects a unit direction

    // sun light
    const sunUp = clamp01(smoothstep(-4, 12, elev));
    const intensity = (0.18 + 3.5 * Math.pow(sunUp, 0.72)) * w.sunScale;
    this.sun.color.copy(pal.sun);
    this.sun.intensity = intensity;
    this.sun.position.copy(this.sunDir).multiplyScalar(320);

    // moonlight after dark
    const moon = this.nightFactor;
    this.fill.color.setHex(0x7f9dd0);
    this.fill.intensity = 0.10 + moon * 0.62;
    this.fill.position.set(-this.sunDir.x, Math.abs(this.sunDir.y) * 0.7 + 0.35, -this.sunDir.z).multiplyScalar(200);

    this.hemi.color.copy(pal.amb);
    this.hemi.groundColor.setHex(0x2f3a2a).lerp(new THREE.Color(0x0a0e14), moon);
    this.hemi.intensity = (0.20 + 1.05 * Math.pow(sunUp, 0.5)) * w.ambient + moon * 0.34;

    // fog
    // bad weather should read as a darker, denser grey — not a brighter haze
    const fogCol = pal.horizon.clone().lerp(new THREE.Color(0x6b7883), clamp01((1 - w.grade) * 1.9));
    this.scene.fog.color.copy(fogCol);
    this.scene.fog.density = w.fog + moon * 0.00012;

    // clouds
    this._cloudOffset += dt * (0.0016 + this.windSpeed * 0.00012);
    this.cloudMat.map.offset.set(this._cloudOffset, this._cloudOffset * 0.42);
    this.cloudMat.opacity = w.cloud * (0.30 + dayT * 0.5);
    this.cloudMat.color.copy(pal.horizon).lerp(new THREE.Color(0xffffff), dayT * 0.55);
    this.clouds.visible = this.cloudMat.opacity > 0.02;
    if (cameraPos) this.clouds.position.set(cameraPos.x, 620, cameraPos.z);

    // stars
    this.stars.material.uniforms.uOpacity.value = clamp01(moon * 1.25 - w.cloud * 0.55);
    this.stars.visible = this.stars.material.uniforms.uOpacity.value > 0.01;
    if (cameraPos) { this.stars.position.copy(cameraPos); this.sky.position.copy(cameraPos); }

    // rain
    this.rain.update(dt, cameraPos || new THREE.Vector3(), w.rain, this.windSpeed);

    // surface wetness
    this.wetness = damp(this.wetness, w.wetness, 0.7, dt);
    this.materials.setWetness(this.wetness);
    this.materials.setNightFactor(clamp01(this.nightFactor * 1.15));
    this.materials.water.color.copy(pal.zenith).multiplyScalar(0.35);

    // shadows follow the camera
    if (cameraPos) {
      this.sun.target.position.set(cameraPos.x, cameraPos.y - 4, cameraPos.z);
      this.sun.position.set(
        cameraPos.x + this.sunDir.x * 300,
        cameraPos.y + Math.max(this.sunDir.y, 0.25) * 300,
        cameraPos.z + this.sunDir.z * 300,
      );
      this.sun.target.updateMatrixWorld();
    }
    this.sun.visible = intensity > 0.02;

    // a camera would stop down under a bright overcast sky; grade encodes that
    this.exposure = 0.5 * lerp(1.0, w.grade, 0.85) * lerp(1.0, 1.5, moon * 0.55);

    if (this._envDirty) this._refreshEnvironment();
  }

  _refreshEnvironment() {
    this._envDirty = false;
    const src = this.sky.material.uniforms;
    const dst = this._skyForEnv.material.uniforms;
    dst.turbidity.value = src.turbidity.value;
    dst.rayleigh.value = src.rayleigh.value;
    dst.mieCoefficient.value = src.mieCoefficient.value;
    dst.mieDirectionalG.value = src.mieDirectionalG.value;
    dst.sunPosition.value.copy(src.sunPosition.value);

    const rt = this.pmrem.fromScene(this._skyScene, 0.04);
    if (this._envRT) this._envRT.dispose();
    this._envRT = rt;
    this.scene.environment = rt.texture;
    this.materials.setEnvironment(rt.texture);
  }

  dispose() {
    if (this._envRT) this._envRT.dispose();
    this.pmrem.dispose();
  }
}
