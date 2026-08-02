import * as THREE from 'three';
import { store } from '../core/Settings.js';
import { input } from '../core/Input.js';
import { clamp, clamp01, damp, formatTime } from '../core/MathUtils.js';
import { initPhysics, PhysicsWorld } from '../physics/Physics.js';
import { Vehicle } from '../physics/Vehicle.js';
import { RenderPipeline } from '../render/Renderer.js';
import { MaterialLibrary } from '../render/Materials.js';
import { Environment } from '../render/Environment.js';
import { CarModel } from '../render/CarModel.js';
import { SkidMarks, Particles, PARTICLE } from '../render/Effects.js';
import { WorldModel } from '../world/World.js';
import { TrackSpline } from '../world/TrackSpline.js';
import { CameraDirector } from './Cameras.js';
import { Race } from './Race.js';
import { AIDriver, aiName } from './AIDriver.js';
import { Showroom } from './Showroom.js';
import { HUD, toast } from '../ui/HUD.js';
import { UI } from '../ui/UI.js';
import { audio } from '../audio/AudioEngine.js';
import { CARS, CAR_BY_ID, resolveSpec, performanceIndex } from '../data/cars.js';
import { TRACK_NAME } from '../data/track.js';

const STATE = { BOOT: 'boot', MENU: 'menu', DRIVING: 'driving', PAUSED: 'paused', RESULTS: 'results' };

const RIVAL_COLOURS = [
  '#1c8ae8', '#18b26b', '#f25c05', '#8c3fd6', '#e8dfd0', '#d64ba0',
  '#f2b705', '#00e0c6', '#b8112a',
];

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

