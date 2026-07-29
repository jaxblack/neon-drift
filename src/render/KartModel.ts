import * as THREE from 'three';
import type { Kart } from '../physics/Kart';
import { KART } from '../core/Config';
import { clamp, damp } from '../core/MathUtil';
import { makeGlowTexture } from './Textures';

/** 集气档位对应的火花/尾焰颜色 —— 蓝 → 紫 → 金，一眼看出攒了多少 */
export const TIER_COLORS = [0x9fd8ff, 0x3ba9ff, 0xb06bff, 0xffc93f];
export const NITRO_COLOR = 0xff4fd8;

/** 沿 Z 轴放样出一个楔形车身 */
function loftBody(sections: Array<{ z: number; w: number; h: number; y: number }>): THREE.BufferGeometry {
  const profile = (w: number, h: number): Array<[number, number]> => [
    [0, -h], [w * 0.72, -h * 0.88], [w, -h * 0.15], [w, h * 0.3],
    [w * 0.62, h], [0, h * 1.06],
    [-w * 0.62, h], [-w, h * 0.3], [-w, -h * 0.15], [-w * 0.72, -h * 0.88],
  ];
  const P = 10;
  const S = sections.length;
  const pos: number[] = [];
  const idx: number[] = [];

  for (const s of sections) {
    const pr = profile(s.w, s.h);
    for (const [px, py] of pr) pos.push(px, py + s.y, s.z);
  }
  for (let i = 0; i < S - 1; i++) {
    for (let j = 0; j < P; j++) {
      const a = i * P + j;
      const b = i * P + ((j + 1) % P);
      const c = a + P;
      const d = b + P;
      idx.push(a, c, b, b, c, d);
    }
  }
  // 封头封尾
  const capStart = pos.length / 3;
  const s0 = sections[0], sN = sections[S - 1];
  pos.push(0, s0.y, s0.z);
  const capEnd = pos.length / 3;
  pos.push(0, sN.y, sN.z);
  for (let j = 0; j < P; j++) {
    idx.push(capStart, (j + 1) % P, j);
    idx.push(capEnd, (S - 1) * P + j, (S - 1) * P + ((j + 1) % P));
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

const BODY_SECTIONS = [
  { z: -2.00, w: 0.86, h: 0.30, y: 0.40 },
  { z: -1.55, w: 1.02, h: 0.38, y: 0.40 },
  { z: -0.75, w: 1.04, h: 0.42, y: 0.40 },
  { z: 0.00, w: 1.00, h: 0.40, y: 0.38 },
  { z: 0.70, w: 0.94, h: 0.31, y: 0.34 },
  { z: 1.40, w: 0.80, h: 0.22, y: 0.29 },
  { z: 1.90, w: 0.58, h: 0.15, y: 0.25 },
  { z: 2.15, w: 0.30, h: 0.09, y: 0.23 },
];

/** 共享几何/材质缓存：8 辆车不要各建一份 */
let shared: {
  body: THREE.BufferGeometry;
  canopy: THREE.BufferGeometry;
  wheel: THREE.BufferGeometry;
  hub: THREE.BufferGeometry;
  wing: THREE.BufferGeometry;
  wingPost: THREE.BufferGeometry;
  sideSkirt: THREE.BufferGeometry;
  flame: THREE.BufferGeometry;
  glowTex: THREE.Texture;
  tireMat: THREE.MeshStandardMaterial;
  darkMat: THREE.MeshStandardMaterial;
  canopyMat: THREE.MeshPhysicalMaterial;
} | null = null;

function getShared() {
  if (shared) return shared;
  shared = {
    body: loftBody(BODY_SECTIONS),
    canopy: new THREE.SphereGeometry(0.52, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.5),
    wheel: new THREE.CylinderGeometry(0.44, 0.44, 0.36, 18),
    hub: new THREE.CylinderGeometry(0.22, 0.22, 0.38, 12),
    wing: new THREE.BoxGeometry(2.0, 0.09, 0.52),
    wingPost: new THREE.BoxGeometry(0.12, 0.42, 0.24),
    sideSkirt: new THREE.BoxGeometry(0.16, 0.1, 2.2),
    flame: new THREE.ConeGeometry(0.26, 1.5, 10, 1, true),
    glowTex: makeGlowTexture(),
    tireMat: new THREE.MeshStandardMaterial({ color: 0x14161f, roughness: 0.92, metalness: 0.02 }),
    darkMat: new THREE.MeshStandardMaterial({ color: 0x0d1018, roughness: 0.45, metalness: 0.7 }),
    canopyMat: new THREE.MeshPhysicalMaterial({
      color: 0x0a1a2e, roughness: 0.08, metalness: 0.1,
      transmission: 0.6, thickness: 0.4, transparent: true, opacity: 0.72,
    }),
  };
  shared.wheel.rotateZ(Math.PI / 2);
  shared.hub.rotateZ(Math.PI / 2);
  shared.flame.rotateX(Math.PI / 2); // 锥尖朝 -Z（车尾方向）
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
  private underglow: THREE.Mesh;
  private underglowMat: THREE.MeshBasicMaterial;
  private baseColor: THREE.Color;
  private nameSprite?: THREE.Sprite;
  private bodyMat: THREE.MeshStandardMaterial;
  private hubMat: THREE.MeshBasicMaterial;
  private owned: Array<{ dispose(): void }> = [];
  private flameScale = 0;

  constructor(opts: KartVisualOptions) {
    const S = getShared();
    const color = new THREE.Color(opts.color);

    this.bodyMat = new THREE.MeshStandardMaterial({
      color, roughness: 0.34, metalness: 0.45,
      // 霓虹夜景下纯反射的车身会黑成一团，靠自发光保证轮廓和阵营色可辨
      emissive: color.clone().multiplyScalar(0.42),
    });
    this.hubMat = new THREE.MeshBasicMaterial({ color, toneMapped: false });
    this.owned.push(this.bodyMat, this.hubMat);

    this.body = new THREE.Mesh(S.body, this.bodyMat);
    this.body.castShadow = true;
    this.root.add(this.body);

    // 座舱
    const canopy = new THREE.Mesh(S.canopy, S.canopyMat);
    canopy.position.set(0, 0.62, -0.28);
    canopy.scale.set(1, 0.85, 1.5);
    this.root.add(canopy);

    // 尾翼
    const wing = new THREE.Mesh(S.wing, S.darkMat);
    wing.position.set(0, 0.95, -1.85);
    this.root.add(wing);
    const wingGlow = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.05, 0.14), this.hubMat);
    wingGlow.position.set(0, 0.99, -2.05);
    this.owned.push(wingGlow.geometry);
    this.root.add(wingGlow);
    for (const sx of [-0.78, 0.78]) {
      const post = new THREE.Mesh(S.wingPost, S.darkMat);
      post.position.set(sx, 0.72, -1.8);
      this.root.add(post);
    }

    // 侧裙发光条
    for (const sx of [-1.02, 1.02]) {
      const skirt = new THREE.Mesh(S.sideSkirt, this.hubMat);
      skirt.position.set(sx, 0.28, -0.1);
      this.root.add(skirt);
    }

    // 车轮
    const wheelPos: Array<[number, number, number]> = [
      [-0.98, 0.44, 1.28], [0.98, 0.44, 1.28],
      [-1.06, 0.46, -1.32], [1.06, 0.46, -1.32],
    ];
    for (const [x, y, z] of wheelPos) {
      const w = new THREE.Mesh(S.wheel, S.tireMat);
      w.position.set(x, y, z);
      w.castShadow = true;
      const hub = new THREE.Mesh(S.hub, this.hubMat);
      w.add(hub);
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
      f.position.set(sx, 0.44, -2.3);
      f.visible = false;
      this.flames.push(f);
      this.root.add(f);
    }

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

    if (!opts.isPlayer) {
      this.root.traverse((o) => { if (o instanceof THREE.Mesh) o.castShadow = false; });
    }
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
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, toneMapped: false });
    this.owned.push(tex, mat);
    const s = new THREE.Sprite(mat);
    s.scale.set(4.4, 1.1, 1);
    s.position.y = 2.6;
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
