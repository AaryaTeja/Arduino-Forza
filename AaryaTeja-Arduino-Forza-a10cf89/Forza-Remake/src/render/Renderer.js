import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { clamp } from '../core/MathUtils.js';

/**
 * Camera motion blur by depth re-projection: reconstruct each pixel's world
 * position from the depth buffer, project it with the previous frame's
 * view-projection matrix, and blur along the resulting screen-space velocity.
 * That gives true rotational + translational blur, not a canned radial smear.
 */
class MotionBlurPass extends Pass {
  constructor(sourceTarget) {
    super();
    this.needsSwap = true;
    this.source = sourceTarget;

    this.uniforms = {
      tDiffuse: { value: null },
      tDepth: { value: null },
      uInvViewProj: { value: new THREE.Matrix4() },
      uPrevViewProj: { value: new THREE.Matrix4() },
      uStrength: { value: 0.55 },
      uMaxVelocity: { value: 0.055 },
      uSamples: { value: 10 },
      uExposure: { value: 1.0 },
    };

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      depthTest: false,
      depthWrite: false,
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */`
        varying vec2 vUv;
        uniform sampler2D tDiffuse;
        uniform sampler2D tDepth;
        uniform mat4 uInvViewProj;
        uniform mat4 uPrevViewProj;
        uniform float uStrength;
        uniform float uMaxVelocity;
        uniform int uSamples;
        uniform float uExposure;

        void main() {
          vec4 base = texture2D(tDiffuse, vUv);
          // exposure is applied here, before bloom, so the bloom threshold is a
          // stable post-exposure value instead of drifting with sky brightness
          if (uStrength <= 0.001) { gl_FragColor = vec4(base.rgb * uExposure, base.a); return; }

          float d = texture2D(tDepth, vUv).x;
          vec4 clip = vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
          vec4 world = uInvViewProj * clip;
          if (abs(world.w) < 1e-6) { gl_FragColor = vec4(base.rgb * uExposure, base.a); return; }
          world.xyz /= world.w;

          vec4 prevClip = uPrevViewProj * vec4(world.xyz, 1.0);
          if (prevClip.w <= 0.0) { gl_FragColor = vec4(base.rgb * uExposure, base.a); return; }
          vec2 prevUv = (prevClip.xy / prevClip.w) * 0.5 + 0.5;

          vec2 vel = (vUv - prevUv) * uStrength;
          float len = length(vel);
          if (len < 0.0006) { gl_FragColor = vec4(base.rgb * uExposure, base.a); return; }
          if (len > uMaxVelocity) vel *= uMaxVelocity / len;

          vec4 sum = base;
          float total = 1.0;
          for (int i = 1; i < 24; i++) {
            if (i >= uSamples) break;
            float t = float(i) / float(uSamples - 1) - 0.5;
            vec2 uv = vUv + vel * t;
            if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) continue;
            float w = 1.0 - abs(t) * 0.7;
            sum += texture2D(tDiffuse, uv) * w;
            total += w;
          }
          gl_FragColor = vec4((sum / total).rgb * uExposure, 1.0);
        }`,
    });
    this.fsQuad = new FullScreenQuad(this.material);
  }

  render(renderer, writeBuffer) {
    this.uniforms.tDiffuse.value = this.source.texture;
    this.uniforms.tDepth.value = this.source.depthTexture;
    if (this.renderToScreen) renderer.setRenderTarget(null);
    else {
      renderer.setRenderTarget(writeBuffer);
      if (this.clear) renderer.clear();
    }
    this.fsQuad.render(renderer);
  }

  setMatrices(camera, prevViewProj) {
    const vp = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.uniforms.uInvViewProj.value.copy(vp).invert();
    this.uniforms.uPrevViewProj.value.copy(prevViewProj);
    return vp;
  }

  dispose() { this.material.dispose(); this.fsQuad.dispose(); }
}

export class RenderPipeline {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.exposure = 0.5;                       // matches the three.js Sky shader's calibration
    this.renderer.toneMappingExposure = this.exposure;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.info.autoReset = true;

    this.width = 1; this.height = 1; this.pixelRatio = 1;
    this.usePost = true;
    this.prevViewProj = new THREE.Matrix4();
    this._firstFrame = true;

    this._buildTargets(2, 2);
    this._buildComposer();

