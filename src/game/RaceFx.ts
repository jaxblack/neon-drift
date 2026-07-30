import * as THREE from 'three';
import type { Kart } from '../physics/Kart';
import type { Racer } from './Racer';
import type { Track } from '../track/Track';
import type { Effects } from '../render/Effects';
import { TIER_COLORS, NITRO_COLOR } from '../render/KartModel';
import { KART } from '../core/Config';
import { clamp, rand } from '../core/MathUtil';

/** 把车辆局部坐标 (右, 前) 转成世界坐标 */
function local(k: Kart, right: number, fwd: number): [number, number, number] {
  const s = Math.sin(k.heading), c = Math.cos(k.heading);
  return [k.x + c * right + s * fwd, k.y, k.z - s * right + c * fwd];
}

const REAR_L: [number, number] = [-1.08, -1.34];
const REAR_R: [number, number] = [1.08, -1.34];

/** 所有比赛内的粒子表现 */
export class RaceFx {
  private driftAcc = new Map<number, number>();
  private trailAcc = new Map<number, number>();
  private dustAcc = new Map<number, number>();
  /** 每辆车两个后轮的上一个胎印落点 */
  private skidLast = new Map<number, [THREE.Vector3 | null, THREE.Vector3 | null]>();
  private skidTmp = new THREE.Vector3();

  constructor(private fx: Effects, private track: Track) {}

  /** 胎印：漂移 / 急刹侧滑 / 出界都会留下轮胎痕 */
  private updateSkid(r: Racer): void {
    const k = r.kart;
    const id = r.id;
    // 坐地、有速度、且确实在滑才留印
    const slipping = k.drifting || k.slip > 0.16 || k.spinOut > 0;
    const active = k.grounded && k.speed > 6 && slipping;

    let pair = this.skidLast.get(id);
    if (!pair) { pair = [null, null]; this.skidLast.set(id, pair); }

    if (!active) {
      // 断开，下次重新起头，否则会跨过一大段连出一条直线
      pair[0] = null; pair[1] = null;
      return;
    }

    // 滑得越狠印得越黑；出界时浅一点（草地上本来就不会有黑胎印）
    const opacity = clamp(0.3 + k.slip * 1.5, 0, 0.9) * (k.offroad ? 0.35 : 1);

    for (let i = 0; i < 2; i++) {
      const w = i === 0 ? REAR_L : REAR_R;
      const [x, , z] = local(k, w[0], w[1]);
      // 高度必须在**轮子那个点**上重新采样，不能用 k.y。
      // k.y 是车中心的路面高度，而路面是带 banking 的：左右轮相距 2.16m，
      // 在有倾角的弯道上两侧路面高度能差 ±11cm —— 低的那条胎印直接被路面挡住，
      // 看起来就成了"只有一条胎印"。
      const y = this.track.surfaceHeight(x, z, k.trackIndex).y;
      this.skidTmp.set(x, y + 0.03, z);
      const prev = pair[i];
      if (prev) {
        const d = prev.distanceTo(this.skidTmp);
        // 太密的话白浪费环形缓冲，太疏会断开
        if (d > 0.42) {
          this.fx.skid.addSegment(prev, this.skidTmp, 0.34, opacity);
          prev.copy(this.skidTmp);
        }
      } else {
        pair[i] = this.skidTmp.clone();
      }
    }
  }

