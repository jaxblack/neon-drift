import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

import { CAMERA, KART } from '../core/Config';
import { clamp, damp, dampAngle } from '../core/MathUtil';
import type { Kart } from '../physics/Kart';
import type { TrackTheme } from '../track/Track';
import { makeSkyTexture } from './Textures';
import { SpeedLinesShader } from './Effects';

export type Quality = 'low' | 'medium' | 'high';

export type CameraMode = 'chase' | 'far' | 'hood';

/** 渲染舞台：renderer / scene / camera / 后期 / 跟随相机 */
export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private composer: EffectComposer | null = null;
  private bloom: UnrealBloomPass | null = null;
  private speedPass: ShaderPass | null = null;
  private sun: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  private sky: THREE.Mesh | null = null;
  private skyDisposables: Array<{ dispose(): void }> = [];
  quality: Quality = 'high';

  // ---- 跟随相机状态 ----
  private camYaw = 0;
  private camPos = new THREE.Vector3();
  private lookAt = new THREE.Vector3();
  private shake = 0;
  private shakeSeed = Math.random() * 100;
  private fov: number = CAMERA.fovBase;
  private initialised = false;
  mode: CameraMode = 'chase';

  constructor(canvas: HTMLCanvasElement, quality: Quality = 'high') {
    this.quality = quality;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: quality !== 'low',
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, quality === 'high' ? 2 : 1.35));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.92;
    this.renderer.shadowMap.enabled = quality === 'high';
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.camera = new THREE.PerspectiveCamera(CAMERA.fovBase, 1, 0.4, 5200);
    this.camera.position.set(0, 12, -22);

    // 灯光
    this.hemi = new THREE.HemisphereLight(0xa6c8ff, 0x3c3a52, 1.9);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff2d8, 1.5);
    this.sun.position.set(60, 120, 40);
    if (quality === 'high') {
      this.sun.castShadow = true;
      this.sun.shadow.mapSize.set(1024, 1024);
      const c = this.sun.shadow.camera;
      c.near = 1; c.far = 420;
      c.left = -90; c.right = 90; c.top = 90; c.bottom = -90;
      this.sun.shadow.bias = -0.0012;
      this.sun.shadow.normalBias = 0.035;
    }
    this.scene.add(this.sun, this.sun.target);

    this.setupComposer();
    this.resize();
  }

  private setupComposer(): void {
    if (this.quality === 'low') { this.composer = null; return; }
    const c = new EffectComposer(this.renderer);
    c.addPass(new RenderPass(this.scene, this.camera));

    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      this.quality === 'high' ? 0.42 : 0.3, // strength
      0.55,                                  // radius
      0.94,                                  // threshold——只让真正的霓虹发光
    );
    c.addPass(this.bloom);

    this.speedPass = new ShaderPass(SpeedLinesShader);
    c.addPass(this.speedPass);

    c.addPass(new OutputPass());
    this.composer = c;
  }

  setQuality(q: Quality): void {
    if (q === this.quality) return;
    this.quality = q;
    this.renderer.shadowMap.enabled = q === 'high';
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, q === 'high' ? 2 : 1.35));
    this.sun.castShadow = q === 'high';
    this.composer?.dispose();
    this.composer = null;
    this.bloom = null;
    this.speedPass = null;
    this.setupComposer();
    this.resize();
  }

  applyTheme(theme: TrackTheme): void {
    this.clearSky();
    const tex = makeSkyTexture(theme.skyTop, theme.skyBottom, theme.env);
    const geo = new THREE.SphereGeometry(4200, 32, 20);
    const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, depthWrite: false, fog: false });
    this.skyDisposables.push(tex, geo, mat);
    this.sky = new THREE.Mesh(geo, mat);
    this.sky.renderOrder = -1;
    this.scene.add(this.sky);

    const density = theme.env === 'canyon' ? 0.0011
      : theme.env === 'city' ? 0.0009
        : theme.env === 'space' ? 0.00035
          : 0.0007;
    this.scene.fog = new THREE.FogExp2(theme.fog, density);
    this.scene.background = new THREE.Color(theme.fog);

    if (theme.env === 'coast') {
      this.sun.color.setHex(0xffd0a0);
      this.sun.intensity = 1.55;
      this.sun.position.set(-200, 90, 120);
    } else if (theme.env === 'canyon') {
      this.sun.color.setHex(0xffc08a);
      this.sun.intensity = 1.4;
      this.sun.position.set(120, 110, -60);
    } else if (theme.env === 'space') {
      // 太空：几乎无环境光，全靠路面自发光和车身霓虹
      this.sun.color.setHex(0xa8c0ff);
      this.sun.intensity = 0.85;
      this.sun.position.set(-90, 160, 60);
    } else {
      this.sun.color.setHex(0xcfe0ff);
      this.sun.intensity = 1.45;
      this.sun.position.set(60, 140, 40);
    }
    this.hemi.intensity = theme.env === 'space' ? 1.1 : 1.9;
  }

  private clearSky(): void {
    if (this.sky) { this.scene.remove(this.sky); this.sky = null; }
    this.skyDisposables.forEach((d) => d.dispose());
    this.skyDisposables = [];
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.composer?.setSize(w, h);
    this.bloom?.setSize(w, h);
  }

  addShake(amount: number): void {
    this.shake = Math.min(this.shake + amount, 1.4);
  }

  cycleCameraMode(): CameraMode {
    this.mode = this.mode === 'chase' ? 'far' : this.mode === 'far' ? 'hood' : 'chase';
    this.initialised = false;
    return this.mode;
  }

  /** 每渲染帧更新跟随相机 */
  updateCamera(kart: Kart, alpha: number, dt: number): void {
    const p = kart.interp(alpha);

    // 相机偏航：正常跟车头；漂移时更贴速度方向，才能看清车身的滑行姿态
    let targetYaw = p.heading;
    if (kart.speed > 8) {
      const velYaw = Math.atan2(kart.vx, kart.vz);
      const blend = kart.drifting ? 0.55 : 0.16;
      targetYaw = p.heading + shortest(p.heading, velYaw) * blend;
    }
    if (!this.initialised) {
      this.camYaw = targetYaw;
    } else {
      const rate = kart.drifting ? 5.5 : CAMERA.posLerp * 0.62;
      this.camYaw = dampAngle(this.camYaw, targetYaw, rate, dt);
    }

    const spdN = clamp(kart.speed / KART.maxSpeed, 0, 1.6);
    const boostN = kart.boostTime > 0 ? clamp(kart.boostPower / KART.nitroExtraSpeed, 0, 1) : 0;

    let dist: number, height: number, lookAhead: number, lookHeight: number;
    switch (this.mode) {
      case 'far':
        dist = CAMERA.distance * 1.6; height = CAMERA.height * 1.9;
        lookAhead = CAMERA.lookAhead * 1.2; lookHeight = CAMERA.lookHeight;
        break;
      case 'hood':
        dist = 0.2; height = 1.55;
        lookAhead = 26; lookHeight = 1.4;
        break;
      default:
        dist = CAMERA.distance; height = CAMERA.height;
        lookAhead = CAMERA.lookAhead; lookHeight = CAMERA.lookHeight;
    }
    // 速度越快镜头拉远压低 —— 强化贴地飞驰的感觉
    dist += spdN * 1.6 + boostN * 1.4;
    height -= spdN * 0.55;

    const cfx = Math.sin(this.camYaw), cfz = Math.cos(this.camYaw);
    // 漂移时镜头往弯道外侧挪一点，露出车头指向
    const side = kart.drifting ? kart.driftDir * CAMERA.driftOffset * clamp(kart.slip * 2.2, 0, 1) : 0;
    const rx = cfz, rz = -cfx;

    const tx = p.x - cfx * dist + rx * side;
    const ty = p.y + height;
    const tz = p.z - cfz * dist + rz * side;

    if (!this.initialised) {
      this.camPos.set(tx, ty, tz);
      this.lookAt.set(p.x, p.y + 1, p.z);
      this.initialised = true;
    } else {
      const k = 1 - Math.exp(-CAMERA.posLerp * dt);
      this.camPos.x += (tx - this.camPos.x) * k;
      this.camPos.y += (ty - this.camPos.y) * k;
      this.camPos.z += (tz - this.camPos.z) * k;
    }

    // 防止镜头穿进地面
    const groundY = kart.track.surfaceHeight(this.camPos.x, this.camPos.z, kart.trackIndex).y;
    if (this.camPos.y < groundY + 1.4) this.camPos.y = groundY + 1.4;

    // 注视点：车前方
    const fx = Math.sin(p.heading), fz = Math.cos(p.heading);
    const lx = p.x + fx * lookAhead;
    const ly = p.y + lookHeight;
    const lz = p.z + fz * lookAhead;
    const lk = 1 - Math.exp(-CAMERA.lookLerp * dt);
    this.lookAt.x += (lx - this.lookAt.x) * lk;
    this.lookAt.y += (ly - this.lookAt.y) * lk;
    this.lookAt.z += (lz - this.lookAt.z) * lk;

    // 抖动
    this.camera.position.copy(this.camPos);
    if (this.shake > 0.001) {
      const t = performance.now() * 0.001;
      const s = this.shake * 0.85;
      this.camera.position.x += Math.sin(t * 47 + this.shakeSeed) * s;
      this.camera.position.y += Math.sin(t * 61 + this.shakeSeed * 2) * s * 0.7;
      this.camera.position.z += Math.cos(t * 53 + this.shakeSeed * 3) * s;
      this.shake = damp(this.shake, 0, 7, dt);
    }
    this.camera.lookAt(this.lookAt);

    // 漂移时轻微 roll，画面更有张力
    const targetRoll = kart.drifting ? -kart.driftDir * 0.045 * clamp(kart.slip * 2, 0, 1) : 0;
    this.camera.rotation.z = damp(this.camera.rotation.z, targetRoll, 6, dt);

    // FOV：速度感的核心
    const targetFov = CAMERA.fovBase + spdN * CAMERA.fovSpeedGain + boostN * CAMERA.fovBoostGain
      + (this.mode === 'hood' ? 6 : 0);
    this.fov = damp(this.fov, targetFov, kart.boostTime > 0 ? 7 : 4.2, dt);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }

    // 阴影跟随玩家
    if (this.sun.castShadow) {
      this.sun.target.position.set(p.x, p.y, p.z);
      this.sun.position.set(p.x + 70, p.y + 130, p.z + 50);
      this.sun.target.updateMatrixWorld();
    }
    if (this.sky) this.sky.position.set(p.x, 0, p.z);

    // 速度线强度
    if (this.speedPass) {
      const u = this.speedPass.uniforms;
      const target = clamp((spdN - 0.66) / 0.5, 0, 1) * 0.4 + boostN * 0.6;
      u.uIntensity.value = damp(u.uIntensity.value as number, target, 8, dt);
      u.uAberration.value = damp(u.uAberration.value as number, target * 0.9, 8, dt);
      u.uTime.value = (u.uTime.value as number) + dt;
      const tint = u.uTint.value as THREE.Color;
      tint.lerp(new THREE.Color(kart.boostKind === 'nitro' ? 0xff6fd8 : 0x8fdcff), 0.08);
    }
    if (this.bloom) {
      this.bloom.strength = (this.quality === 'high' ? 0.42 : 0.3) + boostN * 0.2;
    }
  }

  render(): void {
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.clearSky();
    this.composer?.dispose();
    this.renderer.dispose();
  }
}

function shortest(from: number, to: number): number {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}