    this.fps = 60;
    this._fpsAcc = 0;
    this._fpsFrames = 0;
  }

  _buildTargets(w, h) {
    if (this.sceneRT) { this.sceneRT.dispose(); this.sceneRT.depthTexture?.dispose(); }
    const depth = new THREE.DepthTexture(w, h);
    depth.format = THREE.DepthFormat;
    depth.type = THREE.UnsignedIntType;
    depth.minFilter = THREE.NearestFilter;
    depth.magFilter = THREE.NearestFilter;
    this.sceneRT = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      depthTexture: depth,
    });
  }

  _buildComposer() {
    if (this.composer) this.composer.dispose?.();
    const rt = new THREE.WebGLRenderTarget(2, 2, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    });
    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.renderToScreen = true;

    this.motionBlur = new MotionBlurPass(this.sceneRT);
    this.composer.addPass(this.motionBlur);

    this.bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.45, 0.55, 1.3);
    this.composer.addPass(this.bloom);

    this.output = new OutputPass();
    this.composer.addPass(this.output);

    this.smaa = new SMAAPass();
    this.composer.addPass(this.smaa);
  }

  setQuality(gfx, settings) {
    this.gfx = gfx;
    const basePR = Math.min(window.devicePixelRatio || 1, settings.quality === 'ultra' ? 2 : 1.5);
    this.pixelRatio = clamp(basePR * gfx.renderScale, 0.45, 2.4);
    this.renderer.shadowMap.enabled = gfx.shadows;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.usePost = gfx.bloom || gfx.motionBlur || gfx.smaa;
    if (this.bloom) {
      this.bloom.enabled = !!gfx.bloom;
      this.bloom.strength = settings.bloomAmount;
      this.bloom.radius = 0.55;
      // the motion-blur pass has already applied exposure, so this is just above clipping
      this.bloom.threshold = 1.3;
    }
    if (this.motionBlur) {
      this.motionBlur.uniforms.uStrength.value = gfx.motionBlur ? settings.motionBlurAmount : 0;
      this.motionBlur.uniforms.uSamples.value = settings.quality === 'ultra' ? 14 : 9;
    }
    if (this.smaa) this.smaa.enabled = !!gfx.smaa;
    this.setExposure(this.exposure);
    this.resize();
  }

  resize() {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    this.width = w; this.height = h;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(w, h, false);
    const dw = Math.max(2, Math.floor(w * this.pixelRatio));
    const dh = Math.max(2, Math.floor(h * this.pixelRatio));
    this.sceneRT.setSize(dw, dh);   // three resizes the attached depth texture for us
    this.composer.setSize(dw, dh);
    this.composer.setPixelRatio(1);
    if (this.bloom) this.bloom.setSize(dw, dh);
    this.drawWidth = dw; this.drawHeight = dh;
  }

  /** Which pass ends up on screen depends on what's enabled. */
  _syncRenderToScreen() {
    const passes = this.composer.passes;
    let last = -1;
    for (let i = 0; i < passes.length; i++) {
      passes[i].renderToScreen = false;
      if (passes[i].enabled) last = i;
    }
    if (last >= 0) passes[last].renderToScreen = true;
  }

  /** Camera exposure; applied pre-bloom when post is on, by the renderer otherwise. */
  setExposure(e) {
    this.exposure = e;
    if (this.motionBlur) this.motionBlur.uniforms.uExposure.value = this.usePost ? e : 1;
    this.renderer.toneMappingExposure = this.usePost ? 1 : e;
  }

  render(scene, camera, dt) {
    const r = this.renderer;

    if (!this.usePost) {
      r.setRenderTarget(null);
      r.render(scene, camera);
    } else {
      r.setRenderTarget(this.sceneRT);
      r.clear();
      r.render(scene, camera);

      const vp = this.motionBlur.setMatrices(camera, this.prevViewProj);
      if (this._firstFrame) {
        this.motionBlur.uniforms.uPrevViewProj.value.copy(vp);
        this._firstFrame = false;
      }
      this._syncRenderToScreen();
      r.setRenderTarget(null);
      this.composer.render(dt);
      this.prevViewProj.copy(vp);
    }

    this._fpsAcc += dt;
    this._fpsFrames++;
    if (this._fpsAcc >= 0.5) {
      this.fps = this._fpsFrames / this._fpsAcc;
      this._fpsAcc = 0; this._fpsFrames = 0;
    }
  }

  get stats() {
    const i = this.renderer.info;
    return {
      fps: this.fps,
      calls: i.render.calls,
      triangles: i.render.triangles,
      programs: i.programs?.length ?? 0,
    };
  }
}
