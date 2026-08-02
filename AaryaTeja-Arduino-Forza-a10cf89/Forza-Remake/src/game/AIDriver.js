import * as THREE from 'three';
import { clamp, clamp01, lerp, smoothstep, damp, makeRng } from '../core/MathUtils.js';
import { estimateTopSpeed, REFERENCE_LAT_ACCEL } from '../data/cars.js';

const _target = new THREE.Vector3();
const _local = new THREE.Vector3();
const _tmp = new THREE.Vector3();

const NAMES = [
  'R. Vance', 'M. Okonkwo', 'L. Bergström', 'S. Nakamura', 'D. Ferreira',
  'K. Aaltonen', 'T. Moreau', 'A. Castellanos', 'J. Whitlock', 'N. Petrova',
  'C. Delacroix', 'H. Ishikawa',
];

export function aiName(i) { return NAMES[i % NAMES.length]; }

/**
 * Racing AI. Drives the same Vehicle class the player does — no scripted paths,
 * no rubber-banded teleporting. Pure pursuit on a pre-computed racing line, a
 * lookahead braking solver, and lateral negotiation with nearby cars.
 */
export class AIDriver {
  constructor(vehicle, world, opts = {}) {
    this.v = vehicle;
    this.world = world;
    this.skill = opts.skill ?? 1.0;              // scales cornering speed
    this.aggression = opts.aggression ?? 0.6;
    this.seed = opts.seed ?? 1;
    this.rng = makeRng(this.seed * 7919 + 13);

    this.enabled = true;
    this.launched = false;
    this.bias = 0;                                // lateral offset from the racing line
    this.biasTarget = 0;
    this.recovering = 0;
    this.reverseTimer = 0;
    this.stuckTime = 0;
    this.needsRescue = false;
    this._watchS = null;        // arc length at the last real forward progress
    this._noProgress = 0;
    this.mistakeTimer = 4 + this.rng() * 12;
    this.mistake = 0;
    this.blocked = null;

    // small per-driver personality
    this.preferredSide = this.rng() > 0.5 ? 1 : -1;
    this.brakePoint = 0.94 + (this.rng() - 0.5) * 0.07;
    this.throttleSmooth = 0.65 + this.rng() * 0.3;
    // The shared racing line is solved at a reference lateral acceleration; rescale
    // it to what this car's tyres can actually hold, and cap it at its real top speed.
    const latAccel = 9.81 * vehicle.spec.grip * 0.72;   // leave a margin below the tyre limit
    this.speedScale = Math.sqrt(latAccel / REFERENCE_LAT_ACCEL);
    this.topSpeed = estimateTopSpeed(vehicle.spec) * 1.02;

    this._q = {};
    this._throttle = 0;
    this._brake = 0;
    this._steer = 0;
  }

  /** Racing-line speed at an arc length, already scaled by this driver's skill. */
  speedAt(s) {
    const sp = this.world.spline;
    const n = sp.count;
    let ss = s % sp.length; if (ss < 0) ss += sp.length;
    const i = Math.min(n - 1, Math.floor((ss / sp.length) * n));
    return Math.min(this.world.racingLine.targetSpeed[i] * this.speedScale * this.skill, this.topSpeed);
  }

