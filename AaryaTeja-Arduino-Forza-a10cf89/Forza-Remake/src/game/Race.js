import * as THREE from 'three';
import { clamp01 } from '../core/MathUtils.js';

export const RACE_STATE = {
  IDLE: 'idle',
  COUNTDOWN: 'countdown',
  RUNNING: 'running',
  FINISHED: 'finished',
};

/**
 * Race director: grid, countdown, checkpoint validation, lap timing, live
 * placement and results. Progress is tracked as continuous arc length so a car
 * cannot skip a chunk of circuit or gain a lap by reversing over the line.
 */
export class Race {
  constructor(world, materials) {
    this.world = world;
    this.materials = materials;
    this.state = RACE_STATE.IDLE;
    this.entrants = [];
    this.laps = 3;
    this.mode = 'race';           // 'race' | 'timetrial' | 'freeroam'
    this.time = 0;
    this.countdown = 0;
    this.events = [];             // {type, ...} consumed by Game
    this.finishOrder = [];
    this.sectorCount = 3;

    this.gateGroup = new THREE.Group();
    this.gateGroup.name = 'checkpointGates';
    this._gates = [];
    this._buildGates();
  }

  _buildGates() {
    // Two slim glowing posts read as a gate without a translucent slab blocking the view.
    for (let i = 0; i < 2; i++) {
      const g = new THREE.Group();
      for (const s of [1, -1]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.20, 1, 10), this.materials.checkpointPost.clone());
        post.name = s > 0 ? 'postL' : 'postR';
        g.add(post);
      }
      g.visible = false;
      this._gates.push(g);
      this.gateGroup.add(g);
    }
  }

  /**
   * @param {Array} entries [{vehicle, model, ai, isPlayer, name, colour}]
   */
  setup(entries, { laps = 3, mode = 'race' } = {}) {
    this.mode = mode;
    this.laps = mode === 'freeroam' ? Infinity : laps;
    this.time = 0;
    this.finishOrder = [];
    this.events.length = 0;
    this.state = RACE_STATE.IDLE;

    const sp = this.world.spline;
    const cps = this.world.checkpoints;
    const spacing = sp.length / cps.length;

    this.entrants = entries.map((e, i) => ({
      ...e,
      idx: i,
      lap: 0,
      nextCp: 0,
      progress: 0,
      lastS: 0,
      startedTiming: false,
      lapStart: 0,
      lapTimes: [],
      bestLap: null,
      sectorTimes: [],
      currentSectors: [],
      finished: false,
      finishTime: null,
      position: i + 1,
      gapToLeader: 0,
      gapAhead: 0,
      lastCheckpointAt: 0,
      wrongWay: false,
      _spacing: spacing,
    }));

    // grid
    const slots = this.world.gridSlots(entries.length);
    this.entrants.forEach((e, i) => {
      const slot = slots[i];
      e.vehicle.placeAt(slot.x, slot.y, slot.z, slot.yaw);
      e.vehicle.repair();
      if (e.model) e.model.resetDamage();
      const q = sp.query(slot.x, slot.z, {});
      e.lastS = q.s;
      e.progress = sp.signedArc(sp.s[this.world.startIndex], q.s);
      e.gridProgress = e.progress;
    });

    this._updatePositions();
  }

  start(countdownSeconds = 3.2) {
    if (this.mode === 'freeroam') {
      this.state = RACE_STATE.RUNNING;
      this.time = 0;
      return;
    }
    this.state = RACE_STATE.COUNTDOWN;
    this.countdown = countdownSeconds;
    this._lastBeep = Math.ceil(countdownSeconds);
    this.time = 0;
  }

  get allowDrive() {
    return this.state === RACE_STATE.RUNNING || this.state === RACE_STATE.FINISHED || this.mode === 'freeroam';
  }

  get player() { return this.entrants.find((e) => e.isPlayer) || null; }

  update(dt) {
    if (this.state === RACE_STATE.COUNTDOWN) {
      this.countdown -= dt;
      const n = Math.ceil(this.countdown);
      if (n < this._lastBeep) {
        this._lastBeep = n;
        if (n > 0) this.events.push({ type: 'countdown', value: n });
      }
      if (this.countdown <= 0) {
        this.state = RACE_STATE.RUNNING;
        this.time = 0;
        this.events.push({ type: 'go' });
        for (const e of this.entrants) {
          e.startedTiming = true;
          e.lapStart = 0;
          e.currentSectors = [];
        }
      }
      return;
    }

    if (this.state !== RACE_STATE.RUNNING && this.state !== RACE_STATE.FINISHED) return;
    this.time += dt;

    const sp = this.world.spline;
    for (const e of this.entrants) {
      if (!e.vehicle.isAlive) continue;
      const q = sp.query(e.vehicle.position.x, e.vehicle.position.z, {});
      let ds = sp.signedArc(e.lastS, q.s);
      if (Math.abs(ds) > sp.length * 0.4) ds = 0;    // teleport/respawn guard
      e.progress += ds;
      e.lastS = q.s;

      const heading = e.vehicle.forward.x * sp.tx[q.index] + e.vehicle.forward.z * sp.tz[q.index];
      e.wrongWay = heading < -0.35 && Math.abs(e.vehicle.telemetry.speed) > 4;
      e.trackDist = q.dist;
      e.halfWidth = q.halfWidth;

      if (this.mode === 'freeroam' || e.finished) continue;
      this._checkProgress(e, q);
    }

    this._updatePositions();
    this._updateGates();

    if (this.mode !== 'freeroam' && this.state === RACE_STATE.RUNNING) {
      const human = this.player;
      const everyoneDone = this.entrants.every((e) => e.finished);
      if ((human && human.finished) || everyoneDone) {
        this.state = RACE_STATE.FINISHED;
        this.finishTimer = 0;
        this.events.push({ type: 'raceover' });
      }
    }
  }

  _checkProgress(e, q) {
    const cps = this.world.checkpoints;
    const n = cps.length;
    const spacing = e._spacing;

    // absolute progress needed for the next checkpoint
    let guard = 0;
    while (guard++ < n * 2) {
      const targetProgress = e.lap * this.world.spline.length + e.nextCp * spacing;
      if (e.progress < targetProgress) break;

      // must be somewhere on the circuit corridor to count
      if (q.dist > q.halfWidth + 40) break;

      const isLine = e.nextCp === 0 && e.lap > 0;
      e.nextCp++;
      e.lastCheckpointAt = this.time;

      if (e.nextCp % Math.round(n / this.sectorCount) === 0 && e.nextCp < n) {
        e.currentSectors.push(this.time - e.lapStart);
      }

      if (e.nextCp >= n) {
        e.nextCp = 0;
        e.lap++;
        const lapTime = this.time - e.lapStart;
        e.lapStart = this.time;
        e.lapTimes.push(lapTime);
        e.currentSectors.push(lapTime);
        e.sectorTimes = e.currentSectors.slice();
        e.currentSectors = [];
        if (e.bestLap == null || lapTime < e.bestLap) {
          e.bestLap = lapTime;
          if (e.isPlayer) this.events.push({ type: 'bestlap', time: lapTime });
        }
        this.events.push({ type: 'lap', entrant: e, lap: e.lap, time: lapTime });

        if (e.lap >= this.laps) {
          e.finished = true;
          e.finishTime = this.time;
          this.finishOrder.push(e);
          this.events.push({ type: 'finish', entrant: e, place: this.finishOrder.length });
          break;
        }
      } else if (e.isPlayer) {
        this.events.push({ type: 'checkpoint', index: e.nextCp, total: n });
      }
      void isLine;
    }
  }

  _updatePositions() {
    const sorted = [...this.entrants].sort((a, b) => {
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return b.progress - a.progress;
    });
    sorted.forEach((e, i) => { e.position = i + 1; });
    this.standings = sorted;

    const leader = sorted[0];
    if (!leader) return;
    for (let i = 0; i < sorted.length; i++) {
      const e = sorted[i];
      const gapDist = leader.progress - e.progress;
      const speed = Math.max(Math.abs(e.vehicle.telemetry.speed), 8);
      e.gapToLeader = e.finished && leader.finished ? e.finishTime - leader.finishTime : gapDist / speed;
      if (i > 0) {
        const ahead = sorted[i - 1];
        e.gapAhead = (ahead.progress - e.progress) / speed;
      } else e.gapAhead = 0;
    }
  }

  /** Show the player's next few checkpoints as gates. */
  _updateGates() {
    const p = this.player;
    if (!p || this.mode === 'freeroam' || p.finished) {
      for (const g of this._gates) g.visible = false;
      return;
    }
    const cps = this.world.checkpoints;
    for (let k = 0; k < this._gates.length; k++) {
      const g = this._gates[k];
      const cp = cps[(p.nextCp + k) % cps.length];
      const dist = Math.hypot(cp.position.x - p.vehicle.position.x, cp.position.z - p.vehicle.position.z);
      if (dist > 420) { g.visible = false; continue; }
      g.visible = true;
      const h = 5.5;
      g.position.copy(cp.position);
      // keep the posts upright regardless of road pitch
      g.quaternion.setFromEuler(new THREE.Euler(0, Math.atan2(cp.forward.x, cp.forward.z), 0));
      const fade = clamp01(1 - dist / 420) * (k === 0 ? 1 : 0.45);
      for (const s of [1, -1]) {
        const post = g.getObjectByName(s > 0 ? 'postL' : 'postR');
        post.scale.set(1, h, 1);
        post.position.set(s * cp.halfWidth, h / 2, 0);
        post.material.emissiveIntensity = (k === 0 ? 5.0 : 1.6) * fade;
        post.material.color.set(cp.isFinish ? 0x2a2410 : 0x0f2a24);
        post.material.emissive.set(cp.isFinish ? 0xffc94a : 0x29e0a8);
      }
    }
  }

  /** Distance in metres to the player's next checkpoint. */
  distanceToNextCheckpoint() {
    const p = this.player;
    if (!p) return 0;
    const cp = this.world.checkpoints[p.nextCp % this.world.checkpoints.length];
    return Math.hypot(cp.position.x - p.vehicle.position.x, cp.position.z - p.vehicle.position.z);
  }

  results() {
    const list = [...this.entrants].sort((a, b) => {
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return b.progress - a.progress;
    });
    const winner = list[0];
    return list.map((e, i) => ({
      place: i + 1,
      name: e.name,
      isPlayer: e.isPlayer,
      colour: e.colour,
      time: e.finishTime,
      bestLap: e.bestLap,
      laps: e.lap,
      dnf: !e.finished,
      gap: e.finishTime != null && winner.finishTime != null ? e.finishTime - winner.finishTime : null,
    }));
  }

  reset() {
    this.state = RACE_STATE.IDLE;
    this.events.length = 0;
    this.finishOrder = [];
    for (const g of this._gates) g.visible = false;
  }
}
