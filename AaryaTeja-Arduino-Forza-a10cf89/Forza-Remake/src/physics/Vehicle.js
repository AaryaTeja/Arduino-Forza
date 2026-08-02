import * as THREE from 'three';
import { RAPIER, GROUP, ig } from './Physics.js';
import { torqueFactor } from '../data/cars.js';
import { clamp, clamp01, lerp, smoothstep, damp, moveToward, TAU } from '../core/MathUtils.js';

const RHO = 1.225;             // air density, kg/m³
const G = 9.81;
// Rapier's vehicle uses forward = +Z, up = +Y. In that right-handed basis the car's
// right-hand side is -X and its left is +X, which fixes the wheel layout and steering sign.
const WHEEL_FL = 0, WHEEL_FR = 1, WHEEL_RL = 2, WHEEL_RR = 3;
const FRONT = [WHEEL_FL, WHEEL_FR];
const REAR = [WHEEL_RL, WHEEL_RR];

const RAY_FILTER = RAPIER.QueryFilterFlags.EXCLUDE_SENSORS | RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC;

/**
 * Rapier's raycast vehicle pushes the chassis along its local -Z for a POSITIVE
 * engine force, while `currentVehicleSpeed()` is already signed +Z-forward. We
 * treat +Z as forward everywhere, so the engine force (and only the engine force)
 * is negated at this single boundary.
 */
const DRIVE_SIGN = -1;

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e1 = new THREE.Euler();

export const SURFACE = { ROAD: 0, KERB: 1, GRASS: 2, GRAVEL: 3 };

/**
 * A driveable car: Rapier raycast vehicle + drivetrain, brakes, aero, assists,
 * surface-aware tyre model and damage.
 *
 * `update(dt)` runs inside the physics substep. `sample()` publishes render/audio state.
 */