  /** 每渲染帧的持续型特效 */
  perFrame(r: Racer, dt: number): void {
    const k = r.kart;
    const id = r.id;

    this.updateSkid(r);

    // ---------- 漂移火花：档位决定颜色，是玩家读取集气进度的主要视觉 ----------
    if (k.drifting && k.grounded && k.speed > 12) {
      const tier = k.driftTier;
      const color = TIER_COLORS[tier];
      const rate = 36 + tier * 26 + k.slip * 45;
      let acc = (this.driftAcc.get(id) ?? 0) + rate * dt;
      const wheels = [REAR_L, REAR_R];
      while (acc >= 1) {
        acc -= 1;
        const w = wheels[(Math.random() * 2) | 0];
        const [x, y, z] = local(k, w[0], w[1]);
        // 火花朝漂移的反方向甩出去
        const spread = 3.4 + tier * 2.2;
        this.fx.sparks.emit({
          pos: [x, y + 0.24, z],
          vel: [
            -k.vx * 0.1 + rand(-spread, spread),
            rand(1.2, 4.6 + tier),
            -k.vz * 0.1 + rand(-spread, spread),
          ],
          color,
          size: 0.5 + tier * 0.28,
          sizeEnd: 0,
          life: 0.24 + tier * 0.1,
          gravity: -12,
          drag: 2.4,
        });
      }
      this.driftAcc.set(id, acc);

      // 轮胎烟
      let sacc = (this.dustAcc.get(id) ?? 0) + (22 + k.slip * 38) * dt;
      while (sacc >= 1) {
        sacc -= 1;
        const w = wheels[(Math.random() * 2) | 0];
        const [x, y, z] = local(k, w[0], w[1]);
        this.fx.smoke.emit({
          pos: [x, y + 0.2, z],
          vel: [rand(-1.4, 1.4), rand(0.6, 2.1), rand(-1.4, 1.4)],
          color: 0x50607a,
          size: 1.1,
          sizeEnd: 3.4,
          life: 0.55,
          gravity: 1.4,
          drag: 1.9,
          fadeIn: 0.18,
        });
      }
      this.dustAcc.set(id, sacc);
    } else {
      this.driftAcc.set(id, 0);
    }

    // ---------- 喷射尾迹 ----------
    if (k.boostTime > 0) {
      const color = k.boostKind === 'nitro' ? NITRO_COLOR
        : k.boostKind === 'pad' ? 0x35f5a0
          : TIER_COLORS[Math.min(3, 1 + k.comboLevel)];
      let acc = (this.trailAcc.get(id) ?? 0) + 40 * dt;
      while (acc >= 1) {
        acc -= 1;
        const [x, y, z] = local(k, rand(-0.55, 0.55), -2.35);
        this.fx.sparks.emit({
          pos: [x, y + 0.45, z],
          vel: [-k.vx * 0.18 + rand(-2, 2), rand(0.2, 1.6), -k.vz * 0.18 + rand(-2, 2)],
          color,
          size: 0.5,
          sizeEnd: 0,
          life: 0.3,
          drag: 3.2,
        });
      }
      this.trailAcc.set(id, acc);
    } else {
      this.trailAcc.set(id, 0);
    }

    // ---------- 出界扬尘 ----------
    if (k.offroad && k.grounded && k.speed > 6) {
      const n = Math.min(3, Math.ceil(k.speed * dt * 3));
      for (let i = 0; i < n; i++) {
        const w = Math.random() < 0.5 ? REAR_L : REAR_R;
        const [x, y, z] = local(k, w[0], w[1]);
        this.fx.smoke.emit({
          pos: [x, y + 0.15, z],
          vel: [rand(-2.2, 2.2), rand(1.2, 3.4), rand(-2.2, 2.2)],
          color: 0x8a7355,
          size: 1.3,
          sizeEnd: 4.2,
          life: 0.7,
          gravity: -1.6,
          drag: 2.2,
          fadeIn: 0.15,
        });
      }
    }
  }

  /** 起漂瞬间的一抹地面碎屑，配合速度惩罚让“顿一下”看得见 */
  driftStart(k: Kart): void {
    for (const w of [REAR_L, REAR_R]) {
      const [x, y, z] = local(k, w[0], w[1]);
      for (let i = 0; i < 7; i++) {
        this.fx.smoke.emit({
          pos: [x, y + 0.18, z],
          vel: [rand(-3.5, 3.5), rand(1, 3.2), rand(-3.5, 3.5)],
          color: 0x6b7890,
          size: 1.2,
          sizeEnd: 4.0,
          life: 0.5,
          drag: 2.4,
          fadeIn: 0.14,
        });
      }
    }
  }

