import { clamp, clamp01, lerp } from '../core/MathUtils.js';

/**
 * Everything you hear is synthesised at runtime with the Web Audio API —
 * no sample files. Engines are additive harmonic stacks driven by rpm and load,
 * tyres/wind/rain are filtered noise, impacts are transient noise + metal ring.
 */

function noiseBuffer(ctx, seconds = 2) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    const white = Math.random() * 2 - 1;
    last = (last + 0.02 * white) / 1.02;      // gently pink it
    d[i] = last * 3.5;
  }
  return buf;
}

function distortionCurve(amount = 12) {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * amount) / Math.tanh(amount);
  }
  return curve;
}

/* ═══════════════════════════ engine voice ═══════════════════════════ */

const HARMONICS = [
  { mul: 0.5, type: 'square', base: 0.30, loadGain: 0.35 },
  { mul: 1.0, type: 'sawtooth', base: 0.42, loadGain: 0.45 },
  { mul: 1.5, type: 'sawtooth', base: 0.14, loadGain: 0.30 },
  { mul: 2.0, type: 'sawtooth', base: 0.20, loadGain: 0.34 },
  { mul: 3.0, type: 'sine', base: 0.10, loadGain: 0.26 },
  { mul: 4.0, type: 'sine', base: 0.05, loadGain: 0.20 },
];

class EngineVoice {
  constructor(ctx, dest, noise, { rich = true } = {}) {
    this.ctx = ctx;
    this.rich = rich;

    this.out = ctx.createGain();
    this.out.gain.value = 0;

    this.shaper = ctx.createWaveShaper();
    this.shaper.curve = distortionCurve(rich ? 9 : 4);
    this.shaper.oversample = rich ? '2x' : 'none';

    this.lowpass = ctx.createBiquadFilter();
    this.lowpass.type = 'lowpass';
    this.lowpass.frequency.value = 1200;
    this.lowpass.Q.value = 0.8;

    this.body = ctx.createBiquadFilter();
    this.body.type = 'peaking';
    this.body.frequency.value = 180;
    this.body.gain.value = 6;
    this.body.Q.value = 1.1;

    this.mix = ctx.createGain();
    this.mix.gain.value = 0.24;

    this.mix.connect(this.shaper);
    this.shaper.connect(this.body);
    this.body.connect(this.lowpass);
    this.lowpass.connect(this.out);
    this.out.connect(dest);

    this.oscs = [];
    const set = rich ? HARMONICS : HARMONICS.slice(0, 3);
    for (const h of set) {
      const o = ctx.createOscillator();
      o.type = h.type;
      o.frequency.value = 60;
      const g = ctx.createGain();
      g.gain.value = h.base;
      o.connect(g);
      g.connect(this.mix);
      o.start();
      this.oscs.push({ o, g, h });
    }

    // intake / exhaust rush
    this.noiseSrc = ctx.createBufferSource();
    this.noiseSrc.buffer = noise;
    this.noiseSrc.loop = true;
    this.noiseBand = ctx.createBiquadFilter();
    this.noiseBand.type = 'bandpass';
    this.noiseBand.frequency.value = 500;
    this.noiseBand.Q.value = 1.3;
    this.noiseGain = ctx.createGain();
    this.noiseGain.gain.value = 0;
    this.noiseSrc.connect(this.noiseBand);
    this.noiseBand.connect(this.noiseGain);
    this.noiseGain.connect(this.mix);
    this.noiseSrc.start();

    if (rich) {
      // turbo whistle
      this.turbo = ctx.createOscillator();
      this.turbo.type = 'sine';
      this.turbo.frequency.value = 4200;
      this.turboGain = ctx.createGain();
      this.turboGain.gain.value = 0;
      this.turbo.connect(this.turboGain);
      this.turboGain.connect(this.out);
      this.turbo.start();
    }
  }

  /**
   * @param {number} rpm
   * @param {number} load 0..1
   * @param {number} volume overall gain
   * @param {object} car spec for cylinder count / redline
   */
  update(rpm, load, volume, car, boost = 0, at = 0) {
    const ctx = this.ctx;
    const now = at || ctx.currentTime;
    const tc = 0.03;
    const firing = Math.max((rpm / 60) * (car.engine.cylinders / 2), 8);
    const jitter = 1 + (Math.random() - 0.5) * 0.006 * (1 - load * 0.6);

    for (const { o, g, h } of this.oscs) {
      o.frequency.setTargetAtTime(clamp(firing * h.mul * jitter, 12, 12000), now, tc);
      g.gain.setTargetAtTime(h.base + h.loadGain * load, now, tc * 2);
    }
    const frac = clamp01(rpm / car.engine.redline);
    this.lowpass.frequency.setTargetAtTime(420 + frac * 3200 + load * 3000, now, tc * 2);
    this.body.frequency.setTargetAtTime(clamp(firing * 1.5, 60, 900), now, tc * 3);
    this.noiseBand.frequency.setTargetAtTime(clamp(firing * 3.2, 200, 6000), now, tc * 2);
    this.noiseGain.gain.setTargetAtTime(0.02 + load * 0.10 + frac * 0.05, now, tc * 2);
    this.out.gain.setTargetAtTime(volume, now, tc);
    if (this.turbo) {
      this.turbo.frequency.setTargetAtTime(2600 + frac * 5200, now, tc * 2);
      this.turboGain.gain.setTargetAtTime(boost * 0.030 * volume * 6, now, 0.08);
    }
  }

