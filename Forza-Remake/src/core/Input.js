import { store } from './Settings.js';
import { clamp } from './MathUtils.js';

/**
 * Unified keyboard + gamepad input.
 *
 * Driving values are analog (0..1 / -1..1). UI navigation is edge-triggered with
 * key-repeat so a held stick/dpad scrolls a menu at a sane rate.
 */

export const KEY_BINDINGS = [
  { action: 'Throttle',        keys: 'W  /  ↑',            pad: 'RT' },
  { action: 'Brake / Reverse', keys: 'S  /  ↓',            pad: 'LT' },
  { action: 'Steer',           keys: 'A D  /  ← →',        pad: 'Left stick' },
  { action: 'Handbrake',       keys: 'Space',              pad: 'A / ✕' },
  { action: 'Shift up',        keys: 'E  /  Right Shift',  pad: 'RB' },
  { action: 'Shift down',      keys: 'Q  /  Left Ctrl',    pad: 'LB' },
  { action: 'Change camera',   keys: 'C',                  pad: 'Y / △' },
  { action: 'Look back',       keys: 'B',                  pad: 'R3' },
  { action: 'Reset to track',  keys: 'R',                  pad: 'X / □' },
  { action: 'Headlights',      keys: 'L',                  pad: '—' },
  { action: 'Horn',            keys: 'H',                  pad: 'D-pad ↑' },
  { action: 'Pause',           keys: 'Esc  /  P',          pad: 'Start' },
  { action: 'Photo / free cam',keys: 'F',                  pad: '—' },
];

const DRIVE_CODES = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Space', 'KeyE', 'KeyQ', 'KeyC', 'KeyR', 'KeyB', 'KeyH', 'KeyL', 'KeyF',
  'ShiftRight', 'ControlLeft', 'Tab',
]);

class InputManager {
  constructor() {
    this.keys = new Set();
    this.pressedThisFrame = new Set();
    this.releasedThisFrame = new Set();

    this.pad = null;
    this.padIndex = null;
    this.padName = '';
    this._padPrev = [];
    this._padEdges = new Set();

    // repeat timers for held navigation
    this._navRepeat = {};
    this._anyInputAt = 0;

    this.state = {
      throttle: 0, brake: 0, steer: 0, handbrake: 0,
      shiftUp: false, shiftDown: false,
      camera: false, lookBack: false, reset: false,
      pause: false, horn: false, headlights: false, photo: false,
      navUp: false, navDown: false, navLeft: false, navRight: false,
      confirm: false, back: false,
      usingPad: false,
    };

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onBlur = this._onBlur.bind(this);
  }