export class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.state = STATE.BOOT;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(74, 1, 0.28, 6000);
    this.entrantModels = [];
    this.vehicles = [];
    this.drivers = [];
    this.timer = new THREE.Timer();
    this.elapsed = 0;
    this.duck = 0;
    this._impactQueue = [];
    this._q = {};
    this._lastAirborne = false;
    this._prevGear = 1;
    this._fpsEl = null;
  }

  /* ═══════════════════════════ boot ═══════════════════════════ */

  async boot() {
    const mark = { t: performance.now(), start: performance.now(), log: {} };
    const lap = (name) => { const n = performance.now(); mark.log[name] = Math.round(n - mark.t); mark.t = n; };

    this.pipeline = new RenderPipeline(this.canvas);
    lap('renderer');
    this.materials = new MaterialLibrary(this.pipeline.renderer);
    lap('textures');

    this.ui = new UI(audio, {
      onFreeRoam: () => this.startSession('freeroam'),
      onStartEvent: (opts) => this.startSession(opts.mode, opts),
      onCarPreview: (id) => this.previewCar(id),
      onCarChosen: (id) => this.chooseCar(id),
      onBuildChange: (id) => this.rebuildCar(id),
      onSettingsChange: (k) => this.applySettings(k),
      onPreviewEnv: (o) => this.previewEnvironment(o),
      onResume: () => this.resume(),
      onRestart: () => this.restart(),
      onRespawn: () => { this.respawnPlayer(); this.resume(); },
      onQuitMain: () => this.toMenu(),
      onExit: () => this.exit(),
    });
    this.hud = new HUD();

    // run the frame loop from here on so the boot screen animates while we build
    this.start();
    this.ui.tickBoot(0);
    this.ui.setProgress(0.02, 'Starting engine');
    await frame();

    this.ui.setProgress(0.05, 'Loading physics core');
    await initPhysics();
    this.physics = new PhysicsWorld({ fixedStep: 1 / 120, maxSubSteps: 5 });
    this.physics.onContact((a, b, mag, e) => this._onContact(a, b, mag, e));

    lap('physics');
    this.env = new Environment(this.scene, this.pipeline.renderer, this.materials);
    lap('environment');
    this.showroom = new Showroom(this.materials, this.pipeline.renderer);
    this.showroom.buildStudioEnvironment();
    lap('showroom');

    this.world = new WorldModel();
    await this.world.build(this.physics, this.materials, store.gfx(), (f, label) => {
      this.ui.setProgress(0.08 + f * 0.86, label);
    });
    this.scene.add(this.world.root);
    lap('world');

    this.ui.setProgress(0.96, 'Preparing effects');
    await frame();

    this.race = new Race(this.world, this.materials);
    this.scene.add(this.race.gateGroup);

    this.skid = new SkidMarks(this.materials.skid);
    this.scene.add(this.skid.mesh);
    this.particles = new Particles(this.materials.smokeSprite, this.materials.softSprite);
    this.scene.add(this.particles.group);

    this.cameras = new CameraDirector(this.camera, this.physics);
    this.cameras.setMode(store.settings.cameraMode);

    this.hud.setWorld(this.world);

    // first environment bake for reflections
    this.env.setTimeOfDay(13, true);
    this.env.setWeather('clear', true);
    this.env.update(0.016, new THREE.Vector3(0, 20, 0));
    lap('skyProbe');

    this.applySettings('*');
    this.onResize();
    window.addEventListener('resize', () => this.onResize());

    window.addEventListener('apex:padchange', (e) => {
      this.ui.setPadName(e.detail.connected ? e.detail.name : '');
      if (e.detail.connected) toast(`Controller connected: ${e.detail.name}`, 'good');
    });

    input.attach();
    const kick = () => { audio.resume(); audio.applyVolumes(this._volumes()); };
    window.addEventListener('pointerdown', kick, { once: true });
    window.addEventListener('keydown', kick, { once: true });

    this.ui.setProgress(1, 'Ready');
    await frame();

    this.previewCar(store.profile.currentCar);
    lap('carPreview');
    this.toMenu(true);
    mark.log.totalWallClock = Math.round(performance.now() - mark.start);
    this.bootTimings = mark.log;
    console.debug('[apex] boot ms', JSON.stringify(mark.log));
  }

  _volumes() {
    const s = store.settings;
    return {
      master: s.masterVolume, engine: s.engineVolume, sfx: s.sfxVolume,
      ambience: s.ambienceVolume, ui: s.uiVolume,
    };
  }

  onResize() {
    this.pipeline.resize();
    const a = window.innerWidth / Math.max(1, window.innerHeight);
    this.camera.aspect = a;
    this.camera.updateProjectionMatrix();
    this.showroom.setAspect(a);
    this.particles.setPixelScale(this.pipeline.drawHeight || window.innerHeight);
  }

  applySettings(key) {
    const gfx = store.gfx();
    const s = store.settings;
    this.pipeline.setQuality(gfx, s);
    this.materials.applyQuality(gfx.anisotropy);
    this.env.setShadowMapSize(gfx.shadowMapSize);
    this.env.setShadowExtent(gfx.shadows ? 160 : 160);
    this.world?.setQuality(gfx);
    this.particles.intensity = gfx.particles;
    this.skid.enabled = gfx.skidMarks;
    audio.applyVolumes(this._volumes());
    this.camera.fov = s.fov;
    this.camera.updateProjectionMatrix();
    if (key === 'assists' || key === '*') this._applyAssists();
    if (key === 'camera') this.cameras.setMode(s.cameraMode);
    if (key === 'fps' || key === '*') this._toggleFpsOverlay(s.showFps);
    this.particles.setPixelScale(this.pipeline.drawHeight || window.innerHeight);
    this.env._envDirty = true;
  }

  _applyAssists() {
    const s = store.settings;
    for (const v of this.vehicles) {
      if (!v.isPlayer) continue;
      v.assists.tcs = s.assistTraction;
      v.assists.abs = s.assistAbs;
      v.assists.stability = s.assistStability;
      v.assists.autoGearbox = s.autoGearbox;
    }
  }

  _toggleFpsOverlay(on) {
    if (on && !this._fpsEl) {
      const el = document.createElement('div');
      el.style.cssText = 'position:fixed;top:8px;left:10px;z-index:80;font:600 11px/1.5 var(--mono),monospace;'
        + 'color:#8de8c4;background:rgba(6,9,13,.7);padding:6px 9px;border-radius:8px;pointer-events:none;white-space:pre';
      document.body.appendChild(el);
      this._fpsEl = el;
    } else if (!on && this._fpsEl) {
      this._fpsEl.remove();
      this._fpsEl = null;
    }
  }

  /* ═══════════════════════════ car preview / garage ═══════════════════════════ */

  previewCar(id) {
    const car = CAR_BY_ID[id] || CARS[0];
    const build = store.build(car.id);
    this.showroom.setCar(car, build);
  }

  rebuildCar(id) {
    const car = CAR_BY_ID[id];
    const build = store.build(id);
    if (this.showroom.currentCar?.id === id) {
      // ride height changes the model's ground offset, so rebuild for that one case
      const need = Math.abs((this.showroom.model?.groundLocalY ?? 0) - (-0.30 - (0.06 + build.tune.rideHeight * 0.10))) > 1e-4;
      if (need) this.showroom.setCar(car, build);
      else this.showroom.applyBuild(build);
    }
    // live-apply to the player's car if we're driving it
    const pe = this.race?.player;
    if (pe && pe.vehicle.car.id === id) {
      const spec = resolveSpec(car, build);
      pe.vehicle.applySpec(spec);
      pe.model.setPaint(build.paint, build.finish, build.stripe, build.stripeColour);
      pe.model.setWheels(build.wheelStyle, build.rimColour, build.caliperColour);
    }
  }

  chooseCar(id) {
    store.profile.currentCar = id;
    store.saveProfile();
    if (this.state === STATE.PAUSED || this.race?.entrants.length) {
      this._teardownSession();
    }
    this.ui.show('menu-main');
    toast(`${CAR_BY_ID[id].name} selected`, 'good');
  }

  previewEnvironment(opts) {
    this.env.setTimeOfDay(opts.tod, true);
    this.env.setWeather(opts.weather, true);
  }

  /* ═══════════════════════════ session lifecycle ═══════════════════════════ */

  _teardownSession() {
    for (const e of this.race?.entrants || []) {
      if (e.model) { this.scene.remove(e.model.group); e.model.dispose(); }
      if (e.vehicle) e.vehicle.destroy();
    }
    if (this.race) { this.race.entrants = []; this.race.reset(); }
    this.vehicles = [];
    this.drivers = [];
    this.skid.clear();
    this.particles.clear();
  }

  startSession(mode, opts = {}) {
    const options = {
      laps: opts.laps ?? 3,
      rivals: mode === 'timetrial' ? 0 : mode === 'freeroam' ? 3 : (opts.rivals ?? 6),
      difficulty: opts.difficulty ?? 0.985,
      tod: opts.tod ?? 13,
      weather: opts.weather ?? 'clear',
      dyntime: opts.dyntime ?? 0,
    };
    this.sessionOptions = { mode, ...options };

    this._teardownSession();

    this.env.setTimeOfDay(options.tod, true);
    this.env.setWeather(options.weather, true);
    this.env.timeScale = options.dyntime;

    const playerId = store.profile.currentCar;
    if (!store.owns(playerId)) store.profile.currentCar = store.profile.owned[0];

    const entries = [];
    // player
    const pCar = CAR_BY_ID[store.profile.currentCar];
    const pBuild = store.build(pCar.id);
    const pSpec = resolveSpec(pCar, pBuild);
    const pVehicle = new Vehicle(this.physics, pSpec, this.world, { isPlayer: true, name: 'You', colour: pBuild.paint });
    const pModel = new CarModel(pCar, JSON.parse(JSON.stringify(pBuild)), this.materials, { groundLocalY: pVehicle.groundLocalY });
    pModel.attachHeadlightBeams();
    this.scene.add(pModel.group);
    entries.push({ vehicle: pVehicle, model: pModel, isPlayer: true, name: 'You', colour: pBuild.paint, ai: null });
    this.vehicles.push(pVehicle);

    // rivals — matched roughly to the player's performance index
    const playerPI = performanceIndex(pSpec);
    const pool = [...CARS].sort((a, b) =>
      Math.abs(performanceIndex(resolveSpec(a, defaultRivalBuild(a, 0))) - playerPI)
      - Math.abs(performanceIndex(resolveSpec(b, defaultRivalBuild(b, 0))) - playerPI));

    for (let i = 0; i < options.rivals; i++) {
      const car = pool[i % Math.min(pool.length, 3)];
      const build = defaultRivalBuild(car, i);
      const spec = resolveSpec(car, build);
      const colour = RIVAL_COLOURS[i % RIVAL_COLOURS.length];
      build.paint = colour;
      const v = new Vehicle(this.physics, spec, this.world, { isPlayer: false, name: aiName(i), colour });
      const model = new CarModel(car, build, this.materials, { groundLocalY: v.groundLocalY });
      this.scene.add(model.group);
      const skill = options.difficulty * (0.965 + ((i * 37) % 9) / 130) * (mode === 'freeroam' ? 0.72 : 1);
      const ai = new AIDriver(v, this.world, { skill, aggression: 0.45 + ((i * 53) % 10) / 18, seed: i + 3 });
      entries.push({ vehicle: v, model, isPlayer: false, name: aiName(i), colour, ai });
      this.vehicles.push(v);
      this.drivers.push(ai);
    }

    this.race.setup(entries, { laps: options.laps, mode });
    this._applyAssists();

    // vehicles are stepped inside each physics substep
    if (this._unhook) this._unhook();
    this._unhook = this.physics.onPreStep((h) => {
      for (const v of this.vehicles) if (v.isAlive) v.update(h);
    });

    for (const v of this.vehicles) v.sample(1 / 60);

    this.state = STATE.DRIVING;
    this.ui.hideAll();
    this.hud.show(true);
    this.cameras.initialised = false;
    this.cameras.photo = false;
    this._prevGear = 1;

    if (mode === 'freeroam') {
      this.race.start();
      this.hud.showBanner(`FREE ROAM<small>${TRACK_NAME} · drive anywhere</small>`, 3.0);
      this.hud.showHint('<b>WASD</b> drive · <b>C</b> camera · <b>R</b> reset · <b>Esc</b> pause', 7);
    } else {
      for (const v of this.vehicles) v.launchLock = true;
      this.race.start(3.4);
      this.hud.showHint(mode === 'timetrial'
        ? `<b>${options.laps}</b> lap time trial — chase your best`
        : `<b>${options.laps}</b> laps · <b>${options.rivals}</b> rivals`, 5);
    }
  }

  restart() {
    if (!this.sessionOptions) { this.toMenu(); return; }
    const o = this.sessionOptions;
    this.startSession(o.mode, o);
  }

  toMenu(silent = false) {
    this._teardownSession();
    this.state = STATE.MENU;
    this.hud.show(false);
    this.ui.show('menu-main');
    this.ui.refreshCredits();
    if (!silent) audio.uiBack();
    this.env.timeScale = 0;
    audio.setDuck(1);
  }

  pause() {
    if (this.state !== STATE.DRIVING) return;
    this.state = STATE.PAUSED;
    this.ui.show('menu-pause');
    this.hud.show(false);
    audio.uiBack();
  }

  resume() {
    if (this.state !== STATE.PAUSED) return;
    this.state = STATE.DRIVING;
    this.ui.hideAll();
    this.hud.show(true);
    this.timer.update();
    audio.uiSelect();
  }

  respawnPlayer() {
    const pe = this.race?.player;
    if (!pe) return;
    const v = pe.vehicle;
    const p = this.world.respawnPoint(v.position.x, v.position.z, 4);
    v.placeAt(p.x, p.y, p.z, p.yaw);
    v.stuckTimer = 0;
    for (let i = 0; i < 4; i++) this.skid.breakStrip(`p${i}`);
    this.hud.showHint('Reset to track', 1.6);
  }

  exit() {
    this._teardownSession();
    this.state = STATE.MENU;
    this.hud.show(false);
    this.ui.show('menu-exit');
    audio.setMuted(true);
    store.saveProfile();
  }

  /* ═══════════════════════════ collisions ═══════════════════════════ */

  _onContact(a, b, magnitude) {
    const av = a && a.isAlive ? a : null;
    const bv = b && b.isAlive ? b : null;
    if (!av && !bv) return;
    const mid = av && bv
      ? _v.copy(av.position).add(bv.position).multiplyScalar(0.5).clone()
      : (av || bv).position.clone();

    for (const v of [av, bv]) {
      if (!v) continue;
      const strength = store.settings.damageEnabled ? v.registerImpact(magnitude, mid) : normalised(magnitude, v);
      if (strength > 0.04) this._impactQueue.push({ vehicle: v, strength, point: mid });
    }
  }

  _flushImpacts() {
    const pe = this.race?.player;
    for (const imp of this._impactQueue) {
      const isPlayer = imp.vehicle.isPlayer;
      const dist = pe ? imp.point.distanceTo(pe.vehicle.position) : 0;
      const atten = isPlayer ? 1 : clamp01(1 - dist / 70);
      if (atten > 0.03) {
        if (imp.strength > 0.16) audio.collision(imp.strength * atten);
        else audio.scrape(imp.strength * atten);
      }
      if (isPlayer) {
        this.cameras.addShake(clamp(imp.strength * 1.6, 0, 1.2));
        if (store.settings.damageEnabled && imp.strength > 0.10) {
          const model = pe.model;
          model.applyDent(imp.point, imp.strength);
        }
      }
      // sparks and debris
      const n = Math.round(clamp(imp.strength * 26, 1, 22) * this.particles.intensity);
      for (let i = 0; i < n; i++) {
        const sp = 3 + Math.random() * 9 * imp.strength * 4;
        this.particles.emit(PARTICLE.SPARK,
          imp.point.x, imp.point.y, imp.point.z,
          (Math.random() - 0.5) * sp, Math.random() * sp * 0.6, (Math.random() - 0.5) * sp, 1);
      }
    }
    this._impactQueue.length = 0;
  }

  /* ═══════════════════════════ main loop ═══════════════════════════ */

  start() {
    const loop = () => {
      requestAnimationFrame(loop);
      this.timer.update();
      const dt = Math.min(this.timer.getDelta(), 0.05);
      this.frame(dt);
    };
    requestAnimationFrame(loop);
  }

  frame(dt) {
    this.elapsed += dt;
    input.update(dt);

    if (this.state === STATE.BOOT) {
      this.ui.tickBoot(dt);
      return;
    }

    const driving = this.state === STATE.DRIVING;
    const inMenus = !driving;

    // menu navigation
    if (inMenus) {
      this.ui.handleNav(input.state);
      if (input.state.back && this.state === STATE.PAUSED) this.resume();
      else if (input.state.back && this.ui.current === 'menu-settings') this.ui.show(this.ui.prevScreen);
      else if (input.state.back && (this.ui.current === 'menu-event' || this.ui.current === 'menu-garage')) this.ui.show('menu-main');
    } else if (input.state.pause) {
      this.pause();
    }

    this.duck = damp(this.duck, inMenus ? 1 : 0, 6, dt);
    audio.setDuck(this.duck);

    if (driving) this._updateDriving(dt);

    // environment always ticks so the showroom reflections stay live
    const camPos = driving ? this.camera.position : new THREE.Vector3(0, 30, 0);
    this.env.update(dt, camPos);
    this.pipeline.setExposure(this.env.exposure ?? 0.5);
    this.world.wetness = this.env.wetness;

    // render
    if (driving) {
      this.pipeline.render(this.scene, this.camera, dt);
    } else {
      const focus = this.ui.current === 'menu-garage' ? 1 : 0;
      this.showroom.update(dt, focus);
      this.pipeline.render(this.showroom.scene, this.showroom.camera, dt);
    }

    if (this._fpsEl) {
      const s = this.pipeline.stats;
      this._fpsEl.textContent =
        `${s.fps.toFixed(0)} fps\n${s.calls} draws\n${(s.triangles / 1000).toFixed(0)}k tris`
        + (driving ? `\n${this.physics.stepCount % 100000} steps` : '');
    }
  }

  _updateDriving(dt) {
    const race = this.race;
    const pe = race.player;
    if (!pe) return;
    const pv = pe.vehicle;
    const s = store.settings;

    /* ── player input ── */
    const allow = race.allowDrive;
    for (const v of this.vehicles) v.launchLock = !allow;

    const st = input.state;
    pv.setControls({
      throttle: st.throttle,
      brake: st.brake,
      steer: st.steer,
      handbrake: st.handbrake,
      shiftUp: st.shiftUp && !s.autoGearbox,
      shiftDown: st.shiftDown && !s.autoGearbox,
    });
    if (st.camera) {
      const m = this.cameras.cycle();
      store.set('cameraMode', this.cameras.modeIndex);
      this.hud.showHint(`Camera: <b>${m.label}</b>`, 1.6);
    }
    if (st.photo) {
      this.cameras.photo = !this.cameras.photo;
      this.hud.show(!this.cameras.photo);
      this.hud.showHint(this.cameras.photo ? 'Photo mode — drag to orbit, scroll to zoom, <b>F</b> to exit' : '', 3);
    }
    if (st.reset) this.respawnPlayer();
    if (st.headlights) {
      pe.model.headlightsOn = !pe.model.headlightsOn;
      this.hud.showHint(`Headlights <b>${pe.model.headlightsOn ? 'on' : 'off'}</b>`, 1.4);
    }
    this.cameras.lookBack = st.lookBack;
    audio.horn(st.horn);

    /* ── AI ── */
    for (const d of this.drivers) {
      d.update(dt, this.vehicles, { allowDrive: allow });
      if (d.needsRescue) {
        const p = this.world.respawnPoint(d.v.position.x, d.v.position.z, 6);
        d.v.placeAt(p.x, p.y, p.z, p.yaw);
        d.v.damage = Math.min(d.v.damage, 0.5);
        d.clearRescue();
      }
    }

    /* ── physics ── */
    this.physics.step(dt);
    for (const v of this.vehicles) if (v.isAlive) v.sample(dt);
    this._flushImpacts();

    /* ── race ── */
    race.update(dt);
    this._consumeRaceEvents();

    /* ── models ── */
    const night = this.env.nightFactor;
    for (const e of race.entrants) {
      if (!e.vehicle.isAlive) continue;
      e.model.update(e.vehicle, dt, night);
    }

    /* ── effects ── */
    this._updateEffects(dt, pe);

    /* ── camera ── */
    this.cameras.update(dt, pv, pe.model, {
      fov: s.fov,
      shakeScale: s.cameraShake,
      world: this.world,
    });

    /* ── audio ── */
    const q = this.world.spline.query(pv.position.x, pv.position.z, this._q);
    const inTunnel = !q.far && (this.world.spline.flags[q.index] & TrackSpline.FLAG_TUNNEL) !== 0 && q.dist < 22;
    const mode = this.cameras.mode.id;
    audio.update(dt, {
      vehicle: pv,
      rivals: this.vehicles.filter((v) => !v.isPlayer),
      weather: this.env.weather,
      listenerPos: this.camera.position,
      listenerRight: _v2.setFromMatrixColumn(this.camera.matrixWorld, 0),
      interior: mode === 'cockpit',
      tunnel: inTunnel,
    });
    // gearshift + backfire cues
    const t = pv.telemetry;
    if (pv.gear !== this._prevGear) {
      audio.gearShift(pv.gear > this._prevGear);
      if (pv.gear < this._prevGear && t.speedKmh > 40) audio.backfire();
      this._prevGear = pv.gear;
    }
    if (t.limiter && Math.random() < 0.35) audio.backfire();
    if (this._lastThrottle > 0.6 && t.throttle < 0.15 && pv.boost > 0.35) audio.blowOff();
    this._lastThrottle = t.throttle;

    // landing thump
    if (this._lastAirborne && !t.airborne) {
      const impact = clamp01(Math.abs(this._airborneVy) / 14);
      if (impact > 0.08) { audio.landing(impact); this.cameras.addShake(impact * 0.7); }
    }
    this._lastAirborne = t.airborne;
    if (t.airborne) this._airborneVy = pv.velocity.y;

    // auto headlights
    if (night > 0.42 && !pe.model.headlightsOn) pe.model.headlightsOn = true;
    if (night < 0.22 && pe.model.headlightsOn && !this._manualLights) pe.model.headlightsOn = false;

    // stuck prompt
    if (t.stuck) this.hud.showHint('Press <b>R</b> to reset to the track', 1.5);

    // free-roam distance tracking
    store.profile.distanceKm += (Math.abs(t.speed) * dt) / 1000;

    /* ── HUD ── */
    this.hud.update(dt, {
      vehicle: pv,
      race,
      entrant: pe,
      units: s.units,
      assists: pv.assists,
      world: this.world,
    });
  }

  _consumeRaceEvents() {
    const race = this.race;
    for (const ev of race.events) {
      switch (ev.type) {
        case 'countdown':
          this.hud.showCountdown(String(ev.value));
          audio.countdownBeep(ev.value);
          break;
        case 'go':
          this.hud.showCountdown('GO', true);
          audio.goBeep();
          break;
        case 'checkpoint':
          this.hud.showCheckpoint(`CHECKPOINT ${ev.index}/${ev.total}`);
          audio.checkpoint();
          break;
        case 'lap': {
          if (!ev.entrant.isPlayer) break;
          const remaining = race.laps - ev.lap;
          audio.lapDone();
          if (remaining > 0) {
            this.hud.showBanner(`LAP ${ev.lap} — ${formatTime(ev.time)}<small>${remaining} to go</small>`, 2.4);
          }
          break;
        }
        case 'bestlap':
          this.hud.showCheckpoint(`PERSONAL BEST ${formatTime(ev.time)}`);
          break;
        case 'finish':
          if (ev.entrant.isPlayer) {
            this.hud.showBanner(`FINISH<small>P${ev.place} · ${formatTime(ev.entrant.finishTime)}</small>`, 3.2);
          }
          break;
        case 'raceover':
          this._finishTimer = 3.0;
          break;
        default: break;
      }
    }
    race.events.length = 0;

    if (this._finishTimer > 0) {
      this._finishTimer -= 1 / 60;
      if (this._finishTimer <= 0) this._showResults();
    }
  }

  _showResults() {
    const race = this.race;
    const rows = race.results();
    const pe = race.player;
    const place = rows.findIndex((r) => r.isPlayer) + 1;
    const isWin = place === 1;

    let reward = 0;
    if (race.mode === 'race') {
      const base = 5200 + race.laps * 1400;
      const positionBonus = Math.max(0, (rows.length - place + 1)) / rows.length;
      const diff = this.sessionOptions?.difficulty ?? 1;
      reward = Math.round(base * (0.45 + positionBonus * 0.9) * diff);
      store.profile.racesRun++;
      if (isWin) store.profile.racesWon++;
    } else if (race.mode === 'timetrial') {
      reward = Math.round(2600 + (pe?.bestLap ? Math.max(0, 260 - pe.bestLap) * 22 : 0));
    }
    if (reward > 0) store.award(reward);
    if (pe?.bestLap) store.recordLap(pe.vehicle.car.id, pe.bestLap);
    store.saveProfile();

    const splits = (pe?.lapTimes || []).map((time) => ({ time, best: time === pe.bestLap }));

    this.state = STATE.RESULTS;
    this.hud.show(false);
    this.ui.showResults({
      rows,
      title: race.mode === 'timetrial'
        ? 'Time Trial Complete'
        : (isWin ? 'Victory' : `Finished P${place}`),
      reward,
      splits,
      bestLap: pe?.bestLap,
      isWin,
    });
    this.ui.refreshCredits();
  }

  /* ═══════════════════════════ effects ═══════════════════════════ */

  _updateEffects(dt, pe) {
    const race = this.race;
    const pv = pe.vehicle;
    const wet = this.env.wetness;
    const rainy = this.env.weather === 'rain';
    const intensity = this.particles.intensity;

    // sort AI by distance so only nearby cars spend particle budget
    const nearby = race.entrants
      .filter((e) => e.vehicle.isAlive)
      .map((e) => ({ e, d: e.isPlayer ? 0 : e.vehicle.position.distanceTo(pv.position) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 4);

    for (const { e, d } of nearby) {
      const v = e.vehicle;
      const isPlayer = e.isPlayer;
      const budget = isPlayer ? 1 : clamp01(1 - d / 90) * 0.7;
      if (budget <= 0.02) continue;

      for (let i = 0; i < 4; i++) {
        const w = v.wheelState[i];
        const key = `${isPlayer ? 'p' : e.idx}${i}`;
        if (!w.contact) { this.skid.breakStrip(key); continue; }

        const speed = Math.abs(v.telemetry.speed);
        const onRoad = w.surface === 0;

        // tyre marks
        if (isPlayer || d < 55) {
          if (onRoad && w.screech > 0.42 && speed > 3.5) {
            _v.set(v.right.x, v.right.y, v.right.z);
            this.skid.addPoint(key, w.contactPoint, _v, v.car.body.wheelWidth * 0.92, clamp01(w.screech * 1.3));
          } else {
            this.skid.breakStrip(key);
          }
        }

        // smoke / dust / spray
        const emitChance = dt * 60;
        if (onRoad && w.screech > 0.55 && speed > 8 && Math.random() < emitChance * 0.45 * budget * intensity) {
          const up = 0.6 + Math.random() * 1.4;
          this.particles.emit(PARTICLE.SMOKE,
            w.contactPoint.x, w.contactPoint.y + 0.12, w.contactPoint.z,
            -v.velocity.x * 0.12 + (Math.random() - 0.5), up, -v.velocity.z * 0.12 + (Math.random() - 0.5),
            0.7 + w.screech * 0.8);
        }
        if (!onRoad && speed > 5 && Math.random() < emitChance * 0.55 * budget * intensity) {
          this.particles.emit(PARTICLE.DUST,
            w.contactPoint.x, w.contactPoint.y + 0.1, w.contactPoint.z,
            -v.velocity.x * 0.16 + (Math.random() - 0.5) * 2, 0.8 + Math.random() * 1.6, -v.velocity.z * 0.16 + (Math.random() - 0.5) * 2,
            0.7 + clamp01(speed / 30));
        }
        if (rainy && onRoad && speed > 9 && Math.random() < emitChance * 0.5 * budget * intensity) {
          this.particles.emit(PARTICLE.SPRAY,
            w.contactPoint.x, w.contactPoint.y + 0.15, w.contactPoint.z,
            -v.velocity.x * 0.30 + (Math.random() - 0.5) * 2, 1.2 + Math.random() * 2.2, -v.velocity.z * 0.30 + (Math.random() - 0.5) * 2,
            0.8);
        }
      }

      // engine smoke when badly damaged
      if (v.damage > 0.6 && Math.random() < dt * 24 * budget) {
        _v.copy(v.position).addScaledVector(v.forward, v.car.body.length * 0.36).addScaledVector(v.up, 0.35);
        this.particles.emit(PARTICLE.SMOKE, _v.x, _v.y, _v.z,
          (Math.random() - 0.5) * 1.2 + v.velocity.x * 0.2, 1.6 + Math.random(), (Math.random() - 0.5) * 1.2 + v.velocity.z * 0.2,
          0.9 + v.damage, [0.16, 0.16, 0.17]);
      }
    }

    this.skid.flush();
    this.particles.update(dt);
    void wet;
  }
}

function defaultRivalBuild(car, i) {
  const lvl = 2 + (i % 3);
  return {
    paint: RIVAL_COLOURS[i % RIVAL_COLOURS.length],
    finish: i % 3 === 0 ? 'metallic' : 'gloss',
    stripe: i % 4 === 0 ? 'dual' : 'none',
    stripeColour: '#0e1116',
    wheelStyle: i % 4,
    rimColour: i % 2 ? '#20242a' : '#d6dae2',
    caliperColour: '#e03a1a',
    tyre: 'sport',
    upgrades: { engine: lvl, gearbox: lvl, tyres: lvl, brakes: lvl, weight: Math.max(0, lvl - 1), aero: lvl },
    tune: {
      finalDrive: 1.0, downforce: 0.55, brakeBias: 0.6,
      rideHeight: 0.45, arbFront: 0.5, arbRear: 0.5, steerLock: 0.5,
    },
  };
}

function normalised(magnitude, v) {
  return clamp01(magnitude / (v.spec.mass * 260));
}

const frame = () => new Promise((resolve) => {
  let done = false;
  const finish = () => { if (!done) { done = true; resolve(); } };
  requestAnimationFrame(finish);
  setTimeout(finish, 32);
});
