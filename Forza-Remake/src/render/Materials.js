import * as THREE from 'three';
import {
  makeRoadTextures, makeTerrainDetail, makeConcreteTextures, makeFacade,
  makeSoftSprite, makeSmokeSprite, makeRainSprite, makeSkidTexture,
  makeWaterNormal, makeFlakeNormal, makeStripes, makeChecker, makeBanner,
  makeMarkerBoard, makeBark,
} from './Textures.js';

const FACADE_PALETTES = [
  { wall: '#7d8288', band: '#5f646b', frame: '#3a3f46', glassA: '#243440', glassB: '#3d5668' },
  { wall: '#9a8f80', band: '#7a7064', frame: '#4a443c', glassA: '#2b3540', glassB: '#48606f' },
  { wall: '#5f676f', band: '#474e56', frame: '#2c3138', glassA: '#1c2733', glassB: '#32485a' },
  { wall: '#a8a29a', band: '#8b857c', frame: '#55504a', glassA: '#2f3a44', glassB: '#526a7c' },
  { wall: '#6d5f56', band: '#544942', frame: '#332c27', glassA: '#222c36', glassB: '#3c5265' },
  { wall: '#8e949b', band: '#6d737a', frame: '#404750', glassA: '#1f2a36', glassB: '#3f5a6e' },
];

/**
 * Every shared material in the world. Textures are generated once at boot;
 * `applyQuality` retunes anisotropy and shadow-relevant flags without a rebuild.
 */
export class MaterialLibrary {
  constructor(renderer) {
    this.renderer = renderer;
    this.maxAniso = renderer.capabilities.getMaxAnisotropy();
    this.textures = [];
    this.build();
  }

  _track(...t) {
    for (const x of t) if (x && x.isTexture) this.textures.push(x);
    return t[0];
  }

