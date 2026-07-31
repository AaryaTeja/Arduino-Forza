import { store, QUALITY_PRESETS, defaultBuild } from '../core/Settings.js';
import { KEY_BINDINGS } from '../core/Input.js';
import {
  CARS, CAR_BY_ID, PAINT_PRESETS, TYRE_COMPOUNDS, UPGRADE_DEFS, TUNE_DEFS,
  resolveSpec, statBars, performanceIndex, estimateTopSpeed, upgradeCost,
} from '../data/cars.js';
import { CAMERA_MODES } from '../game/Cameras.js';
import { formatTime, clamp, clamp01 } from '../core/MathUtils.js';
import { toast } from './HUD.js';

const $ = (id) => document.getElementById(id);
const SCREENS = ['boot', 'menu-main', 'menu-event', 'menu-garage', 'menu-settings', 'menu-pause', 'menu-results', 'menu-exit'];

const LOAD_TIPS = [
  'Lift before the apex, not at it — trail braking rotates the car.',
  'The handbrake unloads the rear axle. Use it to pivot tight hairpins, not fast corners.',
  'Rally tyres transform the Baron off-road but cost you nearly a third of your tarmac grip.',
  'Softer front anti-roll bar = sharper turn-in. Stiffer rear = a livelier back end.',
  'Press C to cycle chase, bumper, hood, cockpit and cinematic cameras.',
  'Wet tarmac cuts grip by around a quarter. Brake earlier and squeeze the throttle.',
  'A longer final drive trades acceleration for top speed on the long north straight.',
  'Press R to reset to the track if you end up in the scenery.',
  'The tunnel is the fastest part of the lap — commit to the entry.',
];

export class UI {
  constructor(audio, hooks) {
    this.audio = audio;
    this.hooks = hooks;
    this.current = 'boot';
    this.prevScreen = 'menu-main';
    this.navIndex = 0;
    this.garageTab = 'stats';
    this.settingsTab = 'graphics';
    this.selectedCar = store.profile.currentCar || CARS[0].id;
    this.eventOptions = {
      laps: 3, rivals: 6, difficulty: 0.985, tod: 13, weather: 'clear', dyntime: 0, mode: 'race',
    };
    this._tipTimer = 0;
    this._tipIndex = 0;
    this._bind();
  }

  /* ═══════════ screens ═══════════ */

  show(id) {
    if (this.current === id) return;
    if (id !== 'menu-pause' && id !== 'menu-results' && this.current !== 'boot') this.prevScreen = this.current;
    for (const s of SCREENS) {
      const el = $(s);
      if (el) el.classList.toggle('active', s === id);
    }
    this.current = id;
    this.navIndex = 0;
    if (id === 'menu-main') this.refreshCredits();
    if (id === 'menu-garage') this.refreshGarage();
    if (id === 'menu-settings') this.refreshSettings();
    if (id === 'menu-event') this.refreshEvent();
    this._syncNavSelection();
  }

  hideAll() {
    for (const s of SCREENS) $(s)?.classList.remove('active');
    this.current = 'none';
  }

  get inMenu() { return this.current !== 'none' && this.current !== 'boot'; }

  /* ═══════════ boot ═══════════ */

  setProgress(frac, label) {
    const fill = $('load-fill');
    if (fill) fill.style.width = `${Math.round(clamp01(frac) * 100)}%`;
    const l = $('load-label');
    if (l && label) l.textContent = label;
  }

  tickBoot(dt) {
    this._tipTimer -= dt;
    if (this._tipTimer <= 0) {
      this._tipTimer = 4.5;
      const el = $('load-tip');
      if (el) {
        el.textContent = LOAD_TIPS[this._tipIndex % LOAD_TIPS.length];
        this._tipIndex++;
      }
    }
  }

  /* ═══════════ binding ═══════════ */