  stop() {
    for (const { o } of this.oscs) { try { o.stop(); } catch { /* already stopped */ } }
    try { this.noiseSrc.stop(); } catch { /* already stopped */ }
    if (this.turbo) { try { this.turbo.stop(); } catch { /* already stopped */ } }
    this.out.disconnect();
  }
}

/* ═══════════════════════════ audio engine ═══════════════════════════ */

export class AudioEngine {
  constructor() {
    this.ready = false;
    this.ctx = null;
    this.enabled = true;
    this.volumes = { master: 0.8, engine: 0.85, sfx: 0.9, ambience: 0.55, ui: 0.6 };
    this._rivalVoices = [];
    this._lastShift = 0;
  }

  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC({ latencyHint: 'interactive' });
    this.ctx = ctx;
    this.noise = noiseBuffer(ctx, 3);

    this.master = ctx.createGain();
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -14;
    this.comp.knee.value = 26;
    this.comp.ratio.value = 7;
    this.comp.attack.value = 0.004;
    this.comp.release.value = 0.22;
    this.master.connect(this.comp);
    this.comp.connect(ctx.destination);

    this.buses = {};
    for (const name of ['engine', 'sfx', 'ambience', 'ui']) {
      const g = ctx.createGain();
      g.connect(this.master);
      this.buses[name] = g;
    }

    // ── player engine ──
    this.playerEngine = new EngineVoice(ctx, this.buses.engine, this.noise, { rich: true });

    // ── tyre screech ──
    this.tyre = this._noiseChain(this.buses.sfx, 'bandpass', 1650, 3.2, 0);
    this.tyre2 = this._noiseChain(this.buses.sfx, 'bandpass', 2900, 5.0, 0);
    this.gravel = this._noiseChain(this.buses.sfx, 'lowpass', 900, 1.0, 0);

    // ── wind ──
    this.wind = this._noiseChain(this.buses.ambience, 'lowpass', 700, 0.7, 0);
    this.windHigh = this._noiseChain(this.buses.ambience, 'highpass', 2200, 0.6, 0);

    // ── road rumble ──
    this.rumble = this._noiseChain(this.buses.ambience, 'lowpass', 180, 1.2, 0);

    // ── rain ──
    this.rain = this._noiseChain(this.buses.ambience, 'highpass', 1400, 0.5, 0);
    this.rainLow = this._noiseChain(this.buses.ambience, 'bandpass', 620, 0.8, 0);