  /** 松开漂移的爆闪 */
  boostBurst(k: Kart, tier: number, combo: number): void {
    const color = TIER_COLORS[Math.min(3, tier + Math.min(combo - 1, 1))];
    const n = 16 + tier * 9 + combo * 3;
    for (let i = 0; i < n; i++) {
      const [x, y, z] = local(k, rand(-0.9, 0.9), rand(-2.4, -1.6));
      const spread = 7 + tier * 3;
      this.fx.sparks.emit({
        pos: [x, y + 0.42, z],
        vel: [-k.vx * 0.2 + rand(-spread, spread), rand(1, 7), -k.vz * 0.2 + rand(-spread, spread)],
        color,
        size: 0.85 + tier * 0.2,
        sizeEnd: 0,
        life: 0.42 + tier * 0.08,
        gravity: -9,
        drag: 2.1,
      });
    }
  }

  nitroBurst(k: Kart): void {
    for (let i = 0; i < 44; i++) {
      const [x, y, z] = local(k, rand(-0.8, 0.8), rand(-2.6, -1.4));
      this.fx.sparks.emit({
        pos: [x, y + 0.45, z],
        vel: [-k.vx * 0.25 + rand(-11, 11), rand(0.5, 9), -k.vz * 0.25 + rand(-11, 11)],
        color: Math.random() < 0.35 ? 0xffffff : NITRO_COLOR,
        size: 1.05,
        sizeEnd: 0,
        life: 0.55,
        gravity: -6,
        drag: 1.9,
      });
    }
  }

  wallSparks(k: Kart, severity: number): void {
    const n = Math.ceil(14 + severity * 34);
    // trackOffset 正 = 中心线的 lx 侧，而 local() 的 right 参数指向反方向，故取负
    const side = -Math.sign(k.trackOffset) || 1;
    for (let i = 0; i < n; i++) {
      const [x, y, z] = local(k, side * rand(0.7, 1.15), rand(-1.6, 1.6));
      this.fx.sparks.emit({
        pos: [x, y + rand(0.3, 0.9), z],
        vel: [rand(-9, 9), rand(2, 10), rand(-9, 9)],
        color: Math.random() < 0.4 ? 0xffffff : 0xffb03a,
        size: 0.6,
        sizeEnd: 0,
        life: 0.4,
        gravity: -22,
        drag: 1.2,
      });
    }
  }

  landing(k: Kart, hard: boolean): void {
    const n = hard ? 28 : 12;
    for (let i = 0; i < n; i++) {
      const [x, y, z] = local(k, rand(-1.1, 1.1), rand(-1.5, 1.5));
      this.fx.smoke.emit({
        pos: [x, y + 0.1, z],
        vel: [rand(-5, 5), rand(0.8, 3.2), rand(-5, 5)],
        color: 0x76839b,
        size: 1.2,
        sizeEnd: 4.6,
        life: 0.6,
        drag: 2.6,
        fadeIn: 0.12,
      });
    }
  }

  bumpSparks(a: Kart, b: Kart): void {
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2 + 0.5, mz = (a.z + b.z) / 2;
    for (let i = 0; i < 20; i++) {
      this.fx.sparks.emit({
        pos: [mx, my, mz],
        vel: [rand(-8, 8), rand(1, 7), rand(-8, 8)],
        color: 0xfff0b0,
        size: 0.55,
        sizeEnd: 0,
        life: 0.33,
        gravity: -20,
        drag: 1.4,
      });
    }
  }

  padBurst(k: Kart): void {
    for (let i = 0; i < 34; i++) {
      const [x, y, z] = local(k, rand(-1.2, 1.2), rand(-2, 1));
      this.fx.sparks.emit({
        pos: [x, y + 0.2, z],
        vel: [rand(-3, 3), rand(4, 12), rand(-3, 3)],
        color: 0x35f5a0,
        size: 0.85,
        sizeEnd: 0,
        life: 0.5,
        gravity: -11,
        drag: 1.5,
      });
    }
  }

  /** 供未来的赛道特效使用（如隧道灯带） */
  get trackRef(): Track { return this.track; }

  /** 归一化速度，UI 可复用 */
  static speedNorm(k: Kart): number {
    return clamp(k.speed / KART.maxSpeed, 0, 1.6);
  }
}
