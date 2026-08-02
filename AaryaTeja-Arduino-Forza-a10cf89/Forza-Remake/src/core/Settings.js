/**
 * Persisted settings + player profile (credits, owned cars, per-car builds, best laps).
 * Everything lives in localStorage; a corrupt/absent store falls back to defaults.
 */

import { CAR_BY_ID } from '../data/cars.js';

const KEY_SETTINGS = 'apexhorizon.settings.v1';
const KEY_PROFILE = 'apexhorizon.profile.v1';

export const QUALITY_PRESETS = {
  low: {
    label: 'Low', renderScale: 0.7, shadows: false, shadowMapSize: 1024, bloom: false,
    motionBlur: false, smaa: false, anisotropy: 2, propDensity: 0.35, drawDistance: 700,
    particles: 0.3, skidMarks: false, reflections: 'low',
  },
  medium: {
    label: 'Medium', renderScale: 0.85, shadows: true, shadowMapSize: 1536, bloom: true,
    motionBlur: false, smaa: false, anisotropy: 4, propDensity: 0.6, drawDistance: 1100,
    particles: 0.6, skidMarks: true, reflections: 'low',
  },
  high: {
    label: 'High', renderScale: 1.0, shadows: true, shadowMapSize: 2048, bloom: true,
    motionBlur: true, smaa: true, anisotropy: 8, propDensity: 1.0, drawDistance: 1600,
    particles: 1.0, skidMarks: true, reflections: 'high',
  },
  ultra: {
    label: 'Ultra', renderScale: 1.0, shadows: true, shadowMapSize: 4096, bloom: true,
    motionBlur: true, smaa: true, anisotropy: 16, propDensity: 1.0, drawDistance: 2200,
    particles: 1.4, skidMarks: true, reflections: 'high',
  },
};

export const DEFAULT_SETTINGS = {
  // graphics
  quality: 'high',
  renderScaleOverride: 0,       // 0 = follow preset
  fov: 74,
  motionBlurAmount: 0.55,
  bloomAmount: 0.45,
  shadowsOverride: null,        // null = follow preset
  showFps: false,
  // audio
  masterVolume: 0.8,
  engineVolume: 0.85,
  sfxVolume: 0.9,
  ambienceVolume: 0.55,
  uiVolume: 0.6,
  // gameplay
  units: 'kmh',                 // 'kmh' | 'mph'
  cameraMode: 0,                // index into CAMERA_MODES
  assistTraction: true,
  assistAbs: true,
  assistStability: true,
  assistRacingLine: true,
  autoGearbox: true,
  damageEnabled: true,
  cameraShake: 0.7,
  // controls
  padDeadzone: 0.12,
  steerSensitivity: 1.0,
  steerLinearity: 1.35,         // >1 = finer around centre
  invertLook: false,
};

export const DEFAULT_PROFILE = {
  credits: 42000,
  owned: ['kestrel'],
  currentCar: 'kestrel',
  builds: {},                   // carId -> build
  bestLaps: {},                 // carId -> seconds
  bestLapOverall: null,
  racesWon: 0,
  racesRun: 0,
  distanceKm: 0,
};

export function defaultBuild(paint = '#c8102e') {
  return {
    paint,
    finish: 'gloss',
    stripe: 'none',
    stripeColour: '#f2f4f8',
    wheelStyle: 0,
    rimColour: '#d6dae2',
    caliperColour: '#e03a1a',
    tyre: 'sport',
    upgrades: { engine: 0, gearbox: 0, tyres: 0, brakes: 0, weight: 0, aero: 0 },
    tune: {
      finalDrive: 1.0,     // 0.8 .. 1.25 multiplier
      downforce: 0.5,      // 0..1
      brakeBias: 0.6,      // 0.35 .. 0.75 (front share)
      rideHeight: 0.5,     // 0..1
      arbFront: 0.5,       // 0..1
      arbRear: 0.5,        // 0..1
      steerLock: 0.5,      // 0..1
    },
  };
}

function safeParse(raw, fallback) {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

class Store {
  constructor() {
    this.settings = { ...DEFAULT_SETTINGS, ...(safeParse(this._read(KEY_SETTINGS)) || {}) };
    const prof = safeParse(this._read(KEY_PROFILE)) || {};
    this.profile = { ...structuredClone(DEFAULT_PROFILE), ...prof };
    this.profile.builds = { ...(prof.builds || {}) };
    this.profile.bestLaps = { ...(prof.bestLaps || {}) };
    if (!Array.isArray(this.profile.owned) || !this.profile.owned.length) {
      this.profile.owned = [...DEFAULT_PROFILE.owned];
    }
    this._listeners = new Set();
  }

  _read(k) {
    try { return localStorage.getItem(k); } catch { return null; }
  }
  _write(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode — run in memory */ }
  }

  get quality() {
    return QUALITY_PRESETS[this.settings.quality] || QUALITY_PRESETS.high;
  }

  /** Effective graphics config, merging preset with user overrides. */
  gfx() {
    const q = this.quality;
    return {
      ...q,
      renderScale: this.settings.renderScaleOverride > 0 ? this.settings.renderScaleOverride : q.renderScale,
      shadows: this.settings.shadowsOverride === null ? q.shadows : this.settings.shadowsOverride,
      motionBlur: q.motionBlur && this.settings.motionBlurAmount > 0.01,
      bloom: q.bloom && this.settings.bloomAmount > 0.01,
    };
  }

  set(key, value) {
    this.settings[key] = value;
    this._write(KEY_SETTINGS, this.settings);
    this._listeners.forEach((f) => f(key, value));
  }

  onChange(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }

  resetSettings() {
    this.settings = { ...DEFAULT_SETTINGS };
    this._write(KEY_SETTINGS, this.settings);
    this._listeners.forEach((f) => f('*', null));
  }

  // ── profile ──
  saveProfile() { this._write(KEY_PROFILE, this.profile); }

  build(carId) {
    const paint = CAR_BY_ID[carId]?.body?.colour;
    if (!this.profile.builds[carId]) this.profile.builds[carId] = defaultBuild(paint);
    const b = this.profile.builds[carId];
    const d = defaultBuild(paint);
    // heal partially-written builds from older sessions
    b.upgrades = { ...d.upgrades, ...(b.upgrades || {}) };
    b.tune = { ...d.tune, ...(b.tune || {}) };
    for (const k of Object.keys(d)) if (b[k] === undefined) b[k] = d[k];
    return b;
  }

  owns(carId) { return this.profile.owned.includes(carId); }

  buy(carId, price) {
    if (this.owns(carId)) return true;
    if (this.profile.credits < price) return false;
    this.profile.credits -= price;
    this.profile.owned.push(carId);
    this.saveProfile();
    return true;
  }

  spend(amount) {
    if (this.profile.credits < amount) return false;
    this.profile.credits -= amount;
    this.saveProfile();
    return true;
  }

  award(amount) {
    this.profile.credits += Math.round(amount);
    this.saveProfile();
  }

  recordLap(carId, seconds) {
    let record = false;
    const prev = this.profile.bestLaps[carId];
    if (prev == null || seconds < prev) { this.profile.bestLaps[carId] = seconds; record = true; }
    if (this.profile.bestLapOverall == null || seconds < this.profile.bestLapOverall) {
      this.profile.bestLapOverall = seconds;
    }
    this.saveProfile();
    return record;
  }
}

export const store = new Store();
