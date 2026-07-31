import * as THREE from 'three';
import { GROUP, ig } from '../physics/Physics.js';
import { clamp, clamp01, lerp, damp, angleDelta, makeRng } from '../core/MathUtils.js';

export const CAMERA_MODES = [
  { id: 'chase', label: 'Chase' },
  { id: 'chaseFar', label: 'Chase Far' },
  { id: 'bumper', label: 'Bumper' },
  { id: 'hood', label: 'Hood' },
  { id: 'cockpit', label: 'Cockpit' },
  { id: 'cinematic', label: 'Cinematic' },
];

const _pos = new THREE.Vector3();
const _look = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _up = new THREE.Vector3(0, 1, 0);

const RIG = {
  chase: { dist: 7.2, height: 2.55, look: 1.15, ahead: 7, fov: 70, fovGain: 20, stiff: 7.5, yawBlend: 0.30 },
  chaseFar: { dist: 11.5, height: 4.2, look: 1.4, ahead: 10, fov: 66, fovGain: 16, stiff: 5.0, yawBlend: 0.42 },
};

export class CameraDirector {
  constructor(camera, physics) {
    this.camera = camera;
    this.physics = physics;
    this.modeIndex = 0;
    this.rng = makeRng(0x1234);

    this.smoothPos = new THREE.Vector3();
    this.smoothLook = new THREE.Vector3();
    this.smoothYaw = 0;
    this.initialised = false;

    this.shake = 0;
    this.shakeScale = 1;
    this.fovBase = 74;
    this.currentFov = 74;
    this.roll = 0;
    this.lookBack = false;

    // cinematic
    this._cineTimer = 0;
    this._cinePos = new THREE.Vector3();
    this._cineFov = 40;

    // photo mode
    this.photo = false;
    this.photoOrbit = { yaw: 0.6, pitch: 0.22, dist: 9 };
    this._dragging = false;
    this._bindPhotoInput();
  }

  get mode() { return CAMERA_MODES[this.modeIndex]; }

  cycle() {
    this.modeIndex = (this.modeIndex + 1) % CAMERA_MODES.length;
    this.initialised = false;
    return this.mode;
  }

  setMode(i) {
    this.modeIndex = clamp(i | 0, 0, CAMERA_MODES.length - 1);
    this.initialised = false;
  }

  addShake(amount) { this.shake = Math.min(1.6, this.shake + amount); }