export class Vehicle {
  constructor(physics, spec, world, opts = {}) {
    this.physics = physics;
    this.spec = spec;
    this.car = spec.car;
    this.world = world;                 // WorldModel (spline + surface queries)
    this.isPlayer = !!opts.isPlayer;
    this.name = opts.name || spec.car.name;
    this.colour = opts.colour || spec.car.body.colour;

    const b = spec.car.body;
    this.wheelRadius = b.wheelRadius;

    /* ── chassis ── */
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(0, 5, 0)
      .setLinearDamping(0.0)
      .setAngularDamping(0.35)
      .setCanSleep(false)
      .setCcdEnabled(true);
    this.body = physics.world.createRigidBody(bodyDesc);

    const s = spec.car.suspension;
    this.suspensionRest = s.rest;
    this.suspensionTravel = s.travel;
    const staticSag = G / (4 * s.stiffness);
    const groundLocalY = -0.30 - spec.rideHeight;
    this.groundLocalY = groundLocalY;

    // The chassis box must clear the ground by at least the remaining bump travel,
    // otherwise the body grounds out under compression and friction drags the car
    // to a standstill.
    const bumpTravel = Math.max(0.04, s.travel - staticSag);
    const bottomLocal = groundLocalY + bumpTravel + 0.03;
    const topLocal = groundLocalY + 1.15;
    const halfW = b.width * 0.46;
    const halfL = b.length * 0.47;
    const halfH = (topLocal - bottomLocal) / 2;
    this.colliderHalfHeight = halfH;

    const colDesc = RAPIER.ColliderDesc.cuboid(halfW, halfH, halfL)
      .setTranslation(0, (topLocal + bottomLocal) / 2, 0)
      .setDensity(0)                                  // mass comes from setAdditionalMassProperties
      .setFriction(0.28)
      .setRestitution(0.12)
      .setCollisionGroups(ig(GROUP.VEHICLE, 0xffff))
      .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(1600);
    this.collider = physics.world.createCollider(colDesc, this.body);
    physics.registerOwner(this.collider, this);

    this.setMassProperties();

    /* ── raycast vehicle ── */
    this.controller = physics.world.createVehicleController(this.body);
    this.controller.indexUpAxis = 1;
    this.controller.setIndexForwardAxis = 2;
    const wheelCentreY = groundLocalY + b.wheelRadius;
    const connY = wheelCentreY + (s.rest - staticSag);
    this.connY = connY;

    const halfWB = b.wheelbase / 2;
    const tf = b.trackF / 2;   // track is centre-to-centre
    const tr = b.trackR / 2;
    this.wheelConn = [
      { x: tf, y: connY, z: halfWB },    // front left  (+X)
      { x: -tf, y: connY, z: halfWB },   // front right (-X)
      { x: tr, y: connY, z: -halfWB },   // rear left
      { x: -tr, y: connY, z: -halfWB },  // rear right
    ];
    this.halfWheelbase = halfWB;
    this.trackFront = b.trackF;

    for (let i = 0; i < 4; i++) {
      const c = this.wheelConn[i];
      this.controller.addWheel(
        { x: c.x, y: c.y, z: c.z },
        { x: 0, y: -1, z: 0 },     // suspension direction (down)
        { x: 1, y: 0, z: 0 },      // axle: Rapier derives wheel-forward as axle × up, so +X gives +Z forward
        s.rest,
        b.wheelRadius,
      );
      this.controller.setWheelSuspensionStiffness(i, s.stiffness);
      this.controller.setWheelSuspensionCompression(i, s.compression);
      this.controller.setWheelSuspensionRelaxation(i, s.relaxation);
      this.controller.setWheelMaxSuspensionTravel(i, s.travel);
      this.controller.setWheelMaxSuspensionForce(i, spec.mass * 42);
      this.controller.setWheelFrictionSlip(i, spec.grip);
      this.controller.setWheelSideFrictionStiffness(i, 1.0);
    }

    /* ── control inputs ── */
    this.controls = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
    this.assists = { tcs: true, abs: true, stability: true, autoGearbox: true };

    /* ── drivetrain state ── */
    this.gear = 1;
    this.rpm = spec.car.engine.idle;
    this.shiftTimer = 0;
    this.shiftCooldown = 0;
    this.clutch = 1;
    this.boost = 0;
    this.limiterTimer = 0;
    this.reverseHold = 0;
    this.steerAngle = 0;
    this.wheelSpin = [0, 0, 0, 0];       // rad/s
    this._lastWheelRot = [0, 0, 0, 0];
    this._rotInit = false;

    /* ── damage ── */
    this.damage = 0;
    this.damageZones = { front: 0, rear: 0, left: 0, right: 0 };
    this.lastImpact = 0;
    this.impactEvents = [];

    /* ── telemetry published every frame ── */
    this.telemetry = {
      speed: 0, speedKmh: 0, rpm: spec.car.engine.idle, gear: 1, gearLabel: 'N',
      throttle: 0, brake: 0, steer: 0, handbrake: 0,
      lateralG: 0, longG: 0, driftAngle: 0, yawRate: 0,
      airborne: false, wheelsOnGround: 0, surface: SURFACE.ROAD,
      slipFront: 0, slipRear: 0, tyreScreech: 0, wheelSpinAmount: 0,
      load: [0, 0, 0, 0], suspension: [0, 0, 0, 0], contact: [false, false, false, false],
      onRoad: true, offroadAmount: 0, damage: 0, limiter: false, shifting: false,
      engineLoad: 0, boost: 0, distance: 0,
    };

    this.wheelState = Array.from({ length: 4 }, () => ({
      position: new THREE.Vector3(),
      quaternion: new THREE.Quaternion(),
      contact: false, slipRatio: 0, slipAngle: 0, load: 0,
      surface: SURFACE.ROAD, spinSpeed: 0, screech: 0, compression: 0,
      contactPoint: new THREE.Vector3(),
    }));

    this.position = new THREE.Vector3();
    this.quaternion = new THREE.Quaternion();
    this.velocity = new THREE.Vector3();
    this.forward = new THREE.Vector3(0, 0, 1);
    this.right = new THREE.Vector3(1, 0, 0);
    this.up = new THREE.Vector3(0, 1, 0);
    this._prevVel = new THREE.Vector3();
    this._q = {};
    this.distanceTravelled = 0;
    this.stuckTimer = 0;
    this.headlights = false;
    this.horn = false;
    /** Held on the grid during the countdown: the engine revs, the car does not move. */
    this.launchLock = false;
  }

  setMassProperties() {
    const spec = this.spec;
    const b = spec.car.body;
    const m = spec.mass;
    const w = b.width, h = 1.25, l = b.length;
    const k = 0.72;   // mass is concentrated lower and more centrally than a solid box
    const inertia = {
      x: (m / 12) * (h * h + l * l) * k,
      y: (m / 12) * (w * w + l * l) * k,
      z: (m / 12) * (w * w + h * h) * k,
    };
    this.body.setAdditionalMassProperties(
      m,
      { x: 0, y: spec.car.comHeight, z: 0 },
      inertia,
      { x: 0, y: 0, z: 0, w: 1 },
      true,
    );
  }