  update(dt, rivals, gate = {}) {
    const v = this.v;
    if (!v.isAlive) return;

    const allowDrive = gate.allowDrive !== false;
    const t = v.telemetry;
    const sp = this.world.spline;

    const q = sp.query(v.position.x, v.position.z, this._q);
    this.s = q.s;
    this.lateralError = q.signedDist;

    const speed = Math.max(t.speed, 0);
    const grip = 1 - this.world.wetness * 0.22;

    // Watchdog: reversing out of a wedge does not always work (a nose-in barrier
    // hit with heavy damage can be unrecoverable), so if the car has not actually
    // advanced along the circuit for a while, ask to be lifted back onto the line.
    if (this._watchS === null) this._watchS = q.s;
    if (sp.signedArc(this._watchS, q.s) > 12) {
      this._watchS = q.s;
      this._noProgress = 0;
    } else if (allowDrive) {
      this._noProgress += dt;
      if (this._noProgress > 8) { this.needsRescue = true; this._noProgress = 0; }
    }

    /* ── stuck / recovery ── */
    const wrongWay = v.forward.x * sp.tx[q.index] + v.forward.z * sp.tz[q.index] < -0.2;
    const wayOff = Math.abs(q.signedDist) > q.halfWidth + 14;
    if ((Math.abs(t.speed) < 1.4 && allowDrive) || t.upright < 0.35 || (wayOff && Math.abs(t.speed) < 6)) {
      this.stuckTime += dt;
    } else {
      this.stuckTime = Math.max(0, this.stuckTime - dt * 2);
    }
    if (this.stuckTime > 1.6 && this.reverseTimer <= 0) this.reverseTimer = 1.5;
    if (this.reverseTimer > 0) {
      this.reverseTimer -= dt;
      this._driveReverse(q, wrongWay);
      this._apply(allowDrive);
      return;
    }

    /* ── occasional imperfection so the field isn't robotic ── */
    this.mistakeTimer -= dt;
    if (this.mistakeTimer <= 0) {
      this.mistakeTimer = 7 + this.rng() * 16;
      this.mistake = (this.rng() - 0.35) * 0.12 * (2 - this.skill);
    }
    this.mistake = damp(this.mistake, 0, 0.5, dt);

    /* ── lateral negotiation ── */
    this._negotiate(dt, rivals, q, speed);

    /* ── pure pursuit ── */
    const lookahead = clamp(7 + speed * 0.62, 9, 52);
    this.world.linePoint(q.s + lookahead, this.bias, _target);

    _local.copy(_target).sub(v.position);
    const localZ = _local.dot(v.forward);
    const localX = _local.dot(v.right);      // +X of `right` is the car's right-hand side
    const alpha = Math.atan2(localX, Math.max(localZ, 0.5));

    const wheelbase = v.halfWheelbase * 2;
    const geometric = Math.atan2(2 * wheelbase * Math.sin(alpha), Math.max(lookahead, 1));
    // undo the vehicle's own speed-sensitive steering reduction
    const speedEase = 1 - 0.62 * smoothstep(6, 58, Math.abs(t.speed));
    let steer = geometric / Math.max(v.spec.steerLock * speedEase, 0.05);

    // damp the yaw so it doesn't wander at speed (+yawRate = turning left, so add +steer)
    steer += t.yawRate * clamp(speed * 0.006, 0, 0.10);
    steer += this.mistake;
    this._steer = clamp(steer, -1, 1);

    /* ── speed target with lookahead braking ── */
    let vLimit = this.speedAt(q.s + 6);
    const decel = 10.5 * grip * this.brakePoint * lerp(0.85, 1.12, this.skill - 0.85);
    for (let d = 12; d <= 240; d += 12) {
      const vAt = this.speedAt(q.s + d);
      const reachable = Math.sqrt(vAt * vAt + 2 * Math.max(decel, 3) * d);
      if (reachable < vLimit) vLimit = reachable;
    }
    vLimit *= grip;
    // back off when the nose is not pointing where we want to go, and when we are
    // already running wide — both mean the corner is being overcooked
    vLimit *= 1 - clamp01((Math.abs(alpha) - 0.10) / 0.45) * 0.50;
    const wide = clamp01((Math.abs(q.signedDist) - (q.halfWidth - 3)) / 4);
    vLimit *= 1 - wide * 0.35;
    if (!q.far && Math.abs(q.signedDist) > q.halfWidth) vLimit = Math.min(vLimit, 26);
    if (this.blocked) vLimit = Math.min(vLimit, this.blocked.speedCap);

    const err = vLimit - speed;
    let throttle = 0, brake = 0;
    if (err > 0.4) throttle = clamp01(err * 0.35);
    else if (err < -0.8) brake = clamp01(-err * 0.24);

    // ease off mid-corner if the car is already sliding
    const slide = clamp01((Math.abs(t.driftAngle) - 0.22) / 0.35);
    throttle *= 1 - slide * 0.55;

    // smooth pedal application
    this._throttle = damp(this._throttle, throttle, lerp(6, 16, this.throttleSmooth), dt);
    this._brake = damp(this._brake, brake, 22, dt);

    this._apply(allowDrive);
  }