  _bind() {
    // generic navigation buttons
    document.querySelectorAll('[data-nav]').forEach((b) => {
      b.addEventListener('click', () => { this.audio.uiBack(); this.show(b.dataset.nav); });
    });

    // main menu
    $('main-nav')?.addEventListener('click', (e) => {
      const item = e.target.closest('.menu-item');
      if (!item) return;
      this.audio.uiSelect();
      this._mainAction(item.dataset.action);
    });

    // pause menu
    $('pause-nav')?.addEventListener('click', (e) => {
      const item = e.target.closest('.menu-item');
      if (!item) return;
      this.audio.uiSelect();
      this._pauseAction(item.dataset.action);
    });

    // hover sounds
    document.querySelectorAll('.menu-item, .btn').forEach((b) => {
      b.addEventListener('mouseenter', () => this.audio.uiHover());
    });

    // event setup
    document.querySelectorAll('[data-step]').forEach((b) => {
      b.addEventListener('click', () => {
        const [key, delta] = b.dataset.step.split(':');
        const d = parseInt(delta, 10);
        if (key === 'laps') this.eventOptions.laps = clamp(this.eventOptions.laps + d, 1, 12);
        if (key === 'rivals') this.eventOptions.rivals = clamp(this.eventOptions.rivals + d, 0, 9);
        this.audio.uiHover();
        this.refreshEvent();
      });
    });
    this._bindSegmented('opt-difficulty', (v) => { this.eventOptions.difficulty = parseFloat(v); });
    this._bindSegmented('opt-tod', (v) => { this.eventOptions.tod = parseFloat(v); this.hooks.onPreviewEnv?.(this.eventOptions); });
    this._bindSegmented('opt-weather', (v) => { this.eventOptions.weather = v; this.hooks.onPreviewEnv?.(this.eventOptions); });
    this._bindSegmented('opt-dyntime', (v) => { this.eventOptions.dyntime = parseFloat(v); });
    $('event-start')?.addEventListener('click', () => {
      this.audio.uiSelect();
      this.hooks.onStartEvent(this.eventOptions);
    });

    // garage
    $('garage-tabs')?.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      this.garageTab = b.dataset.tab;
      this.audio.uiHover();
      this._syncTabs('garage-tabs', this.garageTab);
    });
    $('car-rail')?.addEventListener('click', (e) => {
      const card = e.target.closest('.car-card');
      if (!card) return;
      this.selectedCar = card.dataset.car;
      this.audio.uiSelect();
      this.hooks.onCarPreview(this.selectedCar);
      this.refreshGarage();
    });
    $('garage-drive')?.addEventListener('click', () => {
      if (!store.owns(this.selectedCar)) { this.audio.uiError(); toast('Purchase this car first', 'bad'); return; }
      store.profile.currentCar = this.selectedCar;
      store.saveProfile();
      this.audio.uiSelect();
      this.hooks.onCarChosen(this.selectedCar);
    });
    $('garage-buy')?.addEventListener('click', () => {
      const car = CAR_BY_ID[this.selectedCar];
      if (store.owns(car.id)) return;
      if (store.buy(car.id, car.price)) {
        this.audio.purchase();
        toast(`${car.name} purchased`, 'good');
      } else {
        this.audio.uiError();
        toast('Not enough credits', 'bad');
      }
      this.refreshGarage();
      this.refreshCredits();
    });

    // paint
    $('paint-custom')?.addEventListener('input', (e) => this._setBuild({ paint: e.target.value }));
    $('stripe-colour')?.addEventListener('input', (e) => this._setBuild({ stripeColour: e.target.value }));
    this._bindSegmented('paint-finish', (v) => this._setBuild({ finish: v }));
    this._bindSegmented('paint-stripe', (v) => this._setBuild({ stripe: v }));
    this._bindSegmented('wheel-style', (v) => this._setBuild({ wheelStyle: parseInt(v, 10) }));
    $('rim-colour')?.addEventListener('input', (e) => this._setBuild({ rimColour: e.target.value }));
    $('caliper-colour')?.addEventListener('input', (e) => this._setBuild({ caliperColour: e.target.value }));
    this._bindSegmented('tyre-compound', (v) => { this._setBuild({ tyre: v }); this.refreshGarage(); });
    $('tune-reset')?.addEventListener('click', () => {
      const b = store.build(this.selectedCar);
      b.tune = defaultBuild().tune;
      store.saveProfile();
      this.audio.uiBack();
      this.refreshGarage();
      this.hooks.onBuildChange(this.selectedCar);
    });

    // settings
    $('settings-tabs')?.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      this.settingsTab = b.dataset.tab;
      this.audio.uiHover();
      this._syncTabs('settings-tabs', this.settingsTab);
    });
    $('settings-defaults')?.addEventListener('click', () => {
      store.resetSettings();
      this.audio.uiBack();
      this.refreshSettings();
      this.hooks.onSettingsChange('*');
      toast('Settings restored to defaults');
    });

    // results
    $('results-restart')?.addEventListener('click', () => { this.audio.uiSelect(); this.hooks.onRestart(); });
    $('results-menu')?.addEventListener('click', () => { this.audio.uiBack(); this.hooks.onQuitMain(); });
    $('results-roam')?.addEventListener('click', () => { this.audio.uiSelect(); this.hooks.onFreeRoam(); });
    $('exit-relaunch')?.addEventListener('click', () => window.location.reload());
  }

  _bindSegmented(id, cb) {
    const el = $(id);
    if (!el) return;
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      el.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      this.audio.uiHover();
      cb(b.dataset.val);
    });
  }

  _syncSegmented(id, value) {
    const el = $(id);
    if (!el) return;
    el.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.val === String(value)));
  }

  _syncTabs(containerId, active) {
    const el = $(containerId);
    if (!el) return;
    el.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.tab === active));
    const panel = el.parentElement;
    panel.querySelectorAll('[data-tabbody]').forEach((b) => b.classList.toggle('hidden', b.dataset.tabbody !== active));
  }

  _mainAction(action) {
    switch (action) {
      case 'freeroam': this.hooks.onFreeRoam(); break;
      case 'race': this.eventOptions.mode = 'race'; $('event-title').textContent = 'Race Event'; this.show('menu-event'); break;
      case 'timetrial': this.eventOptions.mode = 'timetrial'; $('event-title').textContent = 'Time Trial'; this.show('menu-event'); break;
      case 'garage': this.hooks.onCarPreview(this.selectedCar); this.show('menu-garage'); break;
      case 'settings': this.show('menu-settings'); break;
      case 'quit': this.hooks.onExit(); break;
      default: break;
    }
  }

  _pauseAction(action) {
    switch (action) {
      case 'resume': this.hooks.onResume(); break;
      case 'restart': this.hooks.onRestart(); break;
      case 'respawn': this.hooks.onRespawn(); break;
      case 'settings': this.show('menu-settings'); break;
      case 'garage': this.hooks.onCarPreview(this.selectedCar); this.show('menu-garage'); break;
      case 'quitmain': this.hooks.onQuitMain(); break;
      default: break;
    }
  }

  /* ═══════════ credits ═══════════ */

  refreshCredits() {
    const v = store.profile.credits.toLocaleString();
    const a = $('credits-value'), b = $('credits-value-2');
    if (a) a.textContent = v;
    if (b) b.textContent = v;
  }

  /* ═══════════ event setup ═══════════ */

  refreshEvent() {
    $('opt-laps').textContent = String(this.eventOptions.laps);
    $('opt-rivals').textContent = String(this.eventOptions.rivals);
    const isTT = this.eventOptions.mode === 'timetrial';
    $('opt-rivals').parentElement.parentElement.style.opacity = isTT ? 0.35 : 1;
    $('opt-rivals').parentElement.parentElement.style.pointerEvents = isTT ? 'none' : '';
    $('opt-difficulty').parentElement.style.opacity = isTT ? 0.35 : 1;
    this._syncSegmented('opt-difficulty', this.eventOptions.difficulty);
    this._syncSegmented('opt-tod', this.eventOptions.tod);
    this._syncSegmented('opt-weather', this.eventOptions.weather);
    this._syncSegmented('opt-dyntime', this.eventOptions.dyntime);
  }

  /* ═══════════ garage ═══════════ */

  _setBuild(patch) {
    const b = store.build(this.selectedCar);
    Object.assign(b, patch);
    store.saveProfile();
    this.hooks.onBuildChange(this.selectedCar);
    this._updatePerfReadout();
  }

  refreshGarage() {
    const car = CAR_BY_ID[this.selectedCar] || CARS[0];
    const build = store.build(car.id);
    const spec = resolveSpec(car, build);

    $('car-name').textContent = car.name;
    $('car-class').textContent = `${car.brand} · ${car.klass}`;
    this.refreshCredits();

    // rail
    const rail = $('car-rail');
    rail.innerHTML = CARS.map((c) => {
      const owned = store.owns(c.id);
      const cSpec = resolveSpec(c, store.build(c.id));
      const pi = performanceIndex(cSpec);
      return `<button class="car-card${c.id === car.id ? ' on' : ''}${owned ? ' owned' : ''}" data-car="${c.id}">
        <span class="cc-name">${c.name}</span>
        <span class="cc-meta"><span>${c.klass.split(' · ')[1] || ''}</span><span>PI ${pi}</span></span>
        <span class="cc-lock">${owned ? 'OWNED' : `${(c.price / 1000).toFixed(0)}k`}</span>
      </button>`;
    }).join('');

    // stats
    const bars = statBars(spec);
    $('stat-bars').innerHTML = bars.map((s) => `
      <div class="stat">
        <div class="stat-top"><em>${s.label}</em><b>${s.text}</b></div>
        <div class="stat-track"><div class="stat-fill" style="width:${Math.round(s.value * 100)}%"></div></div>
      </div>`).join('');
    $('car-blurb').textContent = car.blurb;

    // paint
    $('paint-swatches').innerHTML = PAINT_PRESETS.map((c) =>
      `<button class="swatch${c.toLowerCase() === build.paint.toLowerCase() ? ' on' : ''}" data-colour="${c}" style="background:${c}"></button>`).join('');
    $('paint-swatches').onclick = (e) => {
      const s = e.target.closest('.swatch');
      if (!s) return;
      this.audio.uiHover();
      $('paint-custom').value = s.dataset.colour;
      this._setBuild({ paint: s.dataset.colour });
      $('paint-swatches').querySelectorAll('.swatch').forEach((x) => x.classList.toggle('on', x === s));
    };
    $('paint-custom').value = build.paint;
    $('stripe-colour').value = build.stripeColour;
    this._syncSegmented('paint-finish', build.finish);
    this._syncSegmented('paint-stripe', build.stripe);

    // wheels
    this._syncSegmented('wheel-style', build.wheelStyle);
    $('rim-colour').value = build.rimColour;
    $('caliper-colour').value = build.caliperColour;
    this._syncSegmented('tyre-compound', build.tyre);
    $('tyre-hint').textContent = TYRE_COMPOUNDS[build.tyre].note;

    // tune
    $('tune-sliders').innerHTML = TUNE_DEFS.map((d) => `
      <div class="slider-row" data-tune="${d.id}">
        <div class="sr-top"><em>${d.name}</em><b data-tunev="${d.id}">${d.fmt(build.tune[d.id])}</b></div>
        <input type="range" min="0" max="1" step="0.01" value="${build.tune[d.id]}" data-tuneinput="${d.id}" />
        <div class="sr-note">${d.note}</div>
      </div>`).join('');
    $('tune-sliders').oninput = (e) => {
      const id = e.target.dataset.tuneinput;
      if (!id) return;
      const v = parseFloat(e.target.value);
      const b = store.build(this.selectedCar);
      b.tune[id] = v;
      store.saveProfile();
      const def = TUNE_DEFS.find((d) => d.id === id);
      document.querySelector(`[data-tunev="${id}"]`).textContent = def.fmt(v);
      this.hooks.onBuildChange(this.selectedCar);
      this._updatePerfReadout();
    };

    // upgrades
    $('upgrade-list').innerHTML = UPGRADE_DEFS.map((d) => {
      const lvl = build.upgrades[d.id] || 0;
      const maxed = lvl >= d.max;
      const cost = maxed ? 0 : upgradeCost(d, lvl, car);
      const afford = store.profile.credits >= cost;
      return `<div class="upg">
        <div class="upg-info">
          <div class="upg-name">${d.name} <span style="color:var(--accent);font-size:11px">${d.effect(lvl)}</span></div>
          <div class="upg-eff">${d.note}</div>
          <div class="pips">${Array.from({ length: d.max }, (_, i) => `<span class="pip${i < lvl ? ' on' : ''}"></span>`).join('')}</div>
        </div>
        <button class="upg-buy" data-upg="${d.id}" ${maxed || !afford ? 'disabled' : ''}>
          ${maxed ? 'MAX' : `${cost.toLocaleString()} cr`}
        </button>
      </div>`;
    }).join('');
    $('upgrade-list').onclick = (e) => {
      const b = e.target.closest('[data-upg]');
      if (!b || b.disabled) return;
      const def = UPGRADE_DEFS.find((d) => d.id === b.dataset.upg);
      const bd = store.build(this.selectedCar);
      const lvl = bd.upgrades[def.id] || 0;
      if (lvl >= def.max) return;
      const cost = upgradeCost(def, lvl, car);
      if (!store.spend(cost)) { this.audio.uiError(); toast('Not enough credits', 'bad'); return; }
      bd.upgrades[def.id] = lvl + 1;
      store.saveProfile();
      this.audio.purchase();
      toast(`${def.name} upgraded to level ${lvl + 1}`, 'good');
      this.refreshGarage();
      this.hooks.onBuildChange(this.selectedCar);
    };

    // buy / drive buttons
    const owned = store.owns(car.id);
    const buy = $('garage-buy');
    buy.textContent = owned ? 'Owned' : `Buy — ${car.price.toLocaleString()} cr`;
    buy.disabled = owned;
    $('garage-drive').disabled = !owned;

    this._syncTabs('garage-tabs', this.garageTab);
    this._updatePerfReadout();
  }

  _updatePerfReadout() {
    const car = CAR_BY_ID[this.selectedCar];
    const build = store.build(car.id);
    const spec = resolveSpec(car, build);
    const pi = performanceIndex(spec);
    const top = estimateTopSpeed(spec) * 3.6;
    const best = store.profile.bestLaps[car.id];
    $('perf-readout').innerHTML = `
      <span class="pi-badge">PI ${pi}</span>
      <span>Power <b>${Math.round(spec.powerKw * 1.341)} bhp</b></span>
      <span>Weight <b>${Math.round(spec.mass)} kg</b></span>
      <span>Top speed <b>${Math.round(top)} km/h</b></span>
      <span>Drivetrain <b>${car.drivetrain.toUpperCase()}</b></span>
      <span>Best lap <b>${best ? formatTime(best) : '—'}</b></span>`;
  }

  /* ═══════════ settings ═══════════ */

  refreshSettings() {
    const s = store.settings;
    const seg = (id, opts, value, onPick) => {
      const html = `<div class="segmented" id="${id}">${opts.map((o) =>
        `<button data-val="${o.v}" class="${String(o.v) === String(value) ? 'on' : ''}">${o.l}</button>`).join('')}</div>`;
      this._pending.push([id, onPick]);
      return html;
    };
    const slider = (id, label, value, min, max, step, fmt, onInput) => {
      this._pendingSliders.push([id, onInput, fmt]);
      return `<div class="slider-row">
        <div class="sr-top"><em>${label}</em><b id="${id}-v">${fmt(value)}</b></div>
        <input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${value}" />
      </div>`;
    };
    const field = (label, inner) => `<div class="field" style="margin-bottom:18px"><span>${label}</span>${inner}</div>`;
    const pct = (v) => `${Math.round(v * 100)}%`;

    this._pending = [];
    this._pendingSliders = [];

    /* graphics */
    $('set-graphics').innerHTML =
      field('Quality preset', seg('set-quality',
        Object.entries(QUALITY_PRESETS).map(([k, v]) => ({ v: k, l: v.label })), s.quality,
        (v) => { store.set('quality', v); store.set('renderScaleOverride', 0); store.set('shadowsOverride', null); this.hooks.onSettingsChange('quality'); this.refreshSettings(); }))
      + field('Render scale', seg('set-scale',
        [{ v: 0, l: 'Auto' }, { v: 0.6, l: '60%' }, { v: 0.8, l: '80%' }, { v: 1, l: '100%' }], s.renderScaleOverride,
        (v) => { store.set('renderScaleOverride', parseFloat(v)); this.hooks.onSettingsChange('renderScale'); }))
      + field('Shadows', seg('set-shadows',
        [{ v: 'auto', l: 'Preset' }, { v: 'on', l: 'On' }, { v: 'off', l: 'Off' }],
        s.shadowsOverride === null ? 'auto' : (s.shadowsOverride ? 'on' : 'off'),
        (v) => { store.set('shadowsOverride', v === 'auto' ? null : v === 'on'); this.hooks.onSettingsChange('shadows'); }))
      + slider('set-fov', 'Field of view', s.fov, 55, 105, 1, (v) => `${Math.round(v)}°`,
        (v) => { store.set('fov', v); this.hooks.onSettingsChange('fov'); })
      + slider('set-mblur', 'Motion blur', s.motionBlurAmount, 0, 1, 0.05, pct,
        (v) => { store.set('motionBlurAmount', v); this.hooks.onSettingsChange('post'); })
      + slider('set-bloom', 'Bloom', s.bloomAmount, 0, 1.2, 0.05, pct,
        (v) => { store.set('bloomAmount', v); this.hooks.onSettingsChange('post'); })
      + field('Performance overlay', seg('set-fps',
        [{ v: 'off', l: 'Off' }, { v: 'on', l: 'On' }], s.showFps ? 'on' : 'off',
        (v) => { store.set('showFps', v === 'on'); this.hooks.onSettingsChange('fps'); }));

    /* audio */
    $('set-audio').innerHTML =
      slider('set-vol-master', 'Master volume', s.masterVolume, 0, 1, 0.02, pct, (v) => { store.set('masterVolume', v); this.hooks.onSettingsChange('audio'); })
      + slider('set-vol-engine', 'Engine', s.engineVolume, 0, 1, 0.02, pct, (v) => { store.set('engineVolume', v); this.hooks.onSettingsChange('audio'); })
      + slider('set-vol-sfx', 'Effects', s.sfxVolume, 0, 1, 0.02, pct, (v) => { store.set('sfxVolume', v); this.hooks.onSettingsChange('audio'); })
      + slider('set-vol-amb', 'Ambience &amp; wind', s.ambienceVolume, 0, 1, 0.02, pct, (v) => { store.set('ambienceVolume', v); this.hooks.onSettingsChange('audio'); })
      + slider('set-vol-ui', 'Interface', s.uiVolume, 0, 1, 0.02, pct, (v) => { store.set('uiVolume', v); this.hooks.onSettingsChange('audio'); });

    /* gameplay */
    $('set-gameplay').innerHTML =
      field('Units', seg('set-units', [{ v: 'kmh', l: 'km/h' }, { v: 'mph', l: 'mph' }], s.units,
        (v) => { store.set('units', v); }))
      + field('Default camera', seg('set-cam', CAMERA_MODES.map((m, i) => ({ v: i, l: m.label })), s.cameraMode,
        (v) => { store.set('cameraMode', parseInt(v, 10)); this.hooks.onSettingsChange('camera'); }))
      + field('Traction control', seg('set-tcs', [{ v: 'on', l: 'On' }, { v: 'off', l: 'Off' }], s.assistTraction ? 'on' : 'off',
        (v) => { store.set('assistTraction', v === 'on'); this.hooks.onSettingsChange('assists'); }))
      + field('ABS', seg('set-abs', [{ v: 'on', l: 'On' }, { v: 'off', l: 'Off' }], s.assistAbs ? 'on' : 'off',
        (v) => { store.set('assistAbs', v === 'on'); this.hooks.onSettingsChange('assists'); }))
      + field('Stability control', seg('set-esc', [{ v: 'on', l: 'On' }, { v: 'off', l: 'Off' }], s.assistStability ? 'on' : 'off',
        (v) => { store.set('assistStability', v === 'on'); this.hooks.onSettingsChange('assists'); }))
      + field('Gearbox', seg('set-gearbox', [{ v: 'auto', l: 'Automatic' }, { v: 'manual', l: 'Manual' }], s.autoGearbox ? 'auto' : 'manual',
        (v) => { store.set('autoGearbox', v === 'auto'); this.hooks.onSettingsChange('assists'); }))
      + field('Damage', seg('set-damage', [{ v: 'on', l: 'On' }, { v: 'off', l: 'Off' }], s.damageEnabled ? 'on' : 'off',
        (v) => { store.set('damageEnabled', v === 'on'); this.hooks.onSettingsChange('damage'); }))
      + slider('set-shake', 'Camera shake', s.cameraShake, 0, 1.5, 0.05, pct, (v) => { store.set('cameraShake', v); });

    /* controls */
    $('set-controls').innerHTML =
      `<div class="sub">Keyboard &amp; controller</div>
       <div style="display:grid;grid-template-columns:1fr auto auto;gap:8px 18px;font-size:12.5px">
         <em style="color:var(--text-faint);font-style:normal;letter-spacing:.14em;font-size:10px">ACTION</em>
         <em style="color:var(--text-faint);font-style:normal;letter-spacing:.14em;font-size:10px">KEYBOARD</em>
         <em style="color:var(--text-faint);font-style:normal;letter-spacing:.14em;font-size:10px">PAD</em>
         ${KEY_BINDINGS.map((b) => `<span>${b.action}</span><span class="kbd">${b.keys}</span><span class="kbd">${b.pad}</span>`).join('')}
       </div>
       <div class="sub">Sensitivity</div>`
      + slider('set-steer-sens', 'Steering sensitivity', s.steerSensitivity, 0.4, 1.6, 0.05, (v) => `${v.toFixed(2)}×`,
        (v) => store.set('steerSensitivity', v))
      + slider('set-steer-lin', 'Steering linearity', s.steerLinearity, 1, 2.4, 0.05, (v) => `${v.toFixed(2)}`,
        (v) => store.set('steerLinearity', v))
      + slider('set-deadzone', 'Controller deadzone', s.padDeadzone, 0, 0.4, 0.01, pct,
        (v) => store.set('padDeadzone', v))
      + `<p class="hint" id="pad-detect">Controller: ${this._padName || 'none detected'} — plug one in and press a button.</p>`;

    for (const [id, cb] of this._pending) this._bindSegmented(id, cb);
    for (const [id, cb, fmt] of this._pendingSliders) {
      const el = $(id);
      if (!el) continue;
      el.addEventListener('input', () => {
        const v = parseFloat(el.value);
        const out = $(`${id}-v`);
        if (out) out.textContent = fmt(v);
        cb(v);
      });
    }
    this._syncTabs('settings-tabs', this.settingsTab);
  }

  setPadName(name) {
    this._padName = name;
    const el = $('pad-status');
    if (el) el.textContent = name ? `Controller: ${name}` : 'No controller';
    const d = $('pad-detect');
    if (d) d.textContent = `Controller: ${name || 'none detected'} — plug one in and press a button.`;
  }

  /* ═══════════ results ═══════════ */

  showResults({ rows, title, reward, splits, bestLap, isWin }) {
    $('results-title').textContent = title;
    $('results-reward').innerHTML = reward ? `+${reward.toLocaleString()} cr` : '';
    $('results-table').innerHTML =
      `<div class="rt-row head"><span>POS</span><span>DRIVER</span><span class="rt">TIME</span><span class="rg">BEST LAP</span></div>`
      + rows.map((r) => `<div class="rt-row p${r.place}${r.isPlayer ? ' me' : ''}">
          <span class="rp">${r.place}</span>
          <span><span class="st-dot" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${r.colour};margin-right:8px"></span>${r.name}</span>
          <span class="rt">${r.dnf ? 'DNF' : (r.place === 1 ? formatTime(r.time) : (r.gap != null ? `+${r.gap.toFixed(3)}` : formatTime(r.time)))}</span>
          <span class="rg">${r.bestLap != null ? formatTime(r.bestLap) : '—'}</span>
        </div>`).join('');
    $('results-splits').innerHTML = (splits || []).map((s, i) =>
      `<div class="split-chip${s.best ? ' best' : ''}"><em>Lap ${i + 1}</em>${formatTime(s.time)}</div>`).join('')
      + (bestLap != null ? `<div class="split-chip best"><em>Best</em>${formatTime(bestLap)}</div>` : '');
    this.show('menu-results');
    this.audio.fanfare(isWin);
  }

  /* ═══════════ keyboard / pad navigation ═══════════ */

  _navItems() {
    const screen = $(this.current);
    if (!screen) return [];
    return Array.from(screen.querySelectorAll('.menu-item, .btn:not(:disabled)'))
      .filter((el) => el.offsetParent !== null);
  }

  _syncNavSelection() {
    const items = this._navItems();
    items.forEach((el, i) => el.classList.toggle('sel', i === this.navIndex));
    if (items[this.navIndex]) items[this.navIndex].scrollIntoView({ block: 'nearest' });
  }

  handleNav(state) {
    if (!this.inMenu) return;
    const items = this._navItems();
    if (!items.length) return;
    let moved = false;
    if (state.navDown) { this.navIndex = (this.navIndex + 1) % items.length; moved = true; }
    if (state.navUp) { this.navIndex = (this.navIndex - 1 + items.length) % items.length; moved = true; }
    if (moved) { this.audio.uiHover(); this._syncNavSelection(); }
    if (state.confirm) {
      const el = items[this.navIndex];
      if (el) { el.click(); }
    }
  }
}
