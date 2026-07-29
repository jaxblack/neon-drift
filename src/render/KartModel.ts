import * as THREE from 'three';
import type { Kart } from '../physics/Kart';
import { KART } from '../core/Config';
import { clamp, damp } from '../core/MathUtil';
import { makeGlowTexture, makeHeadlightTexture, makeTailReflectTexture } from './Textures';

/** 集气档位对应的火花/尾焰颜色 —— 蓝 → 紫 → 金，一眼看出攒了多少 */
export const TIER_COLORS = [0x9fd8ff, 0x3ba9ff, 0xb06bff, 0xffc93f];
export const NITRO_COLOR = 0xff4fd8;

/** 车身放样截面。n 越大截面越接近方角，越小越接近椭圆。 */
interface Section { z: number; w: number; h: number; y: number; n: number }

/**
 * 截面轮廓：超椭圆，底部再压平。
 *
 * 之前用的是一组手写的 10 个固定点，形状全靠 w/h 缩放，结果每个截面都是同一个扁楔形，
 * 整台车就是一块板。改成超椭圆之后每个截面可以单独控制"方/圆"，
 * 车头能收得尖、轮拱能鼓起来、车厢能立起来，侧面轮廓才有车的样子。
 */
function ring(s: Section, P: number, scale = 1): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const e = 2 / s.n;
  for (let k = 0; k < P; k++) {
    const t = (k / P) * Math.PI * 2;
    const c = Math.cos(t), si = Math.sin(t);
    let x = s.w * scale * Math.sign(c) * Math.abs(c) ** e;
    let y = s.h * scale * Math.sign(si) * Math.abs(si) ** e;
    // 车是平底的，下半部分压扁，同时保证离地间隙
    if (y < 0) y *= 0.62;
    out.push([x, y + s.y]);
  }
  return out;
}

const RING_P = 20;

