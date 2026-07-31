import * as THREE from 'three';
import { makeRng, clamp01, lerp } from '../core/MathUtils.js';

/**
 * Every texture in the game is generated procedurally on a 2D canvas at boot.
 * No binary assets, and everything stays crisp at any resolution.
 */

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function toTexture(cv, { repeat = [1, 1], wrapS = THREE.RepeatWrapping, wrapT = THREE.RepeatWrapping, srgb = false, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = wrapS; t.wrapT = wrapT;
  t.repeat.set(repeat[0], repeat[1]);
  t.anisotropy = aniso;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/** Sobel-derive a tangent-space normal map from a greyscale height canvas. */
function normalFromHeight(heightCv, strength = 2.2) {
  const w = heightCv.width, h = heightCv.height;
  const src = heightCv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const out = canvas(w, h);
  const octx = out.getContext('2d');
  const img = octx.createImageData(w, h);
  const at = (x, y) => src[(((y + h) % h) * w + ((x + w) % w)) * 4] / 255;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      let nx = -dx, ny = -dy, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      const i = (y * w + x) * 4;
      img.data[i] = (nx * 0.5 + 0.5) * 255;
      img.data[i + 1] = (ny * 0.5 + 0.5) * 255;
      img.data[i + 2] = (nz * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  return out;
}

function speckle(ctx, w, h, count, rng, minR, maxR, colorFn) {
  for (let i = 0; i < count; i++) {
    const x = rng() * w, y = rng() * h;
    const r = lerp(minR, maxR, rng() * rng());
    ctx.fillStyle = colorFn(rng());
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * Road surface. `u` (x in the canvas) runs across the full road cross-section
 * including shoulders, so lane markings are placed at fixed u fractions.
 */
export function makeRoadTextures({ size = 1024, shoulderFrac = 0.10 } = {}) {
  const rng = makeRng(0x51ce);
  const w = size, h = size;

  // ── albedo ──
  const cv = canvas(w, h);
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#2b2d31';
  ctx.fillRect(0, 0, w, h);

  // large-scale tonal variation
  for (let i = 0; i < 90; i++) {
    const g = ctx.createRadialGradient(rng() * w, rng() * h, 0, rng() * w, rng() * h, 80 + rng() * 240);
    const v = 0.5 + rng() * 0.5;
    g.addColorStop(0, `rgba(${Math.round(40 * v)},${Math.round(42 * v)},${Math.round(46 * v)},0.5)`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
  // aggregate
  speckle(ctx, w, h, 26000, rng, 0.4, 2.0, (r) => {
    const v = Math.round(48 + r * 78);
    return `rgba(${v},${v},${v + 3},${0.14 + r * 0.3})`;
  });
  speckle(ctx, w, h, 5000, rng, 0.4, 1.4, () => 'rgba(16,16,19,0.5)');

  // tar seams running along the road
  ctx.globalAlpha = 0.5;
  for (let i = 0; i < 5; i++) {
    const x = rng() * w;
    ctx.strokeStyle = '#1b1c20';
    ctx.lineWidth = 2 + rng() * 4;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    for (let y = 0; y <= h; y += 32) ctx.lineTo(x + (rng() - 0.5) * 10, y);
    ctx.stroke();
  }
  // transverse repair patches
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = `rgba(${26 + rng() * 12 | 0},${27 + rng() * 12 | 0},${31 + rng() * 12 | 0},0.7)`;
    const y = rng() * h;
    ctx.fillRect(0, y, w, 8 + rng() * 22);
  }
  ctx.globalAlpha = 1;

  // ── markings ──
  const edge = shoulderFrac;                 // shoulder occupies the outer 10% each side
  const laneL = edge + 0.035, laneR = 1 - edge - 0.035;
  const paint = (x0, x1, dashOn, dashOff, colour, alpha = 0.9) => {
    ctx.fillStyle = colour;
    ctx.globalAlpha = alpha;
    if (!dashOn) { ctx.fillRect(x0 * w, 0, (x1 - x0) * w, h); }
    else {
      const period = dashOn + dashOff;
      for (let y = 0; y < h; y += period) ctx.fillRect(x0 * w, y, (x1 - x0) * w, dashOn);
    }
    ctx.globalAlpha = 1;
  };
  // shoulder: coarse chippings
  ctx.fillStyle = 'rgba(60,58,54,0.5)';
  ctx.fillRect(0, 0, edge * w, h);
  ctx.fillRect((1 - edge) * w, 0, edge * w, h);
  speckle(ctx, w, h, 4000, rng, 0.5, 1.8, () => 'rgba(120,112,98,0.28)');

  paint(laneL - 0.012, laneL + 0.012, 0, 0, '#e8eaee', 0.82);       // solid white edge lines
  paint(laneR - 0.012, laneR + 0.012, 0, 0, '#e8eaee', 0.82);
  paint(0.494, 0.506, h / 6, h / 6, '#f0d24a', 0.85);               // dashed centre
  paint(0.5 - 0.5 * (0.506 - 0.494) - 0.018, 0.5 - 0.009, h / 6, h / 6, '#f0d24a', 0.0);

  // weathering over the markings so they don't look freshly stencilled
  ctx.globalAlpha = 0.24;
  speckle(ctx, w, h, 9000, rng, 0.5, 2.2, (r) => `rgba(40,40,44,${0.25 + r * 0.4})`);
  ctx.globalAlpha = 1;

  // ── height → normal / roughness ──
  const hv = canvas(w, h);
  const hctx = hv.getContext('2d');
  hctx.fillStyle = '#808080';
  hctx.fillRect(0, 0, w, h);
  speckle(hctx, w, h, 24000, rng, 0.4, 2.1, (r) => `rgba(255,255,255,${0.05 + r * 0.14})`);
  speckle(hctx, w, h, 12000, rng, 0.4, 1.8, (r) => `rgba(0,0,0,${0.05 + r * 0.14})`);
  hctx.globalAlpha = 0.6;
  hctx.fillStyle = '#9a9a9a';
  hctx.fillRect(0, 0, edge * w, h);
  hctx.fillRect((1 - edge) * w, 0, edge * w, h);
  hctx.globalAlpha = 1;

  const rv = canvas(w, h);
  const rctx = rv.getContext('2d');
  rctx.fillStyle = '#b4b4b4';         // asphalt is fairly rough
  rctx.fillRect(0, 0, w, h);
  speckle(rctx, w, h, 12000, rng, 0.6, 2.6, (r) => `rgba(255,255,255,${r * 0.25})`);
  // painted lines are smoother
  rctx.fillStyle = 'rgba(90,90,90,0.85)';
  rctx.fillRect((laneL - 0.012) * w, 0, 0.024 * w, h);
  rctx.fillRect((laneR - 0.012) * w, 0, 0.024 * w, h);
  for (let y = 0; y < h; y += h / 3) rctx.fillRect(0.494 * w, y, 0.012 * w, h / 6);

  return {
    map: toTexture(cv, { srgb: true, wrapS: THREE.ClampToEdgeWrapping, aniso: 16 }),
    normalMap: toTexture(normalFromHeight(hv, 1.6), { wrapS: THREE.ClampToEdgeWrapping, aniso: 8 }),
    roughnessMap: toTexture(rv, { wrapS: THREE.ClampToEdgeWrapping, aniso: 8 }),
  };
}

export function makeTerrainDetail() {
  const rng = makeRng(0x9a17);
  const w = 512, h = 512;
  const hv = canvas(w, h);
  const c = hv.getContext('2d');
  c.fillStyle = '#808080';
  c.fillRect(0, 0, w, h);
  // grass-blade-ish streaks
  for (let i = 0; i < 5200; i++) {
    const x = rng() * w, y = rng() * h;
    const len = 3 + rng() * 8;
    const ang = -Math.PI / 2 + (rng() - 0.5) * 1.1;
    c.strokeStyle = rng() > 0.5 ? 'rgba(255,255,255,0.20)' : 'rgba(0,0,0,0.18)';
    c.lineWidth = 0.8 + rng();
    c.beginPath();
    c.moveTo(x, y);
    c.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    c.stroke();
  }
  speckle(c, w, h, 4000, rng, 0.6, 2.4, (r) => `rgba(0,0,0,${r * 0.15})`);
  return toTexture(normalFromHeight(hv, 1.1), { repeat: [1, 1] });
}

export function makeConcreteTextures(tint = '#8d8f92', seed = 7) {
  const rng = makeRng(seed);
  const w = 512, h = 512;
  const cv = canvas(w, h);
  const ctx = cv.getContext('2d');
  ctx.fillStyle = tint;
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 60; i++) {
    const g = ctx.createRadialGradient(rng() * w, rng() * h, 0, rng() * w, rng() * h, 60 + rng() * 180);
    g.addColorStop(0, `rgba(255,255,255,${rng() * 0.08})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  }
  speckle(ctx, w, h, 14000, rng, 0.4, 1.8, (r) => `rgba(0,0,0,${r * 0.13})`);
  // form-work seams
  ctx.strokeStyle = 'rgba(0,0,0,0.16)';
  ctx.lineWidth = 2;
  for (let y = 0; y < h; y += 128) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  // streaks of grime
  ctx.globalAlpha = 0.5;
  for (let i = 0; i < 40; i++) {
    const x = rng() * w;
    const g = ctx.createLinearGradient(x, 0, x, h);
    g.addColorStop(0, 'rgba(30,28,26,0.25)');
    g.addColorStop(1, 'rgba(30,28,26,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x, 0, 3 + rng() * 12, h);
  }
  ctx.globalAlpha = 1;

  const hv = canvas(w, h);
  const hc = hv.getContext('2d');
  hc.fillStyle = '#808080'; hc.fillRect(0, 0, w, h);
  speckle(hc, w, h, 9000, rng, 0.5, 2.2, (r) => `rgba(0,0,0,${r * 0.2})`);
  hc.strokeStyle = 'rgba(0,0,0,0.55)'; hc.lineWidth = 3;
  for (let y = 0; y < h; y += 128) { hc.beginPath(); hc.moveTo(0, y); hc.lineTo(w, y); hc.stroke(); }

  return {
    map: toTexture(cv, { srgb: true }),
    normalMap: toTexture(normalFromHeight(hv, 1.4)),
  };
}

/** Building facade with a window grid. UVs are metres/tile so windows stay real-sized. */
export function makeFacade(seed, palette) {
  const rng = makeRng(seed);
  const w = 256, h = 256;   // one tile = one floor × one window bay
  const cv = canvas(w, h);
  const ctx = cv.getContext('2d');
  const wall = palette.wall;
  ctx.fillStyle = wall;
  ctx.fillRect(0, 0, w, h);
  speckle(ctx, w, h, 6000, rng, 0.4, 1.6, (r) => `rgba(0,0,0,${r * 0.10})`);

  // spandrel band
  ctx.fillStyle = palette.band;
  ctx.fillRect(0, 0, w, h * 0.16);
  ctx.fillStyle = 'rgba(0,0,0,0.16)';
  ctx.fillRect(0, h * 0.16 - 3, w, 3);

  // window
  const wx = w * 0.13, wy = h * 0.24, ww = w * 0.74, wh = h * 0.60;
  ctx.fillStyle = palette.frame;
  ctx.fillRect(wx - 4, wy - 4, ww + 8, wh + 8);
  const g = ctx.createLinearGradient(wx, wy, wx + ww, wy + wh);
  g.addColorStop(0, palette.glassA);
  g.addColorStop(0.5, palette.glassB);
  g.addColorStop(1, palette.glassA);
  ctx.fillStyle = g;
  ctx.fillRect(wx, wy, ww, wh);
  // mullion
  ctx.fillStyle = palette.frame;
  ctx.fillRect(wx + ww * 0.5 - 2, wy, 4, wh);
  // reflection sheen
  ctx.globalAlpha = 0.22;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(wx, wy + wh * 0.7); ctx.lineTo(wx + ww * 0.55, wy); ctx.lineTo(wx + ww, wy);
  ctx.lineTo(wx + ww, wy + wh * 0.15); ctx.lineTo(wx, wy + wh * 0.95);
  ctx.closePath(); ctx.fill();
  ctx.globalAlpha = 1;

  // ── emissive variant: some windows lit ──
  const ev = canvas(w, h);
  const ectx = ev.getContext('2d');
  ectx.fillStyle = '#000';
  ectx.fillRect(0, 0, w, h);
  const lit = rng() > 0.42;
  if (lit) {
    const warm = ['#ffd9a0', '#ffe9c4', '#cfe4ff', '#ffcf7a'][Math.floor(rng() * 4)];
    ectx.fillStyle = warm;
    ectx.globalAlpha = 0.55 + rng() * 0.45;
    ectx.fillRect(wx, wy, ww, wh);
    ectx.globalAlpha = 1;
    ectx.fillStyle = '#000';
    ectx.fillRect(wx + ww * 0.5 - 2, wy, 4, wh);
    // furniture silhouettes
    ectx.fillStyle = 'rgba(0,0,0,0.55)';
    for (let i = 0; i < 3; i++) {
      const bx = wx + rng() * ww * 0.7, bh = wh * (0.15 + rng() * 0.3);
      ectx.fillRect(bx, wy + wh - bh, ww * (0.1 + rng() * 0.2), bh);
    }
  }

  return {
    map: toTexture(cv, { srgb: true, aniso: 8 }),
    emissiveMap: toTexture(ev, { srgb: true, aniso: 4 }),
    lit,
  };
}

/** Soft radial sprite used for smoke, dust and light glows. */
export function makeSoftSprite(inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)', power = 1) {
  const s = 128;
  const cv = canvas(s, s);
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    g.addColorStop(t, i === 0 ? inner : i === 8 ? outer : mixCss(inner, outer, Math.pow(t, power)));
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  return toTexture(cv, { wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping, srgb: true, aniso: 1 });
}

/** Puffy smoke sprite with internal structure so plumes don't look like blobs. */
export function makeSmokeSprite() {
  const s = 128;
  const rng = makeRng(0x2a71);
  const cv = canvas(s, s);
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, s, s);
  for (let i = 0; i < 26; i++) {
    const a = rng() * Math.PI * 2;
    const r = Math.pow(rng(), 0.7) * s * 0.30;
    const x = s / 2 + Math.cos(a) * r, y = s / 2 + Math.sin(a) * r;
    const rr = s * (0.10 + rng() * 0.18);
    const g = ctx.createRadialGradient(x, y, 0, x, y, rr);
    g.addColorStop(0, `rgba(255,255,255,${0.12 + rng() * 0.16})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2); ctx.fill();
  }
  // fade the rim so tiles never show a hard edge
  const fade = ctx.createRadialGradient(s / 2, s / 2, s * 0.30, s / 2, s / 2, s * 0.5);
  fade.addColorStop(0, 'rgba(0,0,0,0)');
  fade.addColorStop(1, 'rgba(0,0,0,1)');
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = fade;
  ctx.fillRect(0, 0, s, s);
  ctx.globalCompositeOperation = 'source-over';
  return toTexture(cv, { wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping, srgb: true, aniso: 1 });
}

/** Vertical rain streak. */
export function makeRainSprite() {
  const w = 16, h = 128;
  const cv = canvas(w, h);
  const ctx = cv.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, 'rgba(190,215,235,0)');
  g.addColorStop(0.35, 'rgba(205,225,245,0.55)');
  g.addColorStop(0.75, 'rgba(220,235,255,0.85)');
  g.addColorStop(1, 'rgba(190,215,235,0)');
  ctx.fillStyle = g;
  ctx.fillRect(w * 0.35, 0, w * 0.30, h);
  return toTexture(cv, { wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping, srgb: true, aniso: 1 });
}

/** Circular tyre-mark stamp used by the skid-mark ribbon. */
export function makeSkidTexture() {
  const w = 64, h = 64;
  const rng = makeRng(0x77aa);
  const cv = canvas(w, h);
  const ctx = cv.getContext('2d');
  ctx.fillStyle = 'rgba(0,0,0,0)';
  ctx.fillRect(0, 0, w, h);
  // tread grooves across the width
  for (let i = 0; i < w; i++) {
    const groove = Math.abs(Math.sin(i * 0.6)) > 0.75 ? 0.35 : 1.0;
    ctx.fillStyle = `rgba(18,16,16,${0.85 * groove})`;
    ctx.fillRect(i, 0, 1, h);
  }
  // soften the outer edges
  const g = ctx.createLinearGradient(0, 0, w, 0);
  g.addColorStop(0, 'rgba(0,0,0,1)');
  g.addColorStop(0.16, 'rgba(0,0,0,0)');
  g.addColorStop(0.84, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,1)');
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'source-over';
  speckle(ctx, w, h, 220, rng, 0.4, 1.2, () => 'rgba(0,0,0,0.25)');
  return toTexture(cv, { wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.RepeatWrapping, srgb: true, aniso: 4 });
}

/** Sparse foliage card: a clump of leaves with an alpha cutout. */
export function makeFoliageTexture(tint = '#4a7a34', seed = 3) {
  const s = 128;
  const rng = makeRng(seed);
  const cv = canvas(s, s);
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, s, s);
  const base = new THREE.Color(tint);
  for (let i = 0; i < 150; i++) {
    const a = rng() * Math.PI * 2;
    const r = Math.pow(rng(), 0.55) * s * 0.46;
    const x = s / 2 + Math.cos(a) * r, y = s / 2 + Math.sin(a) * r * 0.9;
    const rr = 4 + rng() * 12;
    const c = base.clone().multiplyScalar(0.6 + rng() * 0.7);
    ctx.fillStyle = `rgb(${(c.r * 255) | 0},${(c.g * 255) | 0},${(c.b * 255) | 0})`;
    ctx.beginPath();
    ctx.ellipse(x, y, rr, rr * (0.6 + rng() * 0.5), rng() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  return toTexture(cv, { wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping, srgb: true, aniso: 4 });
}

/** Alternating stripes running along V — kerbs, marker boards, hazard tape. */
export function makeStripes(a = '#d8352a', b = '#f0f2f5', bands = 4, grime = 0.18) {
  const w = 64, h = 256;
  const rng = makeRng(0x4411);
  const cv = canvas(w, h);
  const ctx = cv.getContext('2d');
  const bandH = h / bands;
  for (let i = 0; i < bands; i++) {
    ctx.fillStyle = i % 2 ? b : a;
    ctx.fillRect(0, i * bandH, w, bandH);
  }
  speckle(ctx, w, h, 2600, rng, 0.4, 1.8, (r) => `rgba(30,28,26,${r * grime})`);
  // rubber scuffing along the inner edge
  const g = ctx.createLinearGradient(0, 0, w, 0);
  g.addColorStop(0, `rgba(24,22,22,${grime * 2.2})`);
  g.addColorStop(0.4, 'rgba(24,22,22,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  return toTexture(cv, { srgb: true, wrapS: THREE.ClampToEdgeWrapping, aniso: 8 });
}

/** Start/finish chequerboard. */
export function makeChecker(cells = 12) {
  const s = 512;
  const cv = canvas(s, s);
  const ctx = cv.getContext('2d');
  const rng = makeRng(0x8f2d);
  const cw = s / cells, ch = s / 2;
  ctx.fillStyle = '#f2f4f7';
  ctx.fillRect(0, 0, s, s);
  ctx.fillStyle = '#14161a';
  for (let i = 0; i < cells; i++) {
    for (let j = 0; j < 2; j++) {
      if ((i + j) % 2 === 0) ctx.fillRect(i * cw, j * ch, cw, ch);
    }
  }
  speckle(ctx, s, s, 7000, rng, 0.5, 2.2, (r) => `rgba(50,48,48,${r * 0.28})`);
  return toTexture(cv, { srgb: true, wrapS: THREE.ClampToEdgeWrapping, aniso: 16 });
}

/** Gantry banner artwork. */
export function makeBanner() {
  const w = 1024, h = 128;
  const cv = canvas(w, h);
  const ctx = cv.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, w, 0);
  g.addColorStop(0, '#0b0e13');
  g.addColorStop(0.45, '#12303a');
  g.addColorStop(1, '#0b0e13');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#29e0a8';
  ctx.fillRect(0, h - 7, w, 7);
  ctx.fillRect(0, 0, w, 4);
  ctx.font = '900 68px Inter, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#eef2f7';
  ctx.fillText('APEX', w * 0.40, h / 2 + 2);
  ctx.fillStyle = '#29e0a8';
  ctx.fillText('HORIZON', w * 0.63, h / 2 + 2);
  // chequered flags at the ends
  const cs = 16;
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < h / cs; j++) {
      if ((i + j) % 2) continue;
      ctx.fillStyle = '#eef2f7';
      ctx.fillRect(i * cs, j * cs, cs, cs);
      ctx.fillRect(w - (i + 1) * cs, j * cs, cs, cs);
    }
  }
  return toTexture(cv, { srgb: true, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping, aniso: 8 });
}

/** Marker board: black/white chevron plate. */
export function makeMarkerBoard() {
  const w = 128, h = 256;
  const cv = canvas(w, h);
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#eceff3';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#1a1d22';
  ctx.beginPath();
  for (let i = -2; i < 6; i++) {
    ctx.moveTo(0, i * 64);
    ctx.lineTo(w, i * 64 - 64);
    ctx.lineTo(w, i * 64 - 24);
    ctx.lineTo(0, i * 64 + 40);
  }
  ctx.fill();
  ctx.strokeStyle = '#8b9099';
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, w - 6, h - 6);
  return toTexture(cv, { srgb: true, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping, aniso: 8 });
}

/** Bark: vertical fibrous stripes. */
export function makeBark() {
  const w = 128, h = 256;
  const rng = makeRng(0xb42c);
  const cv = canvas(w, h);
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#4a3b2c';
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 500; i++) {
    const x = rng() * w;
    ctx.strokeStyle = rng() > 0.5 ? 'rgba(30,23,17,0.5)' : 'rgba(120,102,80,0.35)';
    ctx.lineWidth = 0.7 + rng() * 2.4;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    for (let y = 0; y <= h; y += 24) ctx.lineTo(x + (rng() - 0.5) * 5, y);
    ctx.stroke();
  }
  return toTexture(cv, { srgb: true, repeat: [1, 1], aniso: 4 });
}

/** Reusable water normal map (two-scale ripples). */
export function makeWaterNormal() {
  const s = 256;
  const rng = makeRng(0x1f3a);
  const hv = canvas(s, s);
  const c = hv.getContext('2d');
  c.fillStyle = '#808080'; c.fillRect(0, 0, s, s);
  for (let i = 0; i < 70; i++) {
    const g = c.createRadialGradient(rng() * s, rng() * s, 0, rng() * s, rng() * s, 12 + rng() * 46);
    g.addColorStop(0, `rgba(255,255,255,${0.10 + rng() * 0.16})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g; c.fillRect(0, 0, s, s);
  }
  for (let i = 0; i < 70; i++) {
    const g = c.createRadialGradient(rng() * s, rng() * s, 0, rng() * s, rng() * s, 12 + rng() * 46);
    g.addColorStop(0, `rgba(0,0,0,${0.10 + rng() * 0.16})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g; c.fillRect(0, 0, s, s);
  }
  return toTexture(normalFromHeight(hv, 0.9), { repeat: [8, 8] });
}

/** Metal flake for metallic paint finishes. */
export function makeFlakeNormal() {
  const s = 256;
  const rng = makeRng(0x5b2c);
  const hv = canvas(s, s);
  const c = hv.getContext('2d');
  c.fillStyle = '#808080'; c.fillRect(0, 0, s, s);
  speckle(c, s, s, 9000, rng, 0.5, 1.5, (r) => (r > 0.5 ? `rgba(255,255,255,${r * 0.9})` : `rgba(0,0,0,${r * 0.9})`));
  return toTexture(normalFromHeight(hv, 2.6), { repeat: [26, 26] });
}

function mixCss(a, b, t) {
  const pa = parseRgba(a), pb = parseRgba(b);
  const r = Math.round(lerp(pa[0], pb[0], t));
  const g = Math.round(lerp(pa[1], pb[1], t));
  const bl = Math.round(lerp(pa[2], pb[2], t));
  const al = lerp(pa[3], pb[3], t);
  return `rgba(${r},${g},${bl},${clamp01(al)})`;
}
function parseRgba(s) {
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (!m) return [255, 255, 255, 1];
  const p = m[1].split(',').map((v) => parseFloat(v));
  return [p[0] || 0, p[1] || 0, p[2] || 0, p[3] === undefined ? 1 : p[3]];
}
