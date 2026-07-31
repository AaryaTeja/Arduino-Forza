import * as THREE from 'three';
import { CarModel } from '../render/CarModel.js';
import { damp, lerp } from '../core/MathUtils.js';

/**
 * Studio scene used behind the main menu and inside the garage. Runs the same
 * CarModel the game uses, so what you configure is exactly what you drive.
 */
export class Showroom {
  constructor(materials, renderer) {
    this.materials = materials;
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x05070b);
    this.scene.fog = new THREE.FogExp2(0x05070b, 0.020);
    // a dedicated studio probe — reflecting the outdoor sky here blows out glass and clearcoat
    this.scene.environmentIntensity = 1.0;

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 400);

    // floor
    const floorGeo = new THREE.CircleGeometry(34, 64);
    floorGeo.rotateX(-Math.PI / 2);
    this.floorMat = new THREE.MeshStandardMaterial({
      color: 0x0c1015, roughness: 0.42, metalness: 0.30, envMapIntensity: 0.55,
    });
    const floor = new THREE.Mesh(floorGeo, this.floorMat);
    floor.receiveShadow = true;
    this.scene.add(floor);

    // faint concentric guide rings
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x1a2630, transparent: true, opacity: 0.55 });
    for (const r of [4.2, 7.4, 12, 18]) {
      const g = new THREE.RingGeometry(r, r + 0.03, 96);
      g.rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(g, ringMat);
      m.position.y = 0.004;
      this.scene.add(m);
    }

    // backdrop
    const backdrop = new THREE.Mesh(
      new THREE.CylinderGeometry(30, 30, 26, 48, 1, true),
      new THREE.MeshStandardMaterial({ color: 0x070a0f, side: THREE.BackSide, roughness: 0.95, metalness: 0, envMapIntensity: 0.05 }),
    );
    backdrop.position.y = 12;
    this.scene.add(backdrop);

    // studio lighting
    const key = new THREE.SpotLight(0xffffff, 130, 70, 0.85, 0.90, 1.7);
    key.position.set(6, 16, 8);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.bias = -0.0012;
    this.scene.add(key);
    this.key = key;

    const rim1 = new THREE.SpotLight(0x2ce0ff, 115, 50, 0.7, 0.80, 1.5);
    rim1.position.set(-11, 6, -8);
    this.scene.add(rim1);

    const rim2 = new THREE.SpotLight(0xff8a3c, 85, 50, 0.7, 0.80, 1.5);
    rim2.position.set(9, 5, -11);
    this.scene.add(rim2);

    this.scene.add(new THREE.HemisphereLight(0x334455, 0x090c11, 0.62));

    this.carRoot = new THREE.Group();
    this.scene.add(this.carRoot);

    this.turntable = 0;
    this.autoSpin = 0.18;
    this.orbitTarget = new THREE.Vector3(0, 0.75, 0);
    this.camAngle = 0.9;
    this.camHeight = 2.1;
    this.camDist = 9.2;
    this.model = null;
    this.enabled = false;
  }

  /**
   * Bake a small studio probe: a dark gradient shell with three softbox panels.
   * Gives the paint and glass believable elongated highlights without the sky's
   * brightness range.
   */
  buildStudioEnvironment() {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const studio = new THREE.Scene();

    const shell = new THREE.Mesh(
      new THREE.SphereGeometry(40, 24, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        uniforms: {},
        vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader: `varying vec3 vP;
          void main() {
            float h = normalize(vP).y * 0.5 + 0.5;
            vec3 c = mix(vec3(0.012, 0.016, 0.024), vec3(0.10, 0.12, 0.15), pow(h, 1.4));
            gl_FragColor = vec4(c, 1.0);
          }`,
      }),
    );
    studio.add(shell);

    const softbox = (w, h, x, y, z, rx, ry, power, tint) => {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(w, h),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(tint).multiplyScalar(power), side: THREE.DoubleSide }),
      );
      m.position.set(x, y, z);
      m.rotation.set(rx, ry, 0);
      studio.add(m);
    };
    // overhead strip, plus a cool and a warm side panel
    softbox(26, 5, 0, 15, 0, Math.PI / 2, 0, 3.0, 0xffffff);
    softbox(16, 9, -17, 7, -6, 0, Math.PI * 0.42, 1.60, 0x9fd8ff);
    softbox(14, 8, 15, 6, -9, 0, -Math.PI * 0.38, 1.10, 0xffc79a);
    softbox(20, 6, 0, 5, 20, 0, Math.PI, 0.70, 0xdfe8f5);

    const rt = pmrem.fromScene(studio, 0.02);
    pmrem.dispose();
    shell.geometry.dispose();
    shell.material.dispose();
    studio.traverse((o) => { if (o.isMesh && o !== shell) { o.geometry.dispose(); o.material.dispose(); } });

    this.studioEnv = rt.texture;
    this.scene.environment = this.studioEnv;
    this.floorMat.envMap = this.studioEnv;
    this.floorMat.needsUpdate = true;
    return this.studioEnv;
  }

  setEnvironment() {
    if (!this.studioEnv) this.buildStudioEnvironment();
  }

  /** Rebuild the preview for a car + build. */
  setCar(car, build) {
    if (this.model) {
      this.carRoot.remove(this.model.group);
      this.model.dispose();
      this.model = null;
    }
    const groundLocalY = -0.30 - (0.06 + build.tune.rideHeight * 0.10);
    this.model = new CarModel(car, JSON.parse(JSON.stringify(build)), this.materials, { groundLocalY });
    this.carRoot.add(this.model.group);

    // rest the car on the studio floor
    this.model.chassis.position.set(0, -groundLocalY, 0);
    this.model.chassis.quaternion.identity();
    const b = car.body;
    const hubY = b.wheelRadius;
    const halfWB = b.wheelbase / 2;
    const tf = b.trackF / 2;
    const tr = b.trackR / 2;
    const pos = [
      [tf, hubY, halfWB], [-tf, hubY, halfWB],
      [tr, hubY, -halfWB], [-tr, hubY, -halfWB],
    ];
    this.model.wheels.forEach((w, i) => {
      w.position.set(pos[i][0], pos[i][1], pos[i][2]);
      w.userData.spin.quaternion.identity();
      w.userData.hub.quaternion.identity();
    });
    this.model.headlightMat.emissiveIntensity = 0.35;
    this.model.taillightMat.emissiveIntensity = 0.35;
    this.currentCar = car;
  }

  /** Live-update paint/wheels without a rebuild. */
  applyBuild(build) {
    if (!this.model) return;
    this.model.setPaint(build.paint, build.finish, build.stripe, build.stripeColour);
    this.model.setWheels(build.wheelStyle, build.rimColour, build.caliperColour);
  }

  setAspect(a) {
    this.camera.aspect = a;
    this.camera.updateProjectionMatrix();
  }

  /** `focus` 0 = wide menu framing, 1 = tight garage framing. */
  update(dt, focus = 0) {
    this.turntable += dt * this.autoSpin;
    this.carRoot.rotation.y = this.turntable;

    const dist = lerp(11.5, 8.2, focus);
    const height = lerp(2.9, 1.9, focus);
    const lateral = lerp(0.30, -0.06, focus);

    this.camAngle = damp(this.camAngle, 0.72 + lateral, 2.0, dt);
    this.camDist = damp(this.camDist, dist, 2.0, dt);
    this.camHeight = damp(this.camHeight, height, 2.0, dt);

    const a = this.camAngle;
    this.camera.position.set(Math.sin(a) * this.camDist, this.camHeight, Math.cos(a) * this.camDist);
    this.camera.lookAt(this.orbitTarget);
    if (this.model) this.model.discMat.emissiveIntensity = 0;
  }
}