  _bindPhotoInput() {
    const el = document.getElementById('viewport');
    if (!el) return;
    el.addEventListener('pointerdown', (e) => { if (this.photo) { this._dragging = true; el.setPointerCapture(e.pointerId); } });
    el.addEventListener('pointerup', (e) => { this._dragging = false; if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId); });
    el.addEventListener('pointermove', (e) => {
      if (!this.photo || !this._dragging) return;
      this.photoOrbit.yaw -= e.movementX * 0.005;
      this.photoOrbit.pitch = clamp(this.photoOrbit.pitch + e.movementY * 0.004, -0.35, 1.25);
    });
    el.addEventListener('wheel', (e) => {
      if (!this.photo) return;
      e.preventDefault();
      this.photoOrbit.dist = clamp(this.photoOrbit.dist * (1 + Math.sign(e.deltaY) * 0.10), 3, 45);
    }, { passive: false });
  }

  /**
   * @param {Vehicle} v      player vehicle
   * @param {CarModel} model player car model (for interior anchors)
   */
  update(dt, v, model, opts = {}) {
    const cam = this.camera;
    const t = v.telemetry;
    const speed = Math.abs(t.speed);
    this.fovBase = opts.fov ?? 74;
    this.shakeScale = opts.shakeScale ?? 0.7;

    if (this.photo) { this._photo(dt, v); return; }

    const mode = this.mode.id;
    if (mode === 'chase' || mode === 'chaseFar') this._chase(dt, v, RIG[mode]);
    else if (mode === 'cinematic') this._cinematic(dt, v, opts.world);
    else this._onboard(dt, v, model, mode);

    // decay and apply shake
    this.shake = Math.max(0, this.shake - dt * 1.9);
    const rough = t.airborne ? 0 : clamp01((t.offroadAmount * (speed / 22)) * 1.2);
    const total = clamp(this.shake + rough * 0.35 + clamp01((speed - 55) / 90) * 0.10, 0, 1.8) * this.shakeScale;
    if (total > 0.001) {
      const s = total * 0.11;
      const now = performance.now() * 0.001;
      cam.position.x += Math.sin(now * 47.3) * s;
      cam.position.y += Math.sin(now * 61.7 + 1.3) * s;
      cam.position.z += Math.sin(now * 39.1 + 2.7) * s * 0.6;
      cam.rotateZ(Math.sin(now * 53.9) * total * 0.008);
    }

    if (Math.abs(cam.fov - this.currentFov) > 0.01) {
      cam.fov = this.currentFov;
      cam.updateProjectionMatrix();
    }
  }

  _chase(dt, v, rig) {
    const t = v.telemetry;
    const speed = Math.abs(t.speed);

    // blend the chassis heading with the direction of travel so drifts read well
    const headYaw = Math.atan2(v.forward.x, v.forward.z);
    let velYaw = headYaw;
    _tmp.copy(v.velocity); _tmp.y = 0;
    if (_tmp.lengthSq() > 9) velYaw = Math.atan2(_tmp.x, _tmp.z);
    const blend = rig.yawBlend * clamp01((speed - 4) / 16);
    let targetYaw = headYaw + angleDelta(headYaw, velYaw) * blend;
    if (this.lookBack) targetYaw += Math.PI;

    if (!this.initialised) { this.smoothYaw = targetYaw; }
    this.smoothYaw += angleDelta(this.smoothYaw, targetYaw) * (1 - Math.exp(-rig.stiff * 0.85 * dt));

    const dist = rig.dist * lerp(1, 1.16, clamp01(speed / 85));
    const height = rig.height + clamp01(speed / 90) * 0.35;
    _dir.set(Math.sin(this.smoothYaw), 0, Math.cos(this.smoothYaw));

    _pos.copy(v.position).addScaledVector(_dir, -dist);
    _pos.y = v.position.y + height;
    // ride over crests instead of clipping into them
    const ground = this.physics.groundAt(_pos.x, _pos.z, v.position.y + 90);
    if (ground != null && _pos.y < ground + 1.0) _pos.y = ground + 1.0;

    _look.copy(v.position).addScaledVector(_dir, rig.ahead * (this.lookBack ? -0.3 : 1));
    _look.y = v.position.y + rig.look;

    if (!this.initialised) {
      this.smoothPos.copy(_pos);
      this.smoothLook.copy(_look);
      this.currentFov = this.fovBase;
      this.initialised = true;
    }
    const k = 1 - Math.exp(-rig.stiff * dt);
    this.smoothPos.lerp(_pos, k);
    this.smoothLook.lerp(_look, Math.min(1, k * 1.5));

    this._avoidGeometry(v.position, this.smoothPos);

    this.camera.position.copy(this.smoothPos);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.smoothLook);

    // subtle roll into the corner
    const targetRoll = clamp(-t.lateralG * 0.022 + t.driftAngle * 0.045, -0.10, 0.10);
    this.roll = damp(this.roll, targetRoll, 5, dt);
    this.camera.rotateZ(this.roll);

    const targetFov = this.fovBase + clamp01((speed - 12) / 78) * (RIG.chase === rig ? 20 : 16) * 0.85
      + clamp01(v.boost) * 1.5;
    this.currentFov = damp(this.currentFov, targetFov, 3.2, dt);
  }

  _onboard(dt, v, model, mode) {
    let anchor = model?.hoodAnchor;
    let lookOffset = 26, upOffset = 0.0, fovAdd = 0;
    if (mode === 'cockpit') { anchor = model?.cockpitAnchor; lookOffset = 30; fovAdd = -4; }
    else if (mode === 'bumper') { anchor = model?.bumperAnchor; lookOffset = 26; fovAdd = 4; }

    if (anchor) anchor.getWorldPosition(_pos);
    else _pos.copy(v.position).addScaledVector(v.forward, 1.1).addScaledVector(v.up, 0.6);

    _pos.addScaledVector(v.up, upOffset);
    this.camera.position.copy(_pos);

    const fwd = this.lookBack ? _tmp.copy(v.forward).negate() : _tmp.copy(v.forward);
    _look.copy(_pos).addScaledVector(fwd, lookOffset).addScaledVector(v.up, mode === 'cockpit' ? -1.5 : -1.9);
    this.camera.up.copy(v.up);
    this.camera.lookAt(_look);

    const t = v.telemetry;
    const speed = Math.abs(t.speed);
    const targetFov = this.fovBase + fovAdd + clamp01((speed - 10) / 80) * 16;
    this.currentFov = damp(this.currentFov, targetFov, 3.5, dt);

    // suspension travel felt through the chassis
    const bump = (t.suspension[0] + t.suspension[1] + t.suspension[2] + t.suspension[3]) / 4 - 0.35;
    this.camera.position.addScaledVector(v.up, -bump * 0.06);
    if (!this.initialised) this.initialised = true;
  }

  _cinematic(dt, v, world) {
    this._cineTimer -= dt;
    const distToCam = this._cinePos.distanceTo(v.position);
    if (this._cineTimer <= 0 || distToCam > 220 || !this.initialised) {
      this._pickCinematicShot(v, world);
      this._cineTimer = 4.5 + this.rng() * 3.5;
      this.initialised = true;
    }
    this.camera.position.copy(this._cinePos);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(v.position.x, v.position.y + 0.6, v.position.z);

    // zoom to keep the car a consistent size in frame
    const d = clamp(this._cinePos.distanceTo(v.position), 8, 200);
    const target = clamp(60 - (d - 8) * 0.24, 16, 60);
    this.currentFov = damp(this.currentFov, target, 2.4, dt);
  }

  _pickCinematicShot(v, world) {
    if (!world) {
      this._cinePos.copy(v.position).add(new THREE.Vector3(14, 6, 14));
      return;
    }
    const sp = world.spline;
    const q = sp.query(v.position.x, v.position.z, {});
    const ahead = 45 + this.rng() * 110;
    const smp = sp.sampleAt(q.s + ahead, {});
    const side = this.rng() > 0.5 ? 1 : -1;
    const lateral = (smp.halfWidth + 9 + this.rng() * 22) * side;
    const x = smp.x + sp.nx[smp.index] * lateral;
    const z = smp.z + sp.nz[smp.index] * lateral;
    const ground = world.groundHeight(x, z);
    const high = this.rng() > 0.62;
    const y = Math.max(ground, smp.y - 4) + (high ? 12 + this.rng() * 16 : 1.6 + this.rng() * 2.4);
    this._cinePos.set(x, y, z);
  }

  _photo(dt, v) {
    const o = this.photoOrbit;
    const cy = Math.cos(o.pitch), sy = Math.sin(o.pitch);
    _pos.set(Math.sin(o.yaw) * cy, sy, Math.cos(o.yaw) * cy).multiplyScalar(o.dist).add(v.position);
    _pos.y += 0.6;
    const ground = this.physics.groundAt(_pos.x, _pos.z, v.position.y + 120);
    if (ground != null && _pos.y < ground + 0.5) _pos.y = ground + 0.5;
    this.camera.position.copy(_pos);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(v.position.x, v.position.y + 0.5, v.position.z);
    this.currentFov = damp(this.currentFov, this.fovBase - 12, 4, dt);
    this.camera.fov = this.currentFov;
    this.camera.updateProjectionMatrix();
  }

  /** Pull the camera in if static geometry sits between it and the car. */
  _avoidGeometry(carPos, camPos) {
    _tmp.copy(camPos).sub(carPos);
    const dist = _tmp.length();
    if (dist < 0.5) return;
    _tmp.divideScalar(dist);
    const origin = { x: carPos.x, y: carPos.y + 0.5, z: carPos.z };
    const hit = this.physics.castRay(
      origin, { x: _tmp.x, y: _tmp.y, z: _tmp.z }, dist,
      ig(0xffff, GROUP.TERRAIN | GROUP.STATIC | GROUP.ROAD),
    );
    if (hit) {
      const toi = hit.timeOfImpact ?? hit.toi ?? dist;
      if (toi < dist - 0.2) {
        const safe = Math.max(1.6, toi - 0.45);
        camPos.copy(carPos);
        camPos.y += 0.5;
        camPos.addScaledVector(_tmp, safe);
      }
    }
  }
}