  /** Rebuild derived numbers after a garage change without recreating the body. */
  applySpec(spec) {
    this.spec = spec;
    this.setMassProperties();
    for (let i = 0; i < 4; i++) {
      this.controller.setWheelFrictionSlip(i, spec.grip);
      this.controller.setWheelMaxSuspensionForce(i, spec.mass * 42);
    }
  }

  get isAlive() { return !!this.body; }

  /* ═══════════ placement ═══════════ */

  placeAt(x, y, z, yaw) {
    this.body.setTranslation({ x, y, z }, true);
    _q1.setFromEuler(_e1.set(0, yaw, 0));
    this.body.setRotation({ x: _q1.x, y: _q1.y, z: _q1.z, w: _q1.w }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.gear = 1;
    this.rpm = this.car.engine.idle;
    this.steerAngle = 0;
    this.shiftTimer = 0;
    this.stuckTimer = 0;
    for (let i = 0; i < 4; i++) {
      this.controller.setWheelEngineForce(i, 0);
      this.controller.setWheelBrake(i, 0);
      this.controller.setWheelSteering(i, 0);
    }
    this.sample(1 / 60);
  }

  setControls(c) {
    this.controls.throttle = clamp01(c.throttle ?? 0);
    this.controls.brake = clamp01(c.brake ?? 0);
    this.controls.steer = clamp(c.steer ?? 0, -1, 1);
    this.controls.handbrake = clamp01(c.handbrake ?? 0);
    if (c.shiftUp) this.shiftUp();
    if (c.shiftDown) this.shiftDown();
  }

  shiftUp() {
    if (this.shiftTimer > 0) return;
    const top = this.car.gears.length;
    if (this.gear < 0) { this.gear = 1; this._beginShift(); return; }
    if (this.gear === 0) { this.gear = 1; this._beginShift(); return; }
    if (this.gear < top) { this.gear++; this._beginShift(); }
  }

  shiftDown() {
    if (this.shiftTimer > 0) return;
    if (this.gear > 1) { this.gear--; this._beginShift(); return; }
    if (this.gear === 1) { this.gear = 0; this._beginShift(); return; }
    if (this.gear === 0) { this.gear = -1; this._beginShift(); }
  }

  _beginShift() {
    this.shiftTimer = this.spec.shiftTime;
    this.shiftCooldown = this.spec.shiftTime + 0.20;
    this.justShifted = true;
  }

  get gearRatio() {
    if (this.gear === 0) return 0;
    if (this.gear < 0) return -this.car.reverseGear;
    return this.car.gears[this.gear - 1];
  }

  get gearLabel() {
    if (this.gear === 0) return 'N';
    if (this.gear < 0) return 'R';
    return String(this.gear);
  }

  /* ═══════════ per-substep simulation ═══════════ */

  update(dt) {
    const spec = this.spec;
    const car = this.car;
    const eng = car.engine;
    const ctrl = this.controller;

    // Rapier keeps `addForce` values applied every step until they are explicitly
    // cleared, so aero and anti-roll forces must be zeroed before we re-apply them
    // or they compound into an enormous phantom brake.
    this.body.resetForces(false);
    this.body.resetTorques(false);

    this._readTransform();

    const speed = ctrl.currentVehicleSpeed();        // +ve = travelling nose-first
    const absSpeed = Math.abs(speed);

    /* ── wheel angular velocities from the controller's own integration ── */
    let contacts = 0;
    for (let i = 0; i < 4; i++) {
      const rot = ctrl.wheelRotation(i) ?? 0;
      if (this._rotInit) {
        const d = rot - this._lastWheelRot[i];
        this.wheelSpin[i] = damp(this.wheelSpin[i], d / dt, 40, dt);
      }
      this._lastWheelRot[i] = rot;
      if (ctrl.wheelIsInContact(i)) contacts++;
    }
    this._rotInit = true;
    const airborne = contacts === 0;

    /* ── surfaces ── */
    const surf = this._evaluateSurfaces();

    /* ── gearbox direction handling ── */
    const inReverse = this.gear < 0;
    let driveInput = inReverse ? this.controls.brake : this.controls.throttle;
    let brakeInput = inReverse ? this.controls.throttle : this.controls.brake;

    if (this.shiftTimer > 0) this.shiftTimer = Math.max(0, this.shiftTimer - dt);
    if (this.shiftCooldown > 0) this.shiftCooldown -= dt;
    const shifting = this.shiftTimer > 0;
    this.clutch = damp(this.clutch, shifting ? 0 : 1, 26, dt);

    if (this.assists.autoGearbox) this._autoGearbox(absSpeed, speed, driveInput, brakeInput, dt);

    /* ── engine rpm ── */
    const drivenIdx = this._drivenWheels();
    let drivenOmega = 0;
    for (const i of drivenIdx) drivenOmega += this.wheelSpin[i];
    drivenOmega /= drivenIdx.length || 1;

    const ratio = this.gearRatio;
    const total = Math.abs(ratio) * spec.finalDrive;
    let targetRpm;
    if (this.launchLock) {
      targetRpm = eng.idle + driveInput * (eng.redline * 0.92 - eng.idle);
    } else if (this.gear !== 0 && !shifting && !airborne && total > 0.01) {
      targetRpm = Math.abs(drivenOmega) * total * (60 / TAU);
    } else {
      targetRpm = eng.idle + driveInput * (eng.redline * 0.98 - eng.idle);
    }
    targetRpm = Math.max(targetRpm, eng.idle);
    const revRate = (this.launchLock || this.gear === 0 || shifting || airborne) ? 5.5 / eng.revInertia : 22;
    this.rpm = damp(this.rpm, targetRpm, revRate, dt);

    // rev limiter: cut fuel briefly so it bounces off the redline
    let limiter = false;
    if (this.rpm >= eng.redline) {
      this.rpm = Math.min(this.rpm, eng.redline * 1.015);
      this.limiterTimer = 0.055;
    }
    if (this.limiterTimer > 0) { this.limiterTimer -= dt; limiter = true; }

    // turbo spool
    const boostTarget = eng.turbo > 0
      ? eng.turbo * driveInput * smoothstep(0.18, 0.55, this.rpm / eng.redline)
      : 0;
    this.boost = damp(this.boost, boostTarget, driveInput > 0.4 ? 3.2 : 6.0, dt);

    /* ── engine force ── */
    let wheelForce = 0;
    const damageFactor = 1 - clamp01(this.damage) * 0.28;
    if (this.gear !== 0 && !shifting && !limiter && !this.launchLock) {
      const tf = torqueFactor(this.rpm / eng.redline);
      const boostMul = 1 + this.boost * 0.30;
      const torque = spec.peakTorque * tf * boostMul * driveInput * this.clutch * damageFactor;
      wheelForce = (torque * total * car.driveEfficiency) / this.wheelRadius;
      if (inReverse) wheelForce = -wheelForce;
    }

    // engine braking on a closed throttle
    let engineBrake = 0;
    if (this.gear !== 0 && !shifting && driveInput < 0.06 && !airborne) {
      const eb = spec.peakTorque * 0.10 * (this.rpm / eng.redline) * total / this.wheelRadius;
      engineBrake = eb;
    }

    /* ── steering ── */
    const steerLimit = spec.steerLock;
    const speedEase = 1 - 0.62 * smoothstep(6, 58, absSpeed);
    // positive wheel steering rotates about +Y, which turns the car left, so invert the input
    let steerTarget = -this.controls.steer * steerLimit * speedEase;

    // damage pulls the car to one side
    const pull = (this.damageZones.left - this.damageZones.right) * 0.035;
    steerTarget += pull;

    if (this.assists.stability && !airborne && absSpeed > 7) {
      // gentle counter-steer when the rear steps out further than commanded
      const yawRate = this.body.angvel().y;
      const desiredYaw = (speed * Math.tan(this.steerAngle)) / (this.halfWheelbase * 2);
      const excess = yawRate - desiredYaw;
      steerTarget -= clamp(excess * 0.16, -0.13, 0.13);
    }
    steerTarget = clamp(steerTarget, -steerLimit, steerLimit);
    const steerRate = lerp(5.2, 2.4, smoothstep(4, 55, absSpeed));
    this.steerAngle = moveToward(this.steerAngle, steerTarget, steerRate * dt);

    // Ackermann: the inside wheel turns tighter
    const [inner, outer] = ackermann(this.steerAngle, this.halfWheelbase * 2, this.trackFront);
    // steerAngle > 0 turns left, so the left wheel is the inside wheel
    const leftAngle = this.steerAngle >= 0 ? inner : outer;
    const rightAngle = this.steerAngle >= 0 ? outer : inner;
    ctrl.setWheelSteering(WHEEL_FL, leftAngle);
    ctrl.setWheelSteering(WHEEL_FR, rightAngle);

    /* ── brakes ── */
    const maxDecel = spec.brakeStrength * 3 * G;
    const effBrake = this.launchLock ? 1 : brakeInput;
    const totalBrakeImpulse = effBrake * maxDecel * spec.mass * dt;
    const bias = spec.brakeBias;
    const hb = this.launchLock ? 1 : this.controls.handbrake;
    const hbImpulse = hb * spec.mass * 9.5 * dt;

    /* ── per-wheel application ── */
    let screech = 0, spinAmount = 0;
    let slipFrontAcc = 0, slipRearAcc = 0;

    for (let i = 0; i < 4; i++) {
      const isFront = i < 2;
      const inContact = ctrl.wheelIsInContact(i);
      const w = this.wheelState[i];
      const su = surf[i];

      // tyre friction from surface + weather
      let mu = su.grip;
      let sideStiff = su.sideStiffness;
      if (!isFront && hb > 0.1) { mu *= lerp(1, 0.52, hb); sideStiff *= lerp(1, 0.34, hb); }
      ctrl.setWheelFrictionSlip(i, mu);
      ctrl.setWheelSideFrictionStiffness(i, sideStiff);

      // longitudinal slip from the wheel's own surface speed
      const surfaceSpeed = this.wheelSpin[i] * this.wheelRadius;
      const ref = Math.max(absSpeed, 2.2);
      const slip = clamp((surfaceSpeed - speed) / ref, -3, 3);
      w.slipRatio = slip;

      // engine force to driven wheels, with traction control
      let force = 0;
      if (drivenIdx.includes(i)) {
        force = wheelForce / drivenIdx.length;
        if (this.assists.tcs && inContact && absSpeed > 1.2) {
          const over = clamp01((Math.abs(slip) - 0.16) / 0.30);
          if (Math.sign(slip) === Math.sign(force || 1)) force *= 1 - over * 0.88;
        }
      }
      ctrl.setWheelEngineForce(i, DRIVE_SIGN * force);

      // brakes with ABS
      let brakeImp = totalBrakeImpulse * (isFront ? bias : 1 - bias) * 0.5;
      if (this.assists.abs && inContact && absSpeed > 3.5 && brakeImp > 0) {
        const lock = clamp01((-slip - 0.12) / 0.26);
        brakeImp *= 1 - lock * 0.85;
      }
      if (!isFront) brakeImp += hbImpulse * 0.5;
      // engine braking is felt at the driven wheels
      if (drivenIdx.includes(i)) brakeImp += (engineBrake / drivenIdx.length) * dt;
      // rolling resistance
      brakeImp += su.rollingResistance * spec.mass * G * 0.25 * dt * Math.sign(absSpeed > 0.2 ? 1 : 0);
      ctrl.setWheelBrake(i, brakeImp);

      if (inContact) {
        const spinExcess = clamp01((Math.abs(slip) - 0.18) / 0.5);
        const lateral = Math.abs(w.slipAngle);
        const lat = clamp01((lateral - 0.10) / 0.42);
        const sc = Math.max(spinExcess, lat) * clamp01(absSpeed / 3.5) * (su.screechy ?? 1);
        w.screech = sc;
        screech = Math.max(screech, sc);
        if (drivenIdx.includes(i)) spinAmount = Math.max(spinAmount, spinExcess);
      } else {
        w.screech = 0;
      }
      if (isFront) slipFrontAcc = Math.max(slipFrontAcc, Math.abs(w.slipAngle));
      else slipRearAcc = Math.max(slipRearAcc, Math.abs(w.slipAngle));
    }

    /* ── aero ── */
    const v = this.body.linvel();
    const vLen = Math.hypot(v.x, v.y, v.z);
    if (vLen > 0.5) {
      const dragMag = 0.5 * RHO * spec.cdA * vLen * vLen;
      this.body.addForce({ x: (-v.x / vLen) * dragMag, y: (-v.y / vLen) * dragMag, z: (-v.z / vLen) * dragMag }, true);
    }
    // downforce acts through the floor — meaningless (and self-amplifying) once inverted
    if (absSpeed > 4 && this.up.y > 0.25) {
      const df = Math.min(0.5 * RHO * spec.downforceCoef * speed * speed, spec.mass * G * 3);
      _v1.copy(this.up).multiplyScalar(-df);
      this.body.addForce({ x: _v1.x, y: _v1.y, z: _v1.z }, true);
    }

    /* ── anti-roll bars ── */
    this._applyAntiRoll(WHEEL_FL, WHEEL_FR, spec.arbFront);
    this._applyAntiRoll(WHEEL_RL, WHEEL_RR, spec.arbRear);

    /* ── keep it sane ── */
    const av = this.body.angvel();
    const avLen = Math.hypot(av.x, av.y, av.z);
    if (avLen > 9) {
      const k = 9 / avLen;
      this.body.setAngvel({ x: av.x * k, y: av.y * k, z: av.z * k }, true);
    }

    ctrl.updateVehicle(dt, RAY_FILTER, undefined, undefined);

    this._screech = screech;
    this._spinAmount = spinAmount;
    this._slipFront = slipFrontAcc;
    this._slipRear = slipRearAcc;
    this._limiter = limiter;
    this._shifting = shifting;
    this._airborne = airborne;
    this._contacts = contacts;
    this._driveInput = driveInput;
    this._brakeInput = brakeInput;
  }

  _drivenWheels() {
    switch (this.car.drivetrain) {
      case 'fwd': return FRONT;
      case 'rwd': return REAR;
      default: return [0, 1, 2, 3];
    }
  }

  /**
   * Anti-roll bar. Only runs when BOTH wheels on the axle are loaded — applying it
   * with one wheel airborne leaves a net vertical force that launches the car
   * instead of the pure roll couple a real bar produces.
   */
  _applyAntiRoll(li, ri, setting) {
    const ctrl = this.controller;
    if (!ctrl.wheelIsInContact(li) || !ctrl.wheelIsInContact(ri)) return;
    const rest = this.suspensionRest;
    const travel = this.suspensionTravel || 0.2;
    const ll = ctrl.wheelSuspensionLength(li);
    const rl = ctrl.wheelSuspensionLength(ri);
    if (ll == null || rl == null) return;
    const deflection = clamp(rl - ll, -travel, travel);   // metres of relative travel
    if (Math.abs(deflection) < 1e-4) return;

    // rate as a fraction of the wheel spring rate (stiffness is per-unit-mass in Bullet's convention)
    const springRate = this.car.suspension.stiffness * this.spec.mass;
    const arbRate = springRate * (0.08 + setting * 0.32);
    const limit = this.spec.mass * G * 0.25;
    const force = clamp(deflection * arbRate, -limit, limit);

    const applyAt = (idx, mag) => {
      const p = ctrl.wheelHardPoint(idx);
      if (!p) return;
      _v1.copy(this.up).multiplyScalar(mag);
      this.body.addForceAtPoint({ x: _v1.x, y: _v1.y, z: _v1.z }, p, true);
    };
    // push up on the more-compressed corner (shorter suspension), down on the other
    applyAt(li, force);
    applyAt(ri, -force);
  }

  _autoGearbox(absSpeed, speed, driveInput, brakeInput, dt) {
    const eng = this.car.engine;
    const top = this.car.gears.length;
    const frac = this.rpm / eng.redline;

    // engage reverse after a short hold at a standstill
    if (this.gear > 0 && absSpeed < 0.9 && this.controls.brake > 0.45 && this.controls.throttle < 0.05) {
      this.reverseHold += dt;
      if (this.reverseHold > 0.30) { this.gear = -1; this._beginShift(); this.reverseHold = 0; }
      return;
    }
    if (this.gear < 0 && this.controls.throttle > 0.35 && speed > -0.9) {
      this.gear = 1; this._beginShift(); this.reverseHold = 0; return;
    }
    this.reverseHold = 0;
    if (this.gear <= 0) return;
    if (this.shiftCooldown > 0) return;

    // upshift point rises with throttle so part-throttle cruising short-shifts
    const upAt = lerp(0.62, 0.945, driveInput);
    if (frac > upAt && this.gear < top) { this.gear++; this._beginShift(); return; }

    if (this.gear > 1) {
      const nextRatio = this.car.gears[this.gear - 2];
      const curRatio = this.car.gears[this.gear - 1];
      const projected = frac * (nextRatio / curRatio);
      const downAt = lerp(0.42, 0.80, driveInput);
      if (frac < 0.34 && projected < 0.98) { this.gear--; this._beginShift(); return; }
      if (driveInput > 0.55 && projected < downAt && frac < 0.55) { this.gear--; this._beginShift(); }
    }
  }

  /** Per-wheel surface classification and grip. */
  _evaluateSurfaces() {
    const ctrl = this.controller;
    const spec = this.spec;
    const wet = this.world.wetness || 0;
    const out = [];
    for (let i = 0; i < 4; i++) {
      const cp = ctrl.wheelContactPoint(i);
      let onRoad = true, dist = 0;
      if (cp) {
        const q = this.world.querySurface(cp.x, cp.z, this._q);
        onRoad = q.onRoad;
        dist = q.edgeDistance;
      }
      const blend = clamp01(1 - smoothstep(0, 2.4, dist));   // 1 on tarmac, 0 well off it
      const dryTarmac = spec.grip;
      // wetGrip is the compound's wet coefficient; scale the resolved grip by the wet/dry ratio
      const wetTarmac = spec.grip * (spec.wetGrip / Math.max(spec.tyre.grip, 0.01));
      const roadGrip = lerp(dryTarmac, wetTarmac, wet);
      const offGrip = spec.offroadGrip * lerp(1.0, 0.86, wet);
      const grip = lerp(offGrip, roadGrip, blend);
      out.push({
        grip,
        sideStiffness: lerp(0.68, 1.0, blend),
        rollingResistance: lerp(0.075, 0.014, blend),
        onRoad,
        screechy: lerp(0.35, 1, blend),
        surface: blend > 0.5 ? SURFACE.ROAD : SURFACE.GRASS,
        offroad: 1 - blend,
      });
    }
    return out;
  }

  _readTransform() {
    const t = this.body.translation();
    const r = this.body.rotation();
    this.position.set(t.x, t.y, t.z);
    this.quaternion.set(r.x, r.y, r.z, r.w);
    this.forward.set(0, 0, 1).applyQuaternion(this.quaternion);
    this.right.set(-1, 0, 0).applyQuaternion(this.quaternion);
    this.up.set(0, 1, 0).applyQuaternion(this.quaternion);
    const v = this.body.linvel();
    this.velocity.set(v.x, v.y, v.z);
  }

  /* ═══════════ render/audio sampling (once per frame) ═══════════ */

  sample(dt) {
    const ctrl = this.controller;
    const t = this.telemetry;
    this._readTransform();

    const speed = ctrl.currentVehicleSpeed();
    const planar = _v1.copy(this.velocity); planar.y = 0;
    const planarSpeed = planar.length();

    t.speed = speed;
    t.speedKmh = Math.abs(speed) * 3.6;
    t.rpm = this.rpm;
    t.gear = this.gear;
    t.gearLabel = this.gearLabel;
    t.throttle = this._driveInput ?? this.controls.throttle;
    t.brake = this._brakeInput ?? this.controls.brake;
    t.steer = this.steerAngle / (this.spec.steerLock || 1);
    t.handbrake = this.controls.handbrake;
    t.airborne = !!this._airborne;
    t.wheelsOnGround = this._contacts ?? 0;
    t.limiter = !!this._limiter;
    t.shifting = !!this._shifting;
    t.tyreScreech = this._screech ?? 0;
    t.wheelSpinAmount = this._spinAmount ?? 0;
    t.slipFront = this._slipFront ?? 0;
    t.slipRear = this._slipRear ?? 0;
    t.boost = this.boost;
    t.damage = this.damage;
    t.engineLoad = clamp01(t.throttle * 0.7 + (this.rpm / this.car.engine.redline) * 0.3);
    t.yawRate = this.body.angvel().y;

    // drift angle between the chassis heading and the direction of travel
    if (planarSpeed > 1.4) {
      const fwd = _v2.copy(this.forward); fwd.y = 0; fwd.normalize();
      const dir = _v3.copy(planar).normalize();
      const dot = clamp(fwd.dot(dir), -1, 1);
      const cross = fwd.x * dir.z - fwd.z * dir.x;
      let ang = Math.acos(dot);
      if (speed < 0) ang = Math.PI - ang;
      t.driftAngle = Math.sign(cross) * ang;
    } else {
      t.driftAngle = 0;
    }

    // accelerations in the car's frame
    const accel = _v2.copy(this.velocity).sub(this._prevVel).divideScalar(Math.max(dt, 1e-4));
    this._prevVel.copy(this.velocity);
    t.longG = accel.dot(this.forward) / G;
    t.lateralG = accel.dot(this.right) / G;

    this.distanceTravelled += planarSpeed * dt;
    t.distance = this.distanceTravelled;

    // wheels
    let onRoadCount = 0, offroad = 0;
    for (let i = 0; i < 4; i++) {
      const w = this.wheelState[i];
      const hp = ctrl.wheelHardPoint(i);
      const len = ctrl.wheelSuspensionLength(i) ?? this.suspensionRest;
      const contact = ctrl.wheelIsInContact(i);
      w.contact = contact;
      w.compression = clamp01((this.suspensionRest - len) / (this.suspensionTravel || 0.2));
      if (hp) {
        w.position.set(hp.x, hp.y, hp.z).addScaledVector(this.up, -len);
      }
      const steer = ctrl.wheelSteering(i) ?? 0;
      _q1.setFromAxisAngle(_v3.set(0, 1, 0), steer);
      _q2.setFromAxisAngle(_v3.set(1, 0, 0), ctrl.wheelRotation(i) ?? 0);
      w.quaternion.copy(this.quaternion).multiply(_q1).multiply(_q2);
      w.load = ctrl.wheelSuspensionForce(i) ?? 0;
      w.spinSpeed = this.wheelSpin[i];
      t.load[i] = w.load;
      t.suspension[i] = w.compression;
      t.contact[i] = contact;

      const cp = ctrl.wheelContactPoint(i);
      if (cp) {
        w.contactPoint.set(cp.x, cp.y, cp.z);
        const q = this.world.querySurface(cp.x, cp.z, this._q);
        w.surface = q.onRoad ? SURFACE.ROAD : SURFACE.GRASS;
        if (q.onRoad) onRoadCount++; else if (contact) offroad++;
      }

      // lateral slip angle at this corner
      const lat = ctrl.wheelSideImpulse(i) ?? 0;
      const load = Math.max(w.load, 1);
      w.slipAngle = clamp(lat / (load * 0.02 + 40), -1.4, 1.4);
    }
    t.onRoad = onRoadCount >= 2;
    t.offroadAmount = offroad / 4;
    t.surface = t.onRoad ? SURFACE.ROAD : SURFACE.GRASS;

    // stuck detection for the reset prompt
    const upright = this.up.y;
    if ((upright < 0.25 || (Math.abs(speed) < 1.2 && (t.throttle > 0.4 || t.brake > 0.4))) && !t.airborne) {
      this.stuckTimer += dt;
    } else {
      this.stuckTimer = Math.max(0, this.stuckTimer - dt * 1.6);
    }
    t.stuck = this.stuckTimer > 2.4;
    t.upright = upright;
    return t;
  }

  /* ═══════════ damage ═══════════ */

  registerImpact(forceMagnitude, worldPoint) {
    const spec = this.spec;
    const norm = forceMagnitude / (spec.mass * 900);
    if (norm < 0.015) return 0;
    const add = clamp(norm * 0.11, 0, 0.13);
    this.damage = clamp01(this.damage + add);

    // which quadrant took the hit
    let zone = 'front';
    if (worldPoint) {
      _v1.set(worldPoint.x, worldPoint.y, worldPoint.z).sub(this.position);
      const f = _v1.dot(this.forward);
      const r = _v1.dot(this.right);
      zone = Math.abs(f) > Math.abs(r) ? (f > 0 ? 'front' : 'rear') : (r > 0 ? 'right' : 'left');
    }
    this.damageZones[zone] = clamp01(this.damageZones[zone] + add * 2.6);
    this.lastImpact = norm;
    this.impactEvents.push({ magnitude: norm, zone, point: worldPoint ? _v1.clone().add(this.position) : this.position.clone() });
    if (this.impactEvents.length > 8) this.impactEvents.shift();
    return norm;
  }

  repair() {
    this.damage = 0;
    this.damageZones = { front: 0, rear: 0, left: 0, right: 0 };
    this.impactEvents.length = 0;
  }

  destroy() {
    if (this.controller) { this.physics.world.removeVehicleController(this.controller); this.controller = null; }
    if (this.collider) this.physics.colliderOwners.delete(this.collider.handle);
    if (this.body) { this.physics.world.removeRigidBody(this.body); this.body = null; }
  }
}

/** Ackermann steering geometry: returns [innerAngle, outerAngle] magnitudes, signed. */
function ackermann(steer, wheelbase, track) {
  const a = Math.abs(steer);
  if (a < 1e-4) return [steer, steer];
  const R = wheelbase / Math.tan(a);
  const inner = Math.atan(wheelbase / Math.max(R - track / 2, 0.35));
  const outer = Math.atan(wheelbase / (R + track / 2));
  const s = Math.sign(steer);
  return [s * inner, s * outer];
}