  attach() {
    window.addEventListener('keydown', this._onKeyDown, { passive: false });
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
    window.addEventListener('gamepadconnected', (e) => {
      this.padIndex = e.gamepad.index;
      this.padName = e.gamepad.id.replace(/\s*\([^)]*\)\s*$/, '').slice(0, 34);
      window.dispatchEvent(new CustomEvent('apex:padchange', { detail: { connected: true, name: this.padName } }));
    });
    window.addEventListener('gamepaddisconnected', (e) => {
      if (e.gamepad.index === this.padIndex) {
        this.padIndex = null; this.padName = '';
        window.dispatchEvent(new CustomEvent('apex:padchange', { detail: { connected: false } }));
      }
    });
  }

  _onKeyDown(e) {
    if (e.repeat) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (DRIVE_CODES.has(e.code) || e.code === 'Escape' || e.code === 'Enter') e.preventDefault();
    this.keys.add(e.code);
    this.pressedThisFrame.add(e.code);
    this._anyInputAt = performance.now();
    this.state.usingPad = false;
  }

  _onKeyUp(e) {
    this.keys.delete(e.code);
    this.releasedThisFrame.add(e.code);
  }

  _onBlur() { this.keys.clear(); }

  key(...codes) { return codes.some((c) => this.keys.has(c)); }
  pressed(...codes) { return codes.some((c) => this.pressedThisFrame.has(c)); }

  _pollPad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let g = null;
    if (this.padIndex != null && pads[this.padIndex]) g = pads[this.padIndex];
    else {
      for (const p of pads) if (p && p.connected) { g = p; this.padIndex = p.index; break; }
    }
    this.pad = g;
    this._padEdges.clear();
    if (!g) { this._padPrev = []; return; }
    for (let i = 0; i < g.buttons.length; i++) {
      const v = g.buttons[i].pressed || g.buttons[i].value > 0.5;
      if (v && !this._padPrev[i]) this._padEdges.add(i);
      this._padPrev[i] = v;
    }
  }

  padBtn(i) { return this.pad && this.pad.buttons[i] ? this.pad.buttons[i].value : 0; }
  padDown(i) { return this.pad && this.pad.buttons[i] ? (this.pad.buttons[i].pressed || this.pad.buttons[i].value > 0.5) : false; }
  padEdge(i) { return this._padEdges.has(i); }
  padAxis(i) {
    if (!this.pad || this.pad.axes[i] === undefined) return 0;
    const dz = store.settings.padDeadzone;
    const v = this.pad.axes[i];
    if (Math.abs(v) < dz) return 0;
    return Math.sign(v) * ((Math.abs(v) - dz) / (1 - dz));
  }

  /** Held-with-repeat helper for menu navigation. */
  _rep(name, held, dt) {
    const s = this._navRepeat;
    if (!held) { s[name] = 0; return false; }
    const t = (s[name] || 0);
    s[name] = t + dt;
    if (t === 0) return true;                       // first frame
    const delay = 0.34, rate = 0.085;
    if (t < delay) return false;
    const since = t - delay;
    const prev = Math.floor((since - dt) / rate);
    return Math.floor(since / rate) > Math.max(prev, -1);
  }

  update(dt) {
    this._pollPad();
    const s = this.state;
    const set = store.settings;

    // ── steering ──
    let kSteer = 0;
    if (this.key('KeyA', 'ArrowLeft')) kSteer -= 1;
    if (this.key('KeyD', 'ArrowRight')) kSteer += 1;
    const aSteer = this.padAxis(0);
    if (Math.abs(aSteer) > 0.001) { s.usingPad = true; }
    let steer = Math.abs(aSteer) > Math.abs(kSteer) ? aSteer : kSteer;
    // linearity curve: finer control near centre
    const lin = set.steerLinearity;
    steer = Math.sign(steer) * Math.pow(Math.abs(steer), lin);
    s.steer = clamp(steer * set.steerSensitivity, -1, 1);

    // ── pedals ──
    const rt = Math.max(this.padBtn(7), this.padAxis(5) > 0 ? this.padAxis(5) : 0);
    const lt = Math.max(this.padBtn(6), this.padAxis(4) > 0 ? this.padAxis(4) : 0);
    if (rt > 0.02 || lt > 0.02) s.usingPad = true;
    s.throttle = clamp(Math.max(this.key('KeyW', 'ArrowUp') ? 1 : 0, rt), 0, 1);
    s.brake = clamp(Math.max(this.key('KeyS', 'ArrowDown') ? 1 : 0, lt), 0, 1);
    s.handbrake = clamp(Math.max(this.key('Space') ? 1 : 0, this.padDown(0) ? 1 : 0), 0, 1);

    // ── edge actions ──
    s.shiftUp = this.pressed('KeyE', 'ShiftRight') || this.padEdge(5);
    s.shiftDown = this.pressed('KeyQ', 'ControlLeft') || this.padEdge(4);
    s.camera = this.pressed('KeyC') || this.padEdge(3);
    s.reset = this.pressed('KeyR') || this.padEdge(2);
    s.pause = this.pressed('Escape', 'KeyP') || this.padEdge(9);
    s.headlights = this.pressed('KeyL');
    s.photo = this.pressed('KeyF');
    s.lookBack = this.key('KeyB') || this.padDown(11);
    s.horn = this.key('KeyH') || this.padDown(12);

    // ── UI navigation ──
    const ly = this.padAxis(1);
    s.navUp = this._rep('u', this.key('ArrowUp', 'KeyW') || this.padDown(12) || ly < -0.55, dt);
    s.navDown = this._rep('d', this.key('ArrowDown', 'KeyS') || this.padDown(13) || ly > 0.55, dt);
    const lx = this.padAxis(0);
    s.navLeft = this._rep('l', this.key('ArrowLeft', 'KeyA') || this.padDown(14) || lx < -0.55, dt);
    s.navRight = this._rep('r', this.key('ArrowRight', 'KeyD') || this.padDown(15) || lx > 0.55, dt);
    s.confirm = this.pressed('Enter', 'NumpadEnter', 'Space') || this.padEdge(0);
    s.back = this.pressed('Escape', 'Backspace') || this.padEdge(1);

    this.pressedThisFrame.clear();
    this.releasedThisFrame.clear();
  }

  get padConnected() { return !!this.pad; }
}

export const input = new InputManager();
