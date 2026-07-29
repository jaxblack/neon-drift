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
  /** 侧后方补光。只有一盏主光时车身背面会黑成剪影，这盏负责把轮廓勾出来 */
  private rim: THREE.DirectionalLight;
  /** 主光相对玩家的偏移。applyTheme 设好方向，阴影跟随时直接复用；
   *  不存下来的话每帧重写 position 会把主题的光向盖掉。 */
  private sunOffset = new THREE.Vector3(38, 165, 28);
  private sky: THREE.Mesh | null = null;
  private skyDisposables: Array<{ dispose(): void }> = [];
  /** 由天空烘出来的环境贴图。没有它，金属/粗糙度材质没有任何可反射的东西，
   *  车身只能靠 emissive 硬撑，于是看起来像一块发光塑料片而不是车漆。 */
  private pmrem: THREE.PMREMGenerator | null = null;
  private envRT: THREE.WebGLRenderTarget | null = null;
  quality: Quality = 'high';

  // ---- 跟随相机状态 ----
  private camYaw = 0;
  private camPos = new THREE.Vector3();
  private lookAt = new THREE.Vector3();
  private shake = 0;
  private shakeSeed = Math.random() * 100;
  private fov: number = CAMERA.fovBase;
  /** 平滑的漂移权重。所有漂移相关的镜头参数都用它插值，
   *  直接用 kart.drifting 布尔值的话，起漂/收漂瞬间镜头会猛跳一下。 */
  private driftBlend = 0;
  /** 平滑的归一化速度，避免速度抖动直接传到镜头距离/FOV 上 */
  private spdSmooth = 0;
  private boostSmooth = 0;
  private slipSmooth = 0;
  /** 相机自身的 roll。必须自己存一份：
   *  camera.lookAt() 每帧会重写整个 rotation，直接 damp camera.rotation.z
   *  读到的是 lookAt 刚写入的值而不是上一帧的 roll，会彻底跑飞。 */
  private camRoll = 0;
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
    this.renderer.shadowMap.enabled = quality !== 'low';
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.camera = new THREE.PerspectiveCamera(CAMERA.fovBase, 1, 0.4, 5200);
    this.camera.position.set(0, 12, -22);

    // 灯光。
    // 环境光压得很低是故意的：环境贴图（scene.environment）已经提供了大部分
    // 柔和照明，半球光再开大就会把方向光的阴影冲平，画面变成一片没有立体感的灰。
    this.hemi = new THREE.HemisphereLight(0xa6c8ff, 0x3c3a52, 0.55);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff2d8, 2.6);
    this.sun.position.set(60, 120, 40);
    if (quality !== 'low') {
      this.sun.castShadow = true;
      const size = quality === 'high' ? 2048 : 1024;
      this.sun.shadow.mapSize.set(size, size);
      const c = this.sun.shadow.camera;
      c.near = 1; c.far = 300;
      // 阴影相机跟着玩家走，所以范围只要包住身边这一小块赛道即可。
      // 收紧到 ±58 让同样的 shadow map 分辨率翻近三倍，车底接触阴影才不会糊成一坨。
      c.left = -58; c.right = 58; c.top = 58; c.bottom = -58;
      this.sun.shadow.bias = -0.0006;
      this.sun.shadow.normalBias = 0.028;
    }
    this.scene.add(this.sun, this.sun.target);

    this.rim = new THREE.DirectionalLight(0x9fc4ff, 0.85);
    this.rim.position.set(-70, 45, -90);
    this.scene.add(this.rim);

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
    this.renderer.shadowMap.enabled = q !== 'low';
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, q === 'high' ? 2 : 1.35));
    this.sun.castShadow = q !== 'low';
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
      this.sun.intensity = 2.6;
      this.sunOffset.set(-52, 175, 40);
    } else if (theme.env === 'canyon') {
      this.sun.color.setHex(0xffc08a);
      this.sun.intensity = 2.4;
      this.sunOffset.set(46, 180, -30);
    } else if (theme.env === 'space') {
      // 太空：主光极弱，靠环境贴图和路面自发光撑场面
      this.sun.color.setHex(0xa8c0ff);
      this.sun.intensity = 1.1;
      this.sunOffset.set(-34, 190, 26);
    } else {
      // 城市是夜景：这盏其实是月光，不能当太阳使。
      // 之前强度 2.7 + 低角度，拖出一地又长又硬的斜影子，像正午而不是深夜。
      this.sun.color.setHex(0xbcd2ff);
      this.sun.intensity = 1.45;
      this.sunOffset.set(26, 200, 18);
    }
    this.sun.position.copy(this.sunOffset);
    this.hemi.intensity = theme.env === 'space' ? 0.42 : 0.55;
    this.rim.color.setHex(theme.env === 'canyon' ? 0xff9a6a : theme.env === 'coast' ? 0x8fd0ff : 0x9fc4ff);
    this.rim.intensity = theme.env === 'space' ? 1.15 : 0.85;

    this.bakeEnvironment(theme);
  }

  /**
   * 把当前天空烘成一张 PMREM 环境贴图给整个场景用。
   *
   * 这是让车看起来像车的关键一步：金属度/粗糙度只有在有东西可反射时才有意义。
   * 之前场景里 scene.environment 是空的，所有 MeshStandardMaterial 的反射项恒为 0，
   * 车身只能靠 emissive 自发光把颜色顶上去，结果就是一块均匀发光的板子。
   * 有了环境贴图，车漆才会出现沿曲面滚动的高光和天空色渐变。
   */
  private bakeEnvironment(theme: TrackTheme): void {
    if (this.quality === 'low' || !this.sky) return;
    if (!this.pmrem) {
      this.pmrem = new THREE.PMREMGenerator(this.renderer);
      this.pmrem.compileEquirectangularShader();
    }
    this.envRT?.dispose();
    // 只把天空球放进临时场景烘焙，赛道几何体不参与——否则每次换主题都要重算一大堆
    const tmp = new THREE.Scene();
    const skyClone = new THREE.Mesh(
      this.sky.geometry,
      (this.sky.material as THREE.Material),
    );
    tmp.add(skyClone);
    this.envRT = this.pmrem.fromScene(tmp, 0, 0.1, 6000);
    tmp.remove(skyClone);
    this.scene.environment = this.envRT.texture;
    // 太空图天空本身很暗，环境强度补回来一点，免得车身全黑
    this.scene.environmentIntensity = theme.env === 'space' ? 1.15 : 0.85;
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

    // ---- 先把所有“会突变的量”平滑掉 ----
    const spdRaw = clamp(kart.speed / KART.maxSpeed, 0, 1.6);
    const boostRaw = kart.boostTime > 0 ? clamp(kart.boostPower / KART.nitroExtraSpeed, 0, 1) : 0;
    this.driftBlend = damp(this.driftBlend, kart.drifting ? 1 : 0, 5.5, dt);
    this.spdSmooth = damp(this.spdSmooth, spdRaw, 2.6, dt);
    this.boostSmooth = damp(this.boostSmooth, boostRaw, 3.2, dt);
    this.slipSmooth = damp(this.slipSmooth, clamp(kart.slip * 2, 0, 1), 4, dt);
    const spdN = this.spdSmooth;
    const boostN = this.boostSmooth;

    // 相机偏航：正常跟车头；漂移时略向速度方向偏，看得到车身滑行姿态。
    // 两者之间用 driftBlend 连续插值，不能硬切。
    let targetYaw = p.heading;
    if (kart.speed > 8) {
      const velYaw = Math.atan2(kart.vx, kart.vz);
      const blend = 0.10 + this.driftBlend * 0.16;
      targetYaw = p.heading + shortest(p.heading, velYaw) * blend;
    }
    if (!this.initialised) {
      this.camYaw = targetYaw;
    } else {
      // 阻尼率固定 —— 随状态变的话会产生“镜头快慢不一”的不稳定感
      this.camYaw = dampAngle(this.camYaw, targetYaw, 6.5, dt);
    }

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
    // 速度带来的拉远/压低刻意做得很小，否则全程都在微幅度推拉
    dist += spdN * 0.9 + boostN * 0.8;
    height -= spdN * 0.3;

    const cfx = Math.sin(this.camYaw), cfz = Math.cos(this.camYaw);
    // 漂移时镜头往弯道外侧挪一点，露出车头指向
    const side = kart.driftDir * CAMERA.driftOffset * this.driftBlend * this.slipSmooth;
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

    // 漂移时极轻微的 roll，只是一点张力，大了会晕。
    // 必须在 lookAt 之后用 rotateZ 叠加（局部空间旋转）。
    const targetRoll = -kart.driftDir * 0.02 * this.driftBlend * this.slipSmooth;
    this.camRoll = damp(this.camRoll, targetRoll, 5, dt);
    if (Math.abs(this.camRoll) > 1e-4) this.camera.rotateZ(this.camRoll);

    // FOV：速度感的来源，但幅度要克制，而且阻尼率固定
    const targetFov = CAMERA.fovBase + spdN * CAMERA.fovSpeedGain + boostN * CAMERA.fovBoostGain
      + (this.mode === 'hood' ? 6 : 0);
    this.fov = damp(this.fov, targetFov, 5, dt);
    if (Math.abs(this.camera.fov - this.fov) > 0.02) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }

    // 阴影跟随玩家。光源偏移量要和 applyTheme 里的方向一致（高角度），
    // 否则这里每帧重写 position 会把主题调好的光向盖掉，影子又变回斜长条。
    if (this.sun.castShadow) {
      this.sun.target.position.set(p.x, p.y, p.z);
      this.sun.position.set(
        p.x + this.sunOffset.x, p.y + this.sunOffset.y, p.z + this.sunOffset.z,
      );
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