  build() {
    const road = makeRoadTextures({ size: 1024 });
    this._track(road.map, road.normalMap, road.roughnessMap);
    // one texture tile spans 24 m of road (the UVs already encode that)
    road.map.repeat.set(1, 1);
    road.normalMap.repeat.set(1, 1);
    road.roughnessMap.repeat.set(1, 1);

    this.roadMaps = road;
    this.road = new THREE.MeshStandardMaterial({
      map: road.map,
      normalMap: road.normalMap,
      roughnessMap: road.roughnessMap,
      normalScale: new THREE.Vector2(0.85, 0.85),
      roughness: 1.0,
      metalness: 0.0,
      envMapIntensity: 0.55,
    });

    const detail = this._track(makeTerrainDetail());
    detail.repeat.set(90, 90);
    this.terrain = new THREE.MeshStandardMaterial({
      vertexColors: true,
      normalMap: detail,
      normalScale: new THREE.Vector2(0.55, 0.55),
      roughness: 0.96,
      metalness: 0.0,
      envMapIntensity: 0.42,
    });

    const conc = makeConcreteTextures('#8f9296', 21);
    this._track(conc.map, conc.normalMap);
    conc.map.repeat.set(0.22, 0.22);
    conc.normalMap.repeat.set(0.22, 0.22);
    this.concrete = new THREE.MeshStandardMaterial({
      map: conc.map, normalMap: conc.normalMap,
      roughness: 0.88, metalness: 0.0, envMapIntensity: 0.5,
    });

    const conc2 = makeConcreteTextures('#7b7d80', 44);
    this._track(conc2.map, conc2.normalMap);
    conc2.map.repeat.set(1, 1);
    conc2.normalMap.repeat.set(1, 1);
    this.tunnelWall = new THREE.MeshStandardMaterial({
      map: conc2.map, normalMap: conc2.normalMap,
      roughness: 0.9, metalness: 0.0, side: THREE.DoubleSide, envMapIntensity: 0.35,
    });
    this.portal = new THREE.MeshStandardMaterial({
      map: conc2.map, normalMap: conc2.normalMap,
      roughness: 0.92, metalness: 0.0, side: THREE.DoubleSide, envMapIntensity: 0.45,
      color: 0xb9bcc0,
    });

    const rockTex = makeConcreteTextures('#6f6a63', 88);
    this._track(rockTex.map, rockTex.normalMap);
    rockTex.map.repeat.set(1, 1);
    rockTex.normalMap.repeat.set(1, 1);
    this.rockFace = new THREE.MeshStandardMaterial({
      map: rockTex.map, normalMap: rockTex.normalMap,
      normalScale: new THREE.Vector2(1.6, 1.6),
      roughness: 0.97, metalness: 0.0, side: THREE.DoubleSide,
      color: 0x8d8880, envMapIntensity: 0.4,
    });
    this.rock = new THREE.MeshStandardMaterial({ color: 0x7d786f, roughness: 0.95, flatShading: true });

    const sidewalkTex = makeConcreteTextures('#a5a7aa', 62);
    this._track(sidewalkTex.map, sidewalkTex.normalMap);
    sidewalkTex.map.repeat.set(1, 1);
    sidewalkTex.normalMap.repeat.set(1, 1);
    this.sidewalk = new THREE.MeshStandardMaterial({
      map: sidewalkTex.map, normalMap: sidewalkTex.normalMap,
      roughness: 0.9, metalness: 0.0, envMapIntensity: 0.5,
    });

    const kerbTex = this._track(makeStripes('#cf3327', '#eceef2', 4, 0.22));
    this.kerb = new THREE.MeshStandardMaterial({
      map: kerbTex, roughness: 0.7, metalness: 0.0, envMapIntensity: 0.7,
    });

    this.steel = new THREE.MeshStandardMaterial({ color: 0x9aa1a8, roughness: 0.44, metalness: 0.88, envMapIntensity: 1.0 });
    this.metalPole = new THREE.MeshStandardMaterial({ color: 0x51565c, roughness: 0.55, metalness: 0.75 });
    this.barrierMetal = new THREE.MeshStandardMaterial({ color: 0xb6bcc2, roughness: 0.4, metalness: 0.85, side: THREE.DoubleSide, envMapIntensity: 1.1 });
    this.fence = new THREE.MeshStandardMaterial({ color: 0x6b5c47, roughness: 0.85, metalness: 0.05 });

    this.lampHead = new THREE.MeshStandardMaterial({
      color: 0x2a2e33, roughness: 0.5, metalness: 0.6,
      emissive: new THREE.Color(0xffd9a0), emissiveIntensity: 0,
    });
    this.tunnelLight = new THREE.MeshStandardMaterial({
      color: 0x1a1d21, roughness: 0.6, metalness: 0.2,
      emissive: new THREE.Color(0xfff0d0), emissiveIntensity: 2.4, side: THREE.DoubleSide,
    });

    const markerTex = this._track(makeMarkerBoard());
    this.marker = new THREE.MeshStandardMaterial({ map: markerTex, roughness: 0.62, metalness: 0.1, side: THREE.DoubleSide });

    const bannerTex = this._track(makeBanner());
    this.banner = new THREE.MeshStandardMaterial({
      map: bannerTex, roughness: 0.7, metalness: 0.1, side: THREE.DoubleSide,
      emissive: 0xffffff, emissiveMap: bannerTex, emissiveIntensity: 0.22,
    });

    const checkerTex = this._track(makeChecker(14));
    this.startLine = new THREE.MeshStandardMaterial({
      map: checkerTex, roughness: 0.75, metalness: 0.0,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
    });

    const barkTex = this._track(makeBark());
    barkTex.repeat.set(1, 2);
    this.bark = new THREE.MeshStandardMaterial({ map: barkTex, roughness: 0.94, metalness: 0.0 });
    this.leafBroad = new THREE.MeshStandardMaterial({ color: 0x4f7a35, roughness: 0.88, flatShading: true });
    this.leafConifer = new THREE.MeshStandardMaterial({ color: 0x2f5730, roughness: 0.9, flatShading: true });
    this.bush = new THREE.MeshStandardMaterial({ color: 0x546b30, roughness: 0.92, flatShading: true });

    this.facades = FACADE_PALETTES.map((p, i) => {
      const f = makeFacade(1000 + i * 37, p);
      this._track(f.map, f.emissiveMap);
      return new THREE.MeshStandardMaterial({
        map: f.map,
        emissive: new THREE.Color(0xffffff),
        emissiveMap: f.emissiveMap,
        emissiveIntensity: 0,
        roughness: 0.62,
        metalness: 0.22,
        envMapIntensity: 0.9,
      });
    });

    const waterN = this._track(makeWaterNormal());
    this.waterNormal = waterN;
    this.water = new THREE.MeshPhysicalMaterial({
      color: 0x14323f,
      roughness: 0.08,
      metalness: 0.0,
      normalMap: waterN,
      normalScale: new THREE.Vector2(0.35, 0.35),
      transparent: true,
      opacity: 0.86,
      envMapIntensity: 1.6,
      side: THREE.DoubleSide,
    });

    this.flakeNormal = this._track(makeFlakeNormal());
    this.skidTexture = this._track(makeSkidTexture());
    this.smokeSprite = this._track(makeSmokeSprite());
    this.softSprite = this._track(makeSoftSprite('rgba(255,255,255,1)', 'rgba(255,255,255,0)', 1.6));
    this.rainSprite = this._track(makeRainSprite());

    this.skid = new THREE.MeshBasicMaterial({
      map: this.skidTexture, transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6,
      opacity: 0.72,
    });

    this.checkpointGate = new THREE.MeshBasicMaterial({
      color: 0x29e0a8, transparent: true, opacity: 0.30, side: THREE.DoubleSide, depthWrite: false,
    });
    this.checkpointPost = new THREE.MeshStandardMaterial({
      color: 0x0f2a24, emissive: 0x29e0a8, emissiveIntensity: 2.2, roughness: 0.4, metalness: 0.3,
    });

    this.propMaterials = {
      facades: this.facades, concrete: this.concrete, bark: this.bark,
      leafBroad: this.leafBroad, leafConifer: this.leafConifer, bush: this.bush,
      rock: this.rock, metalPole: this.metalPole, lampHead: this.lampHead,
      marker: this.marker, steel: this.steel, banner: this.banner,
      tunnelWall: this.tunnelWall, rockFace: this.rockFace, portal: this.portal,
      tunnelLight: this.tunnelLight, fence: this.fence,
    };

    this.applyQuality(this.maxAniso);
  }