  /** Called by the game once a rescue has been performed. */
  clearRescue() {
    this.needsRescue = false;
    this.reverseTimer = 0;
    this.stuckTime = 0;
    this._watchS = null;
    this._noProgress = 0;
    this._throttle = 0;
    this._brake = 0;
    this._steer = 0;
  }

  _driveReverse(q, wrongWay) {
    // back up and point the nose at the racing line again
    this.world.linePoint(q.s + 14, 0, _target);
    _local.copy(_target).sub(this.v.position);
    const localX = _local.dot(this.v.right);
    const localZ = _local.dot(this.v.forward);
    if (localZ > 0 && Math.abs(localX) < 6) {
      // facing the right way again: drive out forwards
      this._throttle = 0.55;
      this._brake = 0;
      this._steer = clamp(localX * 0.2, -1, 1);
      this.reverseTimer = Math.min(this.reverseTimer, 0.1);
    } else {
      this._throttle = 0;
      this._brake = 0.75;                      // held brake reverses via the auto gearbox
      this._steer = clamp(-localX * 0.2, -1, 1);
    }
    this.stuckTime = 0;
  }

  _negotiate(dt, rivals, q, speed) {
    const sp = this.world.spline;
    const lineOffset = this.world.racingLine.offset[q.index];
    const limit = Math.max(1.0, q.halfWidth - 1.8);
    let target = 0;
    let cap = Infinity;
    this.blocked = null;

    for (const other of rivals) {
      if (other === this.v || !other.isAlive) continue;
      const oq = sp.query(other.position.x, other.position.z, {});
      const ds = sp.signedArc(q.s, oq.s);
      if (ds < -8 || ds > 55) continue;

      const lateralGap = oq.signedDist - q.signedDist;
      const closing = speed - Math.max(other.telemetry.speed, 0);

      if (ds > 2 && Math.abs(lateralGap) < 3.6) {
        // car directly ahead: pick the side with more room
        const theirSide = oq.signedDist;
        const roomLeft = -limit - theirSide;
        const roomRight = limit - theirSide;
        const side = Math.abs(roomRight) > Math.abs(roomLeft) ? 1 : -1;
        const urgency = smoothstep(46, 12, ds) * clamp01(0.35 + this.aggression);
        target += side * limit * 0.85 * urgency;

        // if we can't get past yet, match their pace rather than punt them
        if (ds < 11 && closing > 1.5) {
          cap = Math.min(cap, Math.max(other.telemetry.speed * 0.96, 6));
          this.blocked = { speedCap: cap };
        }
      } else if (Math.abs(ds) <= 6 && Math.abs(lateralGap) < 3.2) {
        // side by side: leave room, don't turn in
        target += -Math.sign(lateralGap || this.preferredSide) * limit * 0.5;
      }
    }

    // relax back to the racing line when the road is clear
    if (target === 0) this.biasTarget = damp(this.biasTarget, 0, 1.6, dt);
    else this.biasTarget = clamp(target, -limit - lineOffset, limit - lineOffset);

    this.bias = damp(this.bias, this.biasTarget, 2.2, dt);
  }

  _apply(allowDrive) {
    const v = this.v;
    if (!allowDrive) {
      v.setControls({ throttle: 0, brake: 1, steer: 0, handbrake: 1 });
      this._throttle = 0;
      this._brake = 0;
      return;
    }
    v.setControls({
      throttle: clamp01(this._throttle),
      brake: clamp01(this._brake),
      steer: clamp(this._steer, -1, 1),
      handbrake: 0,
    });
  }
}