    this.applyVolumes(this.volumes);
    this.ready = true;
  }

  _noiseChain(dest, filterType, freq, q, gain) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = filterType;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(f); f.connect(g); g.connect(dest);
    src.start();
    return { src, filter: f, gain: g };
  }

  resume() {
    if (!this.ctx) this.init();
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  applyVolumes(v) {
    Object.assign(this.volumes, v);
    if (!this.ctx) return;
    const m = this.enabled ? this.volumes.master : 0;
    this.master.gain.setTargetAtTime(m, this.ctx.currentTime, 0.05);
    this.buses.engine.gain.setTargetAtTime(this.volumes.engine, this.ctx.currentTime, 0.05);
    this.buses.sfx.gain.setTargetAtTime(this.volumes.sfx, this.ctx.currentTime, 0.05);
    this.buses.ambience.gain.setTargetAtTime(this.volumes.ambience, this.ctx.currentTime, 0.05);
    this.buses.ui.gain.setTargetAtTime(this.volumes.ui, this.ctx.currentTime, 0.05);
  }

  setMuted(m) {
    this.enabled = !m;
    this.applyVolumes(this.volumes);
  }

  /** Duck everything while a menu is open. */
  setDuck(amount) {
    if (!this.ctx) return;
    this.master.gain.setTargetAtTime(this.enabled ? this.volumes.master * (1 - amount * 0.82) : 0, this.ctx.currentTime, 0.12);
  }

  /* ═══════════ per-frame ═══════════ */

  update(dt, ctx) {
    if (!this.ready || !this.ctx) return;
    const { vehicle, rivals, weather, listenerPos, listenerFwd, listenerRight, interior, tunnel } = ctx;
    const now = this.ctx.currentTime;
    const t = vehicle.telemetry;
    const speed = Math.abs(t.speed);

    // engine
    const load = clamp01(t.throttle * 0.75 + clamp01(t.rpm / vehicle.car.engine.redline) * 0.35 - (t.shifting ? 0.55 : 0));
    const shiftDuck = t.shifting ? 0.35 : 1;
    const interiorMuffle = interior ? 0.72 : 1;
    this.playerEngine.update(
      t.rpm, load,
      0.34 * shiftDuck * interiorMuffle * (t.limiter ? 0.55 + Math.random() * 0.45 : 1),
      vehicle.car, t.boost, now,
    );

    // rival engines: the three nearest get their own voice
    this._updateRivals(rivals, listenerPos, listenerRight, now);

    // tyres
    const screech = clamp01(t.tyreScreech);
    const onRoad = t.onRoad ? 1 : 0;
    const tc = 0.05;
    this.tyre.gain.gain.setTargetAtTime(screech * 0.16 * onRoad * interiorMuffle, now, tc);
    this.tyre.filter.frequency.setTargetAtTime(1200 + screech * 1400 + speed * 6, now, tc);
    this.tyre2.gain.gain.setTargetAtTime(screech * screech * 0.10 * onRoad, now, tc);
    this.gravel.gain.gain.setTargetAtTime(t.offroadAmount * clamp01(speed / 14) * 0.20, now, tc);
    this.gravel.filter.frequency.setTargetAtTime(400 + speed * 22, now, tc);

    // wind + rumble
    const sp = clamp01(speed / 90);
    this.wind.gain.gain.setTargetAtTime(sp * sp * 0.34 * (interior ? 0.45 : 1), now, 0.1);
    this.wind.filter.frequency.setTargetAtTime(300 + sp * 1400, now, 0.1);
    this.windHigh.gain.gain.setTargetAtTime(sp * sp * sp * 0.11 * (interior ? 0.3 : 1), now, 0.1);
    this.rumble.gain.gain.setTargetAtTime(clamp01(speed / 40) * 0.18 * (t.onRoad ? 1 : 1.5), now, 0.08);
    this.rumble.filter.frequency.setTargetAtTime(80 + speed * 3.2, now, 0.1);

    // rain
    const rainAmount = weather === 'rain' ? 1 : 0;
    this.rain.gain.gain.setTargetAtTime(rainAmount * 0.16 * (interior ? 0.55 : 1), now, 0.4);
    this.rainLow.gain.gain.setTargetAtTime(rainAmount * (0.05 + sp * 0.12), now, 0.4);

    // tunnel reverb-ish: lift the low mids and drop the highs
    const tunnelAmt = tunnel ? 1 : 0;
    this.playerEngine.body.gain.setTargetAtTime(6 + tunnelAmt * 9, now, 0.25);
  }

  _updateRivals(rivals, listenerPos, listenerRight, now) {
    if (!rivals || !listenerPos) return;
    const scored = rivals
      .filter((r) => r.isAlive)
      .map((r) => ({ r, d: r.position.distanceTo(listenerPos) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 3);

    while (this._rivalVoices.length < scored.length) {
      const voice = new EngineVoice(this.ctx, this.buses.engine, this.noise, { rich: false });
      const pan = this.ctx.createStereoPanner();
      voice.out.disconnect();
      voice.out.connect(pan);
      pan.connect(this.buses.engine);
      this._rivalVoices.push({ voice, pan });
    }
    for (let i = 0; i < this._rivalVoices.length; i++) {
      const slot = this._rivalVoices[i];
      const s = scored[i];
      if (!s || s.d > 95) {
        slot.voice.out.gain.setTargetAtTime(0, now, 0.15);
        continue;
      }
      const t = s.r.telemetry;
      const load = clamp01(t.throttle * 0.8 + clamp01(t.rpm / s.r.car.engine.redline) * 0.3);
      const atten = Math.pow(1 - clamp01(s.d / 95), 1.7);
      const dir = s.r.position.clone().sub(listenerPos).normalize();
      slot.pan.pan.setTargetAtTime(clamp(dir.dot(listenerRight || { x: 1, y: 0, z: 0 }) * -1, -1, 1), now, 0.1);
      slot.voice.update(t.rpm, load, 0.15 * atten, s.r.car, t.boost, now);
    }
  }

  /* ═══════════ one-shots ═══════════ */

  _burst({ bus = 'sfx', freq = 220, q = 1, type = 'bandpass', gain = 0.3, decay = 0.2, attack = 0.004 }) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.5;
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(gain, now + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, now + attack + decay);
    src.connect(f); f.connect(g); g.connect(this.buses[bus]);
    src.start(now, Math.random() * 2);
    src.stop(now + attack + decay + 0.05);
  }

  _tone({ bus = 'ui', freq = 660, type = 'sine', gain = 0.14, decay = 0.16, attack = 0.005, detune = 0, slideTo = null }) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, now);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, now + decay);
    o.detune.value = detune;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(gain, now + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, now + attack + decay);
    o.connect(g); g.connect(this.buses[bus]);
    o.start(now);
    o.stop(now + attack + decay + 0.05);
  }

  gearShift(up = true) {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    if (now - this._lastShift < 0.05) return;
    this._lastShift = now;
    this._burst({ freq: up ? 2600 : 1900, q: 2.5, gain: 0.10, decay: 0.045 });
    this._tone({ bus: 'sfx', freq: up ? 150 : 110, type: 'square', gain: 0.05, decay: 0.05 });
  }

  backfire() {
    this._burst({ freq: 340, q: 0.9, gain: 0.30, decay: 0.11, type: 'lowpass' });
    this._burst({ freq: 1800, q: 1.4, gain: 0.12, decay: 0.05 });
  }

  blowOff() {
    this._burst({ freq: 3400, q: 1.1, gain: 0.13, decay: 0.20, type: 'highpass' });
  }

  collision(strength) {
    const s = clamp01(strength);
    this._burst({ freq: lerp(180, 700, s), q: 0.7, gain: 0.18 + s * 0.5, decay: 0.10 + s * 0.22, type: 'lowpass' });
    this._burst({ freq: 2400, q: 1.2, gain: 0.10 + s * 0.28, decay: 0.06 + s * 0.12 });
    // metallic ring
    for (const f of [430, 712, 1290]) {
      this._tone({ bus: 'sfx', freq: f * (0.9 + Math.random() * 0.2), type: 'triangle', gain: 0.05 + s * 0.12, decay: 0.25 + s * 0.5 });
    }
  }

  scrape(strength) {
    this._burst({ freq: 1800, q: 3.5, gain: 0.05 + strength * 0.12, decay: 0.09 });
  }

  landing(strength) {
    this._burst({ freq: 120, q: 0.8, gain: 0.16 + strength * 0.3, decay: 0.16, type: 'lowpass' });
    this._burst({ freq: 900, q: 1.0, gain: 0.05 + strength * 0.12, decay: 0.08 });
  }

  horn(on) {
    if (!this.ready) return;
    if (on && !this._horn) {
      const ctx = this.ctx;
      const g = ctx.createGain();
      g.gain.value = 0;
      g.gain.setTargetAtTime(0.10, ctx.currentTime, 0.01);
      g.connect(this.buses.sfx);
      const oscs = [440, 554].map((f) => {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = f;
        o.connect(g); o.start();
        return o;
      });
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 2200;
      this._horn = { g, oscs };
    } else if (!on && this._horn) {
      const { g, oscs } = this._horn;
      g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.02);
      const stopAt = this.ctx.currentTime + 0.2;
      oscs.forEach((o) => { try { o.stop(stopAt); } catch { /* noop */ } });
      this._horn = null;
    }
  }

  countdownBeep(n) {
    this._tone({ bus: 'ui', freq: 660, type: 'square', gain: 0.16, decay: 0.24 });
  }
  goBeep() {
    this._tone({ bus: 'ui', freq: 1320, type: 'square', gain: 0.22, decay: 0.5 });
    this._tone({ bus: 'ui', freq: 1980, type: 'sine', gain: 0.10, decay: 0.6 });
  }
  checkpoint() { this._tone({ bus: 'ui', freq: 1180, gain: 0.09, decay: 0.13 }); }
  lapDone() {
    this._tone({ bus: 'ui', freq: 880, gain: 0.12, decay: 0.18 });
    setTimeout(() => this._tone({ bus: 'ui', freq: 1320, gain: 0.12, decay: 0.24 }), 110);
  }
  fanfare(win) {
    const notes = win ? [523, 659, 784, 1047] : [523, 466, 392];
    notes.forEach((f, i) => setTimeout(() => this._tone({ bus: 'ui', freq: f, type: 'triangle', gain: 0.14, decay: 0.5 }), i * 140));
  }
  uiHover() { this._tone({ bus: 'ui', freq: 520, gain: 0.045, decay: 0.05 }); }
  uiSelect() { this._tone({ bus: 'ui', freq: 780, gain: 0.09, decay: 0.10, slideTo: 1180 }); }
  uiBack() { this._tone({ bus: 'ui', freq: 480, gain: 0.08, decay: 0.10, slideTo: 300 }); }
  uiError() { this._tone({ bus: 'ui', freq: 200, type: 'square', gain: 0.09, decay: 0.16 }); }
  purchase() {
    [784, 1047, 1319].forEach((f, i) => setTimeout(() => this._tone({ bus: 'ui', freq: f, gain: 0.10, decay: 0.22 }), i * 80));
  }
}

export const audio = new AudioEngine();