function loftBody(sections: Section[]): THREE.BufferGeometry {
  const S = sections.length;
  const pos: number[] = [];
  const idx: number[] = [];
  for (const s of sections) {
    for (const [px, py] of ring(s, RING_P)) pos.push(px, py, s.z);
  }
  for (let i = 0; i < S - 1; i++) {
    for (let j = 0; j < RING_P; j++) {
      const a = i * RING_P + j;
      const b = i * RING_P + ((j + 1) % RING_P);
      const c = a + RING_P;
      const d = b + RING_P;
      // 绕序必须让法线朝外。写反了的话车看着还是车（看到的是远端内壁），
      // 但近端表面被背面剔除，于是包在车体里的轮子会直接透出来，
      // 看上去就像轮子挂在车外面。
      idx.push(a, b, c, b, d, c);
    }
  }
  // 封头封尾
  const capStart = pos.length / 3;
  const s0 = sections[0], sN = sections[S - 1];
  pos.push(0, s0.y, s0.z);
  const capEnd = pos.length / 3;
  pos.push(0, sN.y, sN.z);
  for (let j = 0; j < RING_P; j++) {
    idx.push(capStart, j, (j + 1) % RING_P);
    idx.push(capEnd, (S - 1) * RING_P + ((j + 1) % RING_P), (S - 1) * RING_P + j);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * 座舱玻璃：贴着车身上半圈再往外放一丁点的一层壳。
 * 之前座舱是一个独立的球，浮在车顶上像个泡泡，和车身完全脱节；
 * 现在它就是车身自己的曲面，风挡/侧窗/后窗连成一片。
 */
function loftGreenhouse(sections: Section[], from: number, to: number): THREE.BufferGeometry {
  const arc: number[] = [];
  // 只取上半圈中间的一段，两侧留出车身腔体，否则整个上半车都变成玻璃
  const A0 = 0.20, A1 = 0.80;
  const STEPS = 14;
  for (let k = 0; k <= STEPS; k++) arc.push(A0 + ((A1 - A0) * k) / STEPS);

  const used = sections.slice(from, to + 1);
  const pos: number[] = [];
  const idx: number[] = [];
  for (const s of used) {
    const e = 2 / s.n;
    for (const a of arc) {
      const t = a * Math.PI;
      const c = Math.cos(t), si = Math.sin(t);
      // 往外放 2.5%：太贴会和车身 z-fighting，看不出风挡
      const x = s.w * 1.025 * Math.sign(c) * Math.abs(c) ** e;
      const y = s.h * 1.025 * Math.sign(si) * Math.abs(si) ** e;
      pos.push(x, y + s.y, s.z);
    }
  }
  const P = arc.length;
  for (let i = 0; i < used.length - 1; i++) {
    for (let j = 0; j < P - 1; j++) {
      const a = i * P + j, b = a + 1, c = a + P, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * 轮胎断面。用 Lathe 车出圆肩胎面，比一根光秃秃的圆柱有体积感得多。
 * 车出来绕 Y 轴，外面再 rotateZ(90°) 把轴摆到 X 上。
 */
function makeTire(r: number, halfW: number): THREE.BufferGeometry {
  const pts = [
    new THREE.Vector2(r * 0.62, -halfW),
    new THREE.Vector2(r * 0.86, -halfW * 1.02),
    new THREE.Vector2(r * 0.98, -halfW * 0.86),
    new THREE.Vector2(r, -halfW * 0.4),
    new THREE.Vector2(r, halfW * 0.4),
    new THREE.Vector2(r * 0.98, halfW * 0.86),
    new THREE.Vector2(r * 0.86, halfW * 1.02),
    new THREE.Vector2(r * 0.62, halfW),
  ];
  return new THREE.LatheGeometry(pts, 20);
}

/**
 * 轮辋：一个带凹陷的碟形。
 * 外缘必须盖过轮胎的内圈半径（makeTire 里是 r*0.62），否则轮心是个通透的洞，
 * 会直接看到后面的车身——之前那个"纯色圆盘"就是从洞里透出来的车漆。
 */
function makeRimDish(r: number, halfW: number): THREE.BufferGeometry {
  const pts = [
    new THREE.Vector2(0.015, halfW * 0.30),
    new THREE.Vector2(r * 0.22, halfW * 0.62),
    new THREE.Vector2(r * 0.40, halfW * 0.52),
    new THREE.Vector2(r * 0.56, halfW * 0.68),
    new THREE.Vector2(r * 0.70, halfW * 0.92),
  ];
  return new THREE.LatheGeometry(pts, 18);
}

/**
 * 车身放样截面。
 * y 是截面中心高度，h 是半高，底部压平后离地 ≈ y - h*0.62。
 * 侧面轮廓刻意做出 车头低(0.66) → 机盖(0.98) → 车顶(1.30) → 溜背 的落差，
 * 前后轮位置各鼓一个轮拱出来。
 */
const BODY_SECTIONS: Section[] = [
  { z: -2.15, w: 0.92, h: 0.30, y: 0.54, n: 3.0 },
  { z: -1.78, w: 1.14, h: 0.40, y: 0.53, n: 3.4 },
  // 轮拱的"最宽处"必须落在车轮中心高度（y≈0.42）上，
  // 而且要沿车长展开盖住整个轮子（轮子在 z 上占 ±0.16），
  // 只在单一截面鼓一下的话，鼓包前后的车体依旧比轮子窄。
  { z: -1.52, w: 1.22, h: 0.44, y: 0.52, n: 3.6 },
  { z: -1.16, w: 1.22, h: 0.46, y: 0.52, n: 3.6 }, // 后轮拱
  { z: -0.85, w: 1.08, h: 0.56, y: 0.62, n: 3.8 },
  { z: -0.28, w: 1.02, h: 0.62, y: 0.66, n: 4.0 }, // 车厢最高处
  { z: 0.28, w: 1.03, h: 0.54, y: 0.62, n: 3.8 },
  { z: 0.82, w: 1.06, h: 0.42, y: 0.56, n: 3.6 },  // 机盖
  { z: 1.12, w: 1.20, h: 0.44, y: 0.50, n: 3.6 },
  { z: 1.48, w: 1.20, h: 0.42, y: 0.50, n: 3.6 },  // 前轮拱
  { z: 1.86, w: 1.00, h: 0.28, y: 0.50, n: 3.2 },
  { z: 2.25, w: 0.68, h: 0.19, y: 0.46, n: 3.0 },  // 车头
];
/** 座舱玻璃覆盖的截面区间（后窗根 → 前风挡根） */
const GREENHOUSE_RANGE: [number, number] = [4, 7];


/** 共享几何/材质缓存：8 辆车不要各建一份 */
let shared: {
  body: THREE.BufferGeometry;
  canopy: THREE.BufferGeometry;
  wheel: THREE.BufferGeometry;
  hub: THREE.BufferGeometry;
  rim: THREE.BufferGeometry;
  wing: THREE.BufferGeometry;
  wingPost: THREE.BufferGeometry;
  wingUpper: THREE.BufferGeometry;
  sideSkirt: THREE.BufferGeometry;
  sidePod: THREE.BufferGeometry;
  scoop: THREE.BufferGeometry;
  diffuser: THREE.BufferGeometry;
  splitter: THREE.BufferGeometry;
  tailLight: THREE.BufferGeometry;
  headLight: THREE.BufferGeometry;
  flame: THREE.BufferGeometry;
  driftFlame: THREE.BufferGeometry;
  glowTex: THREE.Texture;
  headlightTex: THREE.Texture;
  tailReflectTex: THREE.Texture;
  tireMat: THREE.MeshStandardMaterial;
  darkMat: THREE.MeshStandardMaterial;
  chromeMat: THREE.MeshStandardMaterial;
  tailMat: THREE.MeshBasicMaterial;
  headMat: THREE.MeshBasicMaterial;
  canopyMat: THREE.MeshPhysicalMaterial;
} | null = null;

function getShared() {
  if (shared) return shared;
  shared = {
    body: loftBody(BODY_SECTIONS),
    canopy: loftGreenhouse(BODY_SECTIONS, GREENHOUSE_RANGE[0], GREENHOUSE_RANGE[1]),
    wheel: makeTire(0.42, 0.155),
    hub: new THREE.CylinderGeometry(0.055, 0.055, 0.33, 10),
    rim: makeRimDish(0.42, 0.155),
    wing: new THREE.BoxGeometry(1.66, 0.07, 0.40),
    wingPost: new THREE.BoxGeometry(0.10, 0.34, 0.22),
    wingUpper: new THREE.BoxGeometry(1.46, 0.05, 0.20),
    sideSkirt: new THREE.BoxGeometry(0.10, 0.09, 2.1),
    sidePod: new THREE.BoxGeometry(0.22, 0.26, 0.9),
    scoop: new THREE.BoxGeometry(0.46, 0.16, 0.72),
    diffuser: new THREE.BoxGeometry(1.6, 0.20, 0.46),
    splitter: new THREE.BoxGeometry(1.9, 0.06, 0.56),
    tailLight: new THREE.BoxGeometry(0.52, 0.10, 0.08),
    headLight: new THREE.BoxGeometry(0.40, 0.09, 0.08),
    flame: new THREE.ConeGeometry(0.26, 1.5, 10, 1, true),
    // 飘焰：比尾焰更扁更短，从后轮往后外侧喷
    driftFlame: new THREE.ConeGeometry(0.30, 1.25, 8, 1, true),
    glowTex: makeGlowTexture(),
    headlightTex: makeHeadlightTexture(),
    tailReflectTex: makeTailReflectTexture(),
    tireMat: new THREE.MeshStandardMaterial({ color: 0x14161f, roughness: 0.95, metalness: 0.02 }),
    darkMat: new THREE.MeshStandardMaterial({ color: 0x0d1018, roughness: 0.45, metalness: 0.7 }),
    chromeMat: new THREE.MeshStandardMaterial({
      color: 0x8a93a8, roughness: 0.22, metalness: 0.95,
      // 左侧轮辋用 scale.x = -1 镜像，绕序会翻转被背面剔除，
      // 结果轮心变成一个透明的洞，直接看到后面的车漆。
      side: THREE.DoubleSide,
    }),
    tailMat: new THREE.MeshBasicMaterial({ color: 0xff2a3c, toneMapped: false }),
    headMat: new THREE.MeshBasicMaterial({ color: 0xdfefff, toneMapped: false }),
    canopyMat: new THREE.MeshPhysicalMaterial({
      // 夜景里的车窗实际上看不到车内，就是一块反天光的深色镜面。
      // 用 transmission 反而会把它变淡变糊，直接上高反射 + 清漆。
      // 但底色不能压到接近纯黑：环境本身就暗，再黑就成了一个洞而不是玻璃，
      // 所以抬一点底色并把环境反射强度拉高，让它至少能映出天空和霓虹。
      color: 0x1b2740, roughness: 0.05, metalness: 0.25,
      transparent: true, opacity: 0.95,
      clearcoat: 1, clearcoatRoughness: 0.02,
      envMapIntensity: 3.4, side: THREE.DoubleSide,
    }),
  };
  shared.wheel.rotateZ(Math.PI / 2);
  shared.hub.rotateZ(Math.PI / 2);
  shared.rim.rotateZ(Math.PI / 2);
  shared.flame.rotateX(Math.PI / 2); // 锥尖朝 -Z（车尾方向）
  shared.driftFlame.rotateX(Math.PI / 2);
  return shared;
}

export interface KartVisualOptions {
  color: number;
  isPlayer: boolean;
}

/** 一辆车的全部可视元素 */
export class KartVisual {
  readonly root = new THREE.Group();
  private body: THREE.Mesh;
  private wheels: THREE.Mesh[] = [];
  private flames: THREE.Mesh[] = [];
  private flameMat: THREE.MeshBasicMaterial;
  /** 漂移飘焰（后轮外侧） */
  private driftFlames: THREE.Mesh[] = [];
  private driftFlameMat: THREE.MeshBasicMaterial;
  private driftFlameScale = 0;
  private underglow: THREE.Mesh;
  private underglowMat: THREE.MeshBasicMaterial;
  /** 车头灯打在路面上的光斑 */
  private headBeam: THREE.Mesh;
  private headBeamMat: THREE.MeshBasicMaterial;
  /** 尾灯在湿路面上的倒影 */
  private tailReflectMat: THREE.MeshBasicMaterial;
  private baseColor: THREE.Color;
  private nameSprite?: THREE.Sprite;
  private bodyMat: THREE.MeshPhysicalMaterial;
  private hubMat: THREE.MeshBasicMaterial;
  private owned: Array<{ dispose(): void }> = [];
  private flameScale = 0;

  constructor(opts: KartVisualOptions) {
    const S = getShared();
    const color = new THREE.Color(opts.color);

    // 车漆。
    //
    // 之前这里是 MeshStandardMaterial + emissive = color*0.42，因为场景没有环境贴图，
    // 不自发光车就黑成一团。代价是整个车身被均匀颜色洗平，看不到任何曲面，
    // 像一张发光的纸片。现在 Stage 会把天空烘成 PMREM 环境贴图，反射有了来源，
    // 改用带清漆层的物理材质：底漆金属感 + 表层 clearcoat 高光，
    // 车身曲面上会滚出天空和霓虹灯的倒影——这才是车漆的观感。
    // emissive 只保留一点点，用来保证阵营色在暗处不丢。
    this.bodyMat = new THREE.MeshPhysicalMaterial({
      color,
      roughness: 0.26,
      metalness: 0.55,
      clearcoat: 1,
      clearcoatRoughness: 0.05,
      envMapIntensity: 2.1,
      // 夜景赛道里可反射的东西本来就少，完全去掉自发光车会变成黑剪影；
      // 留 0.2 刚好能看清阵营色，又不至于把曲面明暗洗平。
      emissive: color.clone().multiplyScalar(0.2),
    });
    this.hubMat = new THREE.MeshBasicMaterial({ color, toneMapped: false });
    this.owned.push(this.bodyMat, this.hubMat);

    this.body = new THREE.Mesh(S.body, this.bodyMat);
    this.body.castShadow = true;
    this.body.receiveShadow = true;
    this.root.add(this.body);

    // 座舱玻璃：几何已经是车身坐标系里的一层壳，不需要再摆位置
    const canopy = new THREE.Mesh(S.canopy, S.canopyMat);
    this.root.add(canopy);

    // 引擎盖进气口
    const scoop = new THREE.Mesh(S.scoop, S.darkMat);
    scoop.position.set(0, 0.96, 0.86);
    scoop.rotation.x = -0.06;
    this.root.add(scoop);

    // 尾翼：贴着溜背的小鸭尾。
    // 之前是一块 2.1 宽的平板架在两根柱子上，在这个体量的车上完全出戏。
    const wing = new THREE.Mesh(S.wing, this.bodyMat);
    wing.position.set(0, 0.92, -1.94);
    wing.rotation.x = -0.18;
    this.root.add(wing);
    const wingUpper = new THREE.Mesh(S.wingUpper, S.darkMat);
    wingUpper.position.set(0, 0.99, -2.04);
    wingUpper.rotation.x = -0.24;
    this.root.add(wingUpper);

    // 侧裙发光条
    for (const sx of [-1, 1]) {
      const skirt = new THREE.Mesh(S.sideSkirt, this.hubMat);
      skirt.position.set(sx * 1.0, 0.30, -0.1);
      this.root.add(skirt);
    }

    // 头灯 / 尾灯
    for (const sx of [-0.42, 0.42]) {
      const hl = new THREE.Mesh(S.headLight, S.headMat);
      hl.position.set(sx, 0.58, 2.10);
      this.root.add(hl);
    }
    for (const sx of [-0.42, 0.42]) {
      const tl = new THREE.Mesh(S.tailLight, S.tailMat);
      tl.position.set(sx, 0.66, -2.16);
      this.root.add(tl);
    }

    // 车轮。轮距必须比轮拱窄，否则轮子神在车外面像越野胎。
    const wheelPos: Array<[number, number, number]> = [
      [-0.90, 0.42, 1.30], [0.90, 0.42, 1.30],
      [-0.94, 0.42, -1.34], [0.94, 0.42, -1.34],
    ];
    for (const [x, y, z] of wheelPos) {
      const w = new THREE.Mesh(S.wheel, S.tireMat);
      w.position.set(x, y, z);
      w.castShadow = true;
      const hub = new THREE.Mesh(S.hub, this.hubMat);
      w.add(hub);
      const rim = new THREE.Mesh(S.rim, S.chromeMat);
      // 轮輋是个有深度的碟形，必须朝车外侧；两边用同一份几何体，左边要镜像
      rim.scale.x = x < 0 ? -1 : 1;
      w.add(rim);
      this.wheels.push(w);
      this.root.add(w);
    }

    // 尾焰
    this.flameMat = new THREE.MeshBasicMaterial({
      color: 0x66ccff, transparent: true, opacity: 0.55,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
    });
    this.owned.push(this.flameMat);
    for (const sx of [-0.42, 0.42]) {
      const f = new THREE.Mesh(S.flame, this.flameMat);
      f.position.set(sx, 0.60, -2.35);
      f.visible = false;
      this.flames.push(f);
      this.root.add(f);
    }

    // 漂移飘焰：从后轮往后外侧喷，颜色随集气档位走
    this.driftFlameMat = new THREE.MeshBasicMaterial({
      color: TIER_COLORS[0], transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
    });
    this.owned.push(this.driftFlameMat);
    for (const sx of [-1, 1]) {
      const f = new THREE.Mesh(S.driftFlame, this.driftFlameMat);
      f.position.set(sx * 1.06, 0.34, -1.62);
      // 往后下方、略外展
      f.rotation.set(-0.22, sx * 0.3, 0);
      f.visible = false;
      this.driftFlames.push(f);
      this.root.add(f);
    }

    // 车头灯打在路面上的光斑。夜景赛车里"车在照路"这件事是速度感和临场感的主要来源，
    // 之前完全没有，车像是浮在一条自发光的带子上。
    const beamGeo = new THREE.PlaneGeometry(5.2, 13);
    beamGeo.rotateX(-Math.PI / 2);
    beamGeo.translate(0, 0, 7.6); // 贴片压在车头前方
    this.headBeamMat = new THREE.MeshBasicMaterial({
      map: S.headlightTex, transparent: true, opacity: 0.34,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: true,
    });
    this.owned.push(beamGeo, this.headBeamMat);
    this.headBeam = new THREE.Mesh(beamGeo, this.headBeamMat);
    this.headBeam.position.y = 0.05;
    this.headBeam.renderOrder = 1;
    this.root.add(this.headBeam);

    // 尾灯在湿路面上的倒影。夜景赛车里跟在别人车后时，路面上那两道抖动的红光
    // 是"路是湿的、车是亮的"最直接的证据，成本却只有一个贴片。
    const reflGeo = new THREE.PlaneGeometry(2.3, 6.4);
    reflGeo.rotateX(-Math.PI / 2);
    reflGeo.rotateY(Math.PI); // 贴片的"近端"要朝车尾
    reflGeo.translate(0, 0, -5.4);
    this.tailReflectMat = new THREE.MeshBasicMaterial({
      map: S.tailReflectTex, transparent: true, opacity: 0.4,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: true,
    });
    this.owned.push(reflGeo, this.tailReflectMat);
    const refl = new THREE.Mesh(reflGeo, this.tailReflectMat);
    refl.position.y = 0.04;
    refl.renderOrder = 1;
    this.root.add(refl);

    // 车底辉光：贴地光斑（不能用 Sprite，它会面向相机把整台车糊住）
    this.baseColor = color.clone();
    const ugGeo = new THREE.PlaneGeometry(3.6, 5.2);
    ugGeo.rotateX(-Math.PI / 2);
    this.underglowMat = new THREE.MeshBasicMaterial({
      map: S.glowTex, color, transparent: true, opacity: 0.3,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    });
    this.owned.push(ugGeo, this.underglowMat);
    this.underglow = new THREE.Mesh(ugGeo, this.underglowMat);
    this.underglow.position.y = 0.04;
    this.underglow.renderOrder = 2;
    this.root.add(this.underglow);

    // AI 车也要投影。之前只有玩家车投影，结果前面一排对手全部悬空贴在路面上，
    // 完全没有"车压在地上"的重量感。8 车 x 5 网格 = 40 个 caster，
    // 对 shadow map 来说不是压力。
  }

  /** 头顶名牌（AI / 联机玩家） */
  setLabel(text: string, color: number): void {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 64;
    const g = c.getContext('2d')!;
    g.font = 'bold 34px "PingFang SC","Microsoft YaHei",sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = 6;
    g.strokeStyle = 'rgba(0,0,0,0.8)';
    g.strokeText(text, 128, 34);
    g.fillStyle = '#' + color.toString(16).padStart(6, '0');
    g.fillText(text, 128, 34);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({
      map: tex, transparent: true, depthTest: false, toneMapped: false, opacity: 0.72,
    });
    this.owned.push(tex, mat);
    const s = new THREE.Sprite(mat);
    // 名牌之前 4.4 宽、贴在 2.95 高，比车还抢眼，整个画面像挂了一排广告牌。
    // 缩到刚够认人的大小、压低到车顶附近，并降不透明度。
    s.scale.set(2.2, 0.55, 1);
    s.position.y = 1.95;
    s.renderOrder = 10;
    this.root.add(s);
    this.nameSprite = s;
  }

  setLabelVisible(v: boolean): void {
    if (this.nameSprite) this.nameSprite.visible = v;
  }

  update(kart: Kart, alpha: number, dt: number): void {
    const p = kart.interp(alpha);
    this.root.position.set(p.x, p.y, p.z);
    this.root.rotation.set(0, 0, 0);
    this.root.rotateY(p.heading);
    this.root.rotateX(p.pitch);
    this.root.rotateZ(-p.roll);
    // 撞击反冲：车头往撞的那一侧一顿、车尾抬一下。
    // 撞墙时如果车身姿态纹丝不动，再多的火花也只是贴在画面上的贴纸，
    // 感觉不到"撞了一下"。
    if (kart.impactRecoil > 0.01) {
      const r = kart.impactRecoil;
      this.root.rotateZ(kart.impactSide * r * 0.16);
      this.root.rotateX(-r * 0.09);
    }

    // 尾灯倒影：离地时收掉（车都飞起来了还在路上留倒影很出戏），喷射时更亮
    this.tailReflectMat.opacity = kart.grounded
      ? 0.34 + (kart.boostTime > 0 ? 0.24 : 0)
      : 0;

    // 车轮：滚动 + 前轮转向（steerVisual 正 = 向右，而 rotateY 正 = 向左，所以取反）
    const spin = kart.wheelSpin;
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i];
      w.rotation.set(0, 0, 0);
      if (i < 2) w.rotateY(-kart.steerVisual * 0.62);
      w.rotateX(spin);
    }

    // 尾焰
    const boosting = kart.boostTime > 0;
    const target = boosting ? 1 : 0;
    this.flameScale = damp(this.flameScale, target, boosting ? 26 : 13, dt);
    const vis = this.flameScale > 0.03;
    const flicker = 0.82 + Math.random() * 0.36;
    for (const f of this.flames) {
      f.visible = vis;
      if (vis) {
        const s = this.flameScale * flicker;
        f.scale.set(0.7 + s * 0.7, 0.7 + s * 0.7, 0.4 + s * 1.9);
        f.position.z = -2.3 - this.flameScale * 0.6;
      }
    }
    if (vis) {
      const col = kart.boostKind === 'nitro' ? NITRO_COLOR
        : kart.boostKind === 'pad' ? 0x35f5a0
          : TIER_COLORS[Math.min(3, 1 + kart.comboLevel)];
      this.flameMat.color.lerp(new THREE.Color(col), 0.35);
      this.flameMat.opacity = 0.3 + this.flameScale * 0.28;
    }

    // 漂移飘焰：集气越高越大越亮，颜色跟着档位走（蓝→紫→金）
    const driftTarget = kart.drifting ? 0.45 + kart.driftCharge * 0.75 : 0;
    this.driftFlameScale = damp(this.driftFlameScale, driftTarget, kart.drifting ? 18 : 11, dt);
    const dfVis = this.driftFlameScale > 0.04;
    for (let i = 0; i < this.driftFlames.length; i++) {
      const f = this.driftFlames[i];
      f.visible = dfVis;
      if (!dfVis) continue;
      const flick = 0.8 + Math.random() * 0.4;
      const s = this.driftFlameScale * flick;
      f.scale.set(0.55 + s * 0.5, 0.55 + s * 0.5, 0.5 + s * 1.5);
      // 内侧轮的焰小一点，看起来有方向感
      const inner = (i === 0 ? -1 : 1) === kart.driftDir;
      f.scale.multiplyScalar(inner ? 0.75 : 1);
    }
    if (dfVis) {
      this.driftFlameMat.color.lerp(new THREE.Color(TIER_COLORS[kart.driftTier]), 0.3);
      this.driftFlameMat.opacity = 0.25 + this.driftFlameScale * 0.4;
    }

    // 车底辉光随速度/集气变化（封顶，否则 additive + bloom 会炸成一团白光）
    const chargeGlow = kart.drifting ? 0.1 + kart.driftCharge * 0.26 : 0;
    const spdGlow = clamp(kart.speed / KART.maxSpeed, 0, 1.4) * 0.1;
    const mat = this.underglowMat;
    const targetOpacity = Math.min(0.14 + chargeGlow + spdGlow + (boosting ? 0.16 : 0), 0.55);
    mat.opacity = damp(mat.opacity, targetOpacity, 12, dt);
    // 集气时光斑染成当前档位颜色，松手后回到车身色
    mat.color.lerp(kart.drifting ? new THREE.Color(TIER_COLORS[kart.driftTier]) : this.baseColor, 0.12);

    // 受击闪烁
    if (kart.spinOut > 0) {
      const f = Math.sin(performance.now() * 0.03) > 0 ? 1 : 0.35;
      this.bodyMat.emissiveIntensity = f;
    } else {
      this.bodyMat.emissiveIntensity = 1;
    }
  }

  dispose(): void {
    this.owned.forEach((o) => o.dispose());
    this.owned = [];
    this.root.clear();
  }
}

/** 全局释放共享资源（切赛道时不需要，退出时可调） */
export function disposeSharedKartAssets(): void {
  if (!shared) return;
  Object.values(shared).forEach((v) => {
    if (v && typeof (v as { dispose?: () => void }).dispose === 'function') {
      (v as { dispose: () => void }).dispose();
    }
  });
  shared = null;
}