  applyQuality(aniso) {
    const a = Math.min(aniso, this.maxAniso);
    for (const t of this.textures) {
      if (t.anisotropy !== a) { t.anisotropy = a; t.needsUpdate = true; }
    }
  }

  /** Assign the PMREM environment to every material that should reflect it. */
  setEnvironment(env, intensityScale = 1) {
    const list = [
      this.road, this.terrain, this.concrete, this.tunnelWall, this.portal, this.rockFace,
      this.rock, this.sidewalk, this.kerb, this.steel, this.metalPole, this.barrierMetal,
      this.fence, this.marker, this.banner, this.startLine, this.bark, this.leafBroad,
      this.leafConifer, this.bush, this.water, ...this.facades,
    ];
    for (const m of list) {
      m.envMap = env;
      m.needsUpdate = true;
    }
  }

  /** Wet-weather response: darker, glossier tarmac and shinier everything. */
  setWetness(w) {
    this.road.roughness = 1.0 - w * 0.72;
    this.road.color.setScalar(1 - w * 0.42);
    this.road.envMapIntensity = 0.55 + w * 1.1;
    this.sidewalk.roughness = 0.9 - w * 0.5;
    this.sidewalk.envMapIntensity = 0.5 + w * 1.1;
    this.kerb.roughness = 0.7 - w * 0.4;
    this.concrete.roughness = 0.88 - w * 0.34;
    this.terrain.roughness = 0.96 - w * 0.18;
    this.terrain.envMapIntensity = 0.42 + w * 0.12;
  }

  /** Night-time emissive response for windows, lamps and signage. */
  setNightFactor(n) {
    for (const f of this.facades) f.emissiveIntensity = n * 1.35;
    this.lampHead.emissiveIntensity = n * 3.4;
    this.banner.emissiveIntensity = 0.22 + n * 0.9;
  }
}
