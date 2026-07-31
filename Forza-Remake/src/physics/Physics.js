import RAPIER from '@dimforge/rapier3d-compat';

export { RAPIER };

export const GROUP = {
  TERRAIN: 0x0001,
  ROAD: 0x0002,
  STATIC: 0x0004,
  VEHICLE: 0x0008,
  SENSOR: 0x0010,
};

/** Rapier interaction group: (membership << 16) | filter */
export const ig = (membership, filter) => ((membership << 16) | filter) >>> 0;

let initPromise = null;
export function initPhysics() {
  if (!initPromise) initPromise = RAPIER.init();
  return initPromise;
}

/**
 * Fixed-timestep Rapier world with helpers for the static geometry the world
 * builder produces, plus contact-force events used for collision damage/audio.
 */
export class PhysicsWorld {
  constructor({ fixedStep = 1 / 120, maxSubSteps = 6 } = {}) {
    this.fixedStep = fixedStep;
    this.maxSubSteps = maxSubSteps;
    this.accumulator = 0;
    this.time = 0;
    this.stepCount = 0;

    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.integrationParameters.dt = fixedStep;
    this.world.integrationParameters.numSolverIterations = 6;

    this.events = new RAPIER.EventQueue(true);
    this.colliderOwners = new Map();   // colliderHandle -> owner object
    this.preStepHooks = [];
    this.contactListeners = [];
  }

  registerOwner(collider, owner) {
    this.colliderOwners.set(collider.handle, owner);
  }
  ownerOf(handle) { return this.colliderOwners.get(handle) || null; }

  onPreStep(fn) { this.preStepHooks.push(fn); return () => { this.preStepHooks = this.preStepHooks.filter((f) => f !== fn); }; }
  onContact(fn) { this.contactListeners.push(fn); }

  /** Advance the simulation; runs the vehicle hooks inside every substep. */
  step(dt) {
    this.accumulator += Math.min(dt, 0.2);
    let steps = 0;
    while (this.accumulator >= this.fixedStep && steps < this.maxSubSteps) {
      for (const h of this.preStepHooks) h(this.fixedStep);
      this.world.step(this.events);
      this._drainEvents();
      this.accumulator -= this.fixedStep;
      this.time += this.fixedStep;
      this.stepCount++;
      steps++;
    }
    if (steps === this.maxSubSteps) this.accumulator = 0;   // don't spiral after a stall
    return steps;
  }

  _drainEvents() {
    if (!this.contactListeners.length) { this.events.clear(); return; }
    this.events.drainContactForceEvents((e) => {
      const a = this.ownerOf(e.collider1());
      const b = this.ownerOf(e.collider2());
      if (!a && !b) return;
      const mag = e.totalForceMagnitude();
      for (const fn of this.contactListeners) fn(a, b, mag, e);
    });
    this.events.drainCollisionEvents(() => {});
  }

  /* ── static geometry helpers ── */

  addHeightfield(heights, nrows, ncols, scale, { friction = 0.92, group = GROUP.TERRAIN } = {}) {
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const desc = RAPIER.ColliderDesc.heightfield(nrows, ncols, heights, scale)
      .setFriction(friction)
      .setRestitution(0.02)
      .setCollisionGroups(ig(group, 0xffff));
    const col = this.world.createCollider(desc, body);
    return { body, collider: col };
  }

  addTrimesh(positions, indices, { friction = 1.0, restitution = 0.05, group = GROUP.ROAD, owner = null } = {}) {
    if (!positions.length || !indices.length) return null;
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const desc = RAPIER.ColliderDesc.trimesh(
      positions instanceof Float32Array ? positions : new Float32Array(positions),
      indices instanceof Uint32Array ? indices : new Uint32Array(indices),
    ).setFriction(friction).setRestitution(restitution).setCollisionGroups(ig(group, 0xffff));
    const col = this.world.createCollider(desc, body);
    if (owner) this.registerOwner(col, owner);
    return { body, collider: col };
  }

  addBox({ pos, quat, half, friction = 0.6, restitution = 0.05, group = GROUP.STATIC, owner = null }) {
    const bodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(pos[0], pos[1], pos[2]);
    if (quat) bodyDesc.setRotation({ x: quat[0], y: quat[1], z: quat[2], w: quat[3] });
    const body = this.world.createRigidBody(bodyDesc);
    const desc = RAPIER.ColliderDesc.cuboid(half[0], half[1], half[2])
      .setFriction(friction).setRestitution(restitution)
      .setCollisionGroups(ig(group, 0xffff));
    const col = this.world.createCollider(desc, body);
    if (owner) this.registerOwner(col, owner);
    return { body, collider: col };
  }

  addCapsule({ pos, radius, halfHeight, friction = 0.7, restitution = 0.2, group = GROUP.STATIC }) {
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(pos[0], pos[1], pos[2]));
    const desc = RAPIER.ColliderDesc.capsule(halfHeight, radius)
      .setFriction(friction).setRestitution(restitution)
      .setCollisionGroups(ig(group, 0xffff));
    const col = this.world.createCollider(desc, body);
    return { body, collider: col };
  }

  /** Downward ray; returns world Y of the first hit or null. */
  groundAt(x, z, fromY = 400, maxDist = 900) {
    const ray = new RAPIER.Ray({ x, y: fromY, z }, { x: 0, y: -1, z: 0 });
    const hit = this.world.castRay(ray, maxDist, true, undefined, ig(0xffff, GROUP.TERRAIN | GROUP.ROAD | GROUP.STATIC));
    if (!hit) return null;
    return fromY - (hit.timeOfImpact ?? hit.toi);
  }

  castRay(origin, dir, maxDist, filterGroups) {
    const ray = new RAPIER.Ray(origin, dir);
    return this.world.castRayAndGetNormal(ray, maxDist, true, undefined, filterGroups);
  }

  dispose() {
    this.world.free();
  }
}
