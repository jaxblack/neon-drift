import { KART, RACE } from '../core/Config';
import { clamp, damp, wrapAngle } from '../core/MathUtil';
import type { InputState } from '../core/Input';
import type { Track } from '../track/Track';

export type BoostKind = 'none' | 'drift' | 'nitro' | 'pad' | 'item' | 'start';

/** 一次喷射事件（供 UI / 音效 / 粒子消费） */
export interface DriftEvent {
  tier: 1 | 2 | 3;
  combo: number;
  perfect: boolean;
}

export interface KartEvents {
  /** 松开漂移触发喷射 */
  onBoost?: (e: DriftEvent) => void;
  /** 集气不足，空放 */
  onDriftFizzle?: () => void;
  onDriftStart?: () => void;
  onNitro?: () => void;
  onWallHit?: (severity: number) => void;
  onLand?: (hard: boolean, boosted: boolean) => void;
  onOffroad?: (entering: boolean) => void;
}

/**
 * 赛车物理体。
 * 纯数值 —— 不引用 three.js，可以整份搬到 Node 服务端做权威模拟。
 *
 * 核心手感取自 QQ飞车：
 *   漂移侧滑 → 集气三档 → 松键喷射 → 黄金窗口内再点漂移 = 连喷
 */
export class Kart {
  // ---- 位姿 ----
  x = 0; y = 0; z = 0;
  heading = 0;
  vx = 0; vy = 0; vz = 0;

  // ---- 派生 ----
  speed = 0;
  forwardSpeed = 0;
  lateralSpeed = 0;
  /** 侧滑比例 0..1 */
  slip = 0;

  // ---- 漂移 ----
  drifting = false;
  driftDir: -1 | 0 | 1 = 0;
  driftCharge = 0;
  driftTime = 0;
  /** 0=未达标 1=小喷 2=中喷 3=大喷 */
  get driftTier(): 0 | 1 | 2 | 3 {
    const c = this.driftCharge;
    if (c >= KART.tier[2]) return 3;
    if (c >= KART.tier[1]) return 2;
    if (c >= KART.tier[0]) return 1;
    return 0;
  }

  // ---- 喷射 ----
  boostTime = 0;
  boostPower = 0;
  boostThrust = 0;
  boostKind: BoostKind = 'none';

  // ---- 连喷 ----
  comboLevel = 0;
  comboTimer = 0;
  private comboArmed = false;
  private comboPerfect = false;

  // ---- 氮气 ----
  nitro = 0; // 0..nitroCells

  // ---- 空中 ----
  grounded = true;
  airTime = 0;
  private landBoostTimer = 0;

  // ---- 赛道 ----
  trackIndex = -1;
  trackDist = 0;
  trackOffset = 0;
  offroad = false;
  wrongWay = false;
  private offroadTime = 0;
  /** 漂移期间在界外的累计时间，起漂时清零 */
  private driftOffroadTime = 0;

  // ---- 受击 ----
  spinOut = 0;
  /** 被撞后的短暂失控 */
  stagger = 0;

  // ---- 视觉（物理层算好，渲染层直接用） ----
  bodyRoll = 0;
  bodyPitch = 0;
  steerVisual = 0;
  wheelSpin = 0;
  /** 上一物理步的位姿，用于渲染插值 */
  prev = { x: 0, y: 0, z: 0, heading: 0, roll: 0, pitch: 0 };

  // ---- 追赶机制 ----
  rubberBand = 0;

  events: KartEvents = {};

  constructor(public track: Track) {}

  reset(x: number, y: number, z: number, heading: number): void {
    this.x = x; this.y = y; this.z = z;
    this.heading = heading;
    this.vx = this.vy = this.vz = 0;
    this.speed = this.forwardSpeed = this.lateralSpeed = this.slip = 0;
    this.drifting = false; this.driftDir = 0; this.driftCharge = 0; this.driftTime = 0;
    this.boostTime = this.boostPower = this.boostThrust = 0; this.boostKind = 'none';
    this.comboLevel = 0; this.comboTimer = 0; this.comboArmed = false;
    this.nitro = 0;
    this.grounded = true; this.airTime = 0; this.landBoostTimer = 0;
    this.spinOut = this.stagger = 0;
    this.bodyRoll = this.bodyPitch = this.steerVisual = this.wheelSpin = 0;
    this.offroad = false; this.offroadTime = 0; this.driftOffroadTime = 0; this.wrongWay = false;
    this.trackIndex = -1;
    const p = this.track.project(x, z, -1);
    this.trackIndex = p.index;
    this.trackDist = p.dist;
    this.trackOffset = p.offset;
    this.savePrev();
  }

  savePrev(): void {
    this.prev.x = this.x; this.prev.y = this.y; this.prev.z = this.z;
    this.prev.heading = this.heading;
    this.prev.roll = this.bodyRoll; this.prev.pitch = this.bodyPitch;
  }

  /** 当前速度上限（含喷射 / 出界 / 漂移修正） */
  get maxSpeedNow(): number {
    let m = KART.maxSpeed * (1 + this.rubberBand);
    if (this.offroad) m *= KART.offroadSpeedMult;
    // 漂移中跑不到直线极速 —— 想快就得早点松手吃喷射
    if (this.drifting) m *= KART.driftSpeedCap;
    return m + this.boostPower;
  }

  get boosting(): boolean { return this.boostTime > 0; }

  /** 施加一次喷射 */
  applyBoost(extraSpeed: number, thrust: number, time: number, kind: BoostKind): void {
    if (extraSpeed >= this.boostPower) {
      this.boostPower = extraSpeed;
      this.boostThrust = thrust;
      this.boostTime = Math.max(this.boostTime, time);
      this.boostKind = kind;
    } else {
      this.boostTime += time * 0.35;
    }
  }

  addNitro(amount: number): void {
    this.nitro = clamp(this.nitro + amount, 0, KART.nitroCells);
  }

  /** 被碰撞击中 */
  hit(kind: 'spin' | 'bump', strength = 1): boolean {
    switch (kind) {
      case 'spin':
        this.spinOut = Math.max(this.spinOut, 1.15 * strength);
        this.breakCombo();
        this.scaleSpeed(0.42);
        break;
      case 'bump':
        this.stagger = Math.max(this.stagger, 0.35 * strength);
        this.scaleSpeed(0.86);
        break;
    }
    return true;
  }

  private scaleSpeed(k: number): void {
    this.vx *= k; this.vz *= k;
  }

  private breakCombo(): void {
    this.drifting = false;
    this.driftCharge = 0;
    this.comboLevel = 0;
    this.comboTimer = 0;
    this.comboArmed = false;
  }

  /** 复位到赛道中心 */
  respawn(): void {
    const s = this.track.sampleAt(this.trackDist);
    this.x = s.x; this.y = s.y + 0.5; this.z = s.z;
    this.heading = Math.atan2(s.fx, s.fz);
    const keep = Math.min(this.speed, 18) * 0.5;
    this.vx = s.fx * keep; this.vz = s.fz * keep; this.vy = 0;
    this.breakCombo();
    this.spinOut = 0; this.stagger = 0;
    this.offroadTime = 0;
    this.driftOffroadTime = 0;
    this.savePrev();
  }

  // =================================================================
  // 主步进
  // =================================================================
  step(dt: number, input: InputState): void {
    this.savePrev();

    // ---------- 计时器 ----------
    if (this.boostTime > 0) {
      this.boostTime -= dt;
      if (this.boostTime <= 0) {
        this.boostTime = 0; this.boostPower = 0; this.boostThrust = 0; this.boostKind = 'none';
      }
    }
    if (this.spinOut > 0) this.spinOut -= dt;
    if (this.stagger > 0) this.stagger -= dt;
    if (this.landBoostTimer > 0) this.landBoostTimer -= dt;
    // 连喷窗口只在非漂移状态倒计时（漂移中窗口冻结）
    if (!this.drifting && this.comboTimer > 0) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) { this.comboTimer = 0; this.comboLevel = 0; }
    }

    const controllable = this.spinOut <= 0;

    // ---------- 车身坐标系 ----------
    const fx = Math.sin(this.heading), fz = Math.cos(this.heading);
    const rx = fz, rz = -fx; // 右向量

    let vLong = this.vx * fx + this.vz * fz;
    let vLat = this.vx * rx + this.vz * rz;

    // ---------- 漂移状态机 ----------
    this.updateDrift(dt, input, controllable, vLong, vLat);

    // ---------- 纵向动力 ----------
    const maxS = this.maxSpeedNow;
    const throttle = controllable ? input.throttle : 0;
    const brake = controllable ? input.brake : 0;

    if (throttle > 0) {
      // 越接近极速加速越弱（模拟功率曲线），起步猛、尾速缓
      const ratio = clamp(vLong / Math.max(maxS, 1), 0, 1);
      const curve = KART.accelHighSpeedFactor + (1 - KART.accelHighSpeedFactor) * (1 - ratio * ratio);
      vLong += KART.accel * curve * throttle * dt;
    }
    if (brake > 0) {
      if (vLong > 0.4) {
        vLong -= KART.brakeDecel * brake * dt;
      } else {
        const revMax = KART.reverseMaxSpeed;
        if (vLong > -revMax) vLong -= KART.accel * 0.55 * brake * dt;
      }
    }
    // 喷射推力（直接加速度，穿透功率曲线）
    if (this.boostTime > 0) vLong += this.boostThrust * dt;

    // 引擎制动 / 阻力
    if (throttle === 0 && brake === 0 && vLong > 0) {
      vLong -= KART.engineBrake * dt;
      if (vLong < 0) vLong = 0;
    }
    const dragF = KART.drag * vLong * Math.abs(vLong) + KART.rollResist * Math.sign(vLong);
    vLong -= dragF * dt;
    if (this.offroad) vLong -= KART.offroadDrag * dt * Math.sign(vLong);
    // 漂移的代价：基础阻力 + 侧滑额外阻力。滑得越狠掉得越多，
    // 所以“长漂”不是免费的 —— 必须靠后续的喷射把速度赚回来。
    if (this.drifting && vLong > 0) {
      const slipAmt = clamp(Math.abs(vLat) / Math.max(Math.abs(vLong), 8), 0, 1.2);
      vLong -= (KART.driftDrag + KART.driftSlipDrag * slipAmt) * dt;
      if (vLong < 0) vLong = 0;
    }

    // 坡度：上坡掉速、下坡加速
    const grade = this.lastGrade;
    vLong += KART.gravity * grade * 0.55 * dt;

    // 限速（超速时快速回落，不硬切）
    if (vLong > maxS) vLong = damp(vLong, maxS, 5.5, dt);
    if (vLong < -KART.reverseMaxSpeed) vLong = -KART.reverseMaxSpeed;

    // ---------- 侧向抓地 ----------
    let grip: number = this.drifting ? KART.gripDrift : KART.gripNormal;
    if (this.offroad) grip = Math.min(grip, KART.gripOffroad);
    if (!this.grounded) grip *= 0.25;
    if (this.stagger > 0) grip *= 0.55;
    vLat *= Math.exp(-grip * dt);

    // ---------- 转向 ----------
    if (controllable) {
      this.applySteering(dt, input, vLong);
    } else {
      // 被击中：原地打转
      this.heading += 13 * dt * (this.driftDir || 1);
      vLat *= Math.exp(-2.5 * dt);
    }

    // ---------- 重组速度 ----------
    const nfx = Math.sin(this.heading), nfz = Math.cos(this.heading);
    const nrx = nfz, nrz = -nfx;
    this.vx = nfx * vLong + nrx * vLat;
    this.vz = nfz * vLong + nrz * vLat;
    this.forwardSpeed = vLong;
    this.lateralSpeed = vLat;
    this.speed = Math.hypot(this.vx, this.vz);
    this.slip = clamp(Math.abs(vLat) / Math.max(this.speed, 4), 0, 1);

    // ---------- 位置积分 ----------
    this.x += this.vx * dt;
    this.z += this.vz * dt;

    // ---------- 垂直 / 地面 ----------
    this.integrateVertical(dt, input, controllable);

    // ---------- 赛道投影 / 边界 ----------
    this.updateTrack(dt);

    // ---------- 视觉量 ----------
    this.updateVisuals(dt, input);

    this.wheelSpin += (this.forwardSpeed / 0.42) * dt;
  }

  private lastGrade = 0;

  // -----------------------------------------------------------------
  private updateDrift(dt: number, input: InputState, controllable: boolean, vLong: number, vLat: number): void {
    if (!controllable) return;

    if (!this.drifting) {
      // ---- 落地喷：刚落地的窗口期内按漂移键直接给一段喷射 ----
      if (input.driftPressed && this.landBoostTimer > 0) {
        this.landBoostTimer = 0;
        const t = KART.boostTiers[1];
        this.applyBoost(t.extraSpeed, t.thrust, t.time, 'drift');
        this.events.onBoost?.({ tier: 2, combo: this.comboLevel, perfect: false });
        return;
      }

      // ---- 起漂 ----
      if (input.drift && this.grounded && this.speed > KART.driftMinSpeed) {
        let dir: -1 | 0 | 1 = 0;
        if (Math.abs(input.steer) > 0.12) {
          dir = input.steer > 0 ? 1 : -1;
        } else if (input.driftPressed) {
          // 没有转向输入时，顺着弯道方向起漂（对连喷很关键：手指来不及同时动）
          const ahead = this.track.sampleAt(this.trackDist + 18);
          if (Math.abs(ahead.curv) > 0.0016) dir = ahead.curv > 0 ? -1 : 1;
        }
        if (dir !== 0) {
          this.drifting = true;
          this.driftDir = dir;
          this.driftTime = 0;
          this.driftOffroadTime = 0;
          // 连喷种子：窗口内起漂直接带一截集气
          this.comboArmed = this.comboTimer > 0;
          this.comboPerfect = this.comboArmed && this.comboTimer <= KART.comboWindow * 0.62;
          this.driftCharge = this.comboArmed ? KART.comboSeedCharge : 0;
          // 起漂的即时代价：车子会明显"顿"一下
          this.vx *= 1 - KART.driftEntryCost;
          this.vz *= 1 - KART.driftEntryCost;
          // 甩尾冲量
          this.heading -= dir * KART.driftKick * 0.06;
          this.events.onDriftStart?.();
        }
      }
      return;
    }

    // ---- 漂移中 ----
    this.driftTime += dt;

    const tooSlow = this.speed < KART.driftMinSpeed * 0.55;
    const released = !input.drift;
    if (released || tooSlow || !this.grounded && this.airTime > 0.6) {
      this.releaseDrift();
      return;
    }

    // 集气：滑得越狠涨得越快；连喷状态下涨速大幅提升
    const slipAmt = clamp(Math.abs(vLat) / Math.max(Math.abs(vLong), 8), 0, 1.4);
    let rate = KART.chargeRate * (1 + slipAmt * KART.chargeSlipBonus);
    if (this.comboArmed) rate *= KART.comboChargeMult;
    if (this.offroad) rate *= 0.35;
    if (!this.grounded) rate *= 0.3;

    const before = this.driftCharge;
    this.driftCharge = Math.min(KART.chargeMax, this.driftCharge + rate * dt);
    // 漂移顺带充氮气
    this.addNitro((this.driftCharge - before) * KART.nitroFromDrift);
  }

  private releaseDrift(): void {
    // 太短的漂移不算数 —— 否则连点漂移键就能无限喷
    const tier = this.driftTime >= KART.minDriftTime ? this.driftTier : 0;
    this.drifting = false;
    const wasCombo = this.comboArmed;
    const perfect = this.comboPerfect;
    this.comboArmed = false;
    this.comboPerfect = false;

    if (tier > 0) {
      this.comboLevel = wasCombo ? Math.min(this.comboLevel + 1, KART.comboMax) : 1;
      const t = KART.boostTiers[tier - 1];
      const lv = this.comboLevel - 1;
      // 连喷买的是“持续高速”，不是无限堆极速
      const speedMult = 1 + lv * KART.comboSpeedBonus + (perfect ? 0.04 : 0);
      const timeMult = 1 + lv * KART.comboTimeBonus + (perfect ? 0.12 : 0);
      this.applyBoost(t.extraSpeed * speedMult, t.thrust * (1 + lv * 0.06), t.time * timeMult, 'drift');
      this.comboTimer = KART.comboWindow;
      this.events.onBoost?.({ tier: tier as 1 | 2 | 3, combo: this.comboLevel, perfect });
    } else {
      this.comboLevel = 0;
      this.comboTimer = 0;
      if (this.driftTime > 0.12) this.events.onDriftFizzle?.();
    }
    this.driftCharge = 0;
    this.driftTime = 0;
    this.driftDir = 0;
  }

  /** 手动放氮气 */
  tryNitro(): boolean {
    if (this.nitro < 1 || this.spinOut > 0) return false;
    this.nitro -= 1;
    this.applyBoost(KART.nitroExtraSpeed, KART.nitroThrust, KART.nitroTime, 'nitro');
    this.events.onNitro?.();
    return true;
  }

  // -----------------------------------------------------------------
  // 方向约定（很容易搞错，改之前先读）：
  //   forward = (sin h, cos h)，与 three 的 rotateY(h) 一致。
  //   相机在车后看向 +Z，屏幕右侧对应世界 -X。
  //   所以 h 变大 = 车头转向 +X = 玩家看到的左。
  //   结论：steer > 0（向右）必须让 heading 减小。driftDir：+1 = 向右漂。
  // -----------------------------------------------------------------
  private applySteering(dt: number, input: InputState, vLong: number): void {
    const spd = Math.abs(vLong);
    // 高速时转向变钝 —— 这是"速度感"的重要来源
    const f = clamp(spd / KART.maxSpeed, 0, 1.35);
    let rate = KART.steerRateLow + (KART.steerRateHigh - KART.steerRateLow) * Math.min(f, 1);
    if (!this.grounded) rate *= 0.4;
    if (this.offroad) rate *= 0.82;

    // 低速几乎转不动（避免原地打转）
    const authority = clamp(spd / 6, 0, 1);
    const dirSign = vLong < -0.5 ? -1 : 1; // 倒车时方向反转

    if (this.drifting) {
      // 漂移弧线 = 固定偏转 + 玩家用方向键微调（内切/外扩）
      const align = input.steer * this.driftDir; // >0 表示继续往漂移方向打
      const tighten = 1 + clamp(align, -0.85, 1) * KART.driftSteerAuthority * 0.55;
      this.heading -= this.driftDir * KART.driftYawBias * tighten * authority * dt;
      // 反打可以救回车头
      if (align < -0.2) this.heading -= input.steer * rate * 0.45 * authority * dt;
    } else {
      this.heading -= input.steer * rate * authority * dirSign * dt;
    }
    this.heading = wrapAngle(this.heading);
  }

  // -----------------------------------------------------------------
  private integrateVertical(dt: number, input: InputState, controllable: boolean): void {
    const hit = this.track.surfaceHeight(this.x, this.z, this.trackIndex);
    const groundY = hit.y;
    this.lastGrade = hit.proj.grade;

    this.vy += KART.gravity * dt;
    this.y += this.vy * dt;

    if (this.y <= groundY) {
      const wasAir = this.airTime > KART.airborneThreshold;
      const impact = -this.vy;
      this.y = groundY;
      this.vy = 0;
      if (!this.grounded && wasAir) {
        this.landBoostTimer = KART.landingBoostWindow;
        const boosted = controllable && input.drift;
        if (boosted) {
          this.landBoostTimer = 0;
          const t = KART.boostTiers[1];
          this.applyBoost(t.extraSpeed, t.thrust, t.time, 'drift');
          this.events.onBoost?.({ tier: 2, combo: this.comboLevel, perfect: false });
        }
        this.events.onLand?.(impact > 16, boosted);
        // 硬着陆掉一点速
        if (impact > 22) { this.vx *= 0.9; this.vz *= 0.9; }
      }
      this.grounded = true;
      this.airTime = 0;
    } else {
      // 贴地辅助：微小起伏不算腾空，避免下坡时车身抖动
      if (this.y - groundY < 0.45 && this.airTime < 0.1 && this.vy < 0) {
        this.y = groundY;
        this.vy = 0;
        this.grounded = true;
        this.airTime = 0;
      } else {
        this.grounded = false;
        this.airTime += dt;
      }
    }
  }

  // -----------------------------------------------------------------
  private updateTrack(dt: number): void {
    const p = this.track.project(this.x, this.z, this.trackIndex);
    this.trackIndex = p.index;
    this.trackDist = p.dist;
    this.trackOffset = p.offset;

    // 逆行判定
    const dot = Math.sin(this.heading) * p.fx + Math.cos(this.heading) * p.fz;
    this.wrongWay = dot < -0.25 && this.speed > 6;

    const absOff = Math.abs(p.offset);
    const wasOff = this.offroad;
    this.offroad = absOff > p.half;
    if (this.offroad !== wasOff) this.events.onOffroad?.(this.offroad);
    if (this.offroad) {
      this.offroadTime += dt;
      // 漂移中冲出赛道足够久才打断。
      // 这里必须用“本次漂移的出界时长”而不是全局 offroadTime ——
      // 用后者的话，只要已经在草地上待足 0.6s，新起的漂移会在同一帧被立刻打断，
      // 表现为“一旦跑到草地就永远漂不起来”。
      if (this.drifting) {
        this.driftOffroadTime += dt;
        if (this.driftOffroadTime > 0.6) this.releaseDrift();
      }
    } else {
      this.offroadTime = 0;
      this.driftOffroadTime = 0;
    }

    // 护栏：草地外侧的硬墙
    const wall = p.half + SHOULDER;
    if (absOff > wall) {
      const sign = Math.sign(p.offset);
      // 推回墙内
      const push = absOff - wall;
      this.x -= p.lx * sign * push;
      this.z -= p.lz * sign * push;
      // 速度沿墙面滑行 + 损失
      const vn = this.vx * p.lx * sign + this.vz * p.lz * sign;
      if (vn > 0) {
        this.vx -= p.lx * sign * vn * (1 + KART.wallBounce);
        this.vz -= p.lz * sign * vn * (1 + KART.wallBounce);
        const sev = clamp(vn / 26, 0, 1);
        this.vx *= 1 - KART.wallSpeedLoss * sev;
        this.vz *= 1 - KART.wallSpeedLoss * sev;
        if (sev > 0.12) {
          this.events.onWallHit?.(sev);
          if (this.drifting) this.releaseDrift();
        }
      }
    }

    // 长时间出界自动复位
    if (this.offroadTime > RACE.autoRespawnAfter && this.speed < 8) this.respawn();
  }

  // -----------------------------------------------------------------
  private updateVisuals(dt: number, input: InputState): void {
    const p = this.track.project(this.x, this.z, this.trackIndex);

    // 侧倾：路面 bank + 离心力 + 漂移姿态
    const centrifugal = clamp(-this.lateralSpeed / 26, -1, 1);
    let targetRoll = p.bank * 0.8 + centrifugal * 0.34;
    if (this.drifting) targetRoll -= this.driftDir * 0.12;
    if (this.spinOut > 0) targetRoll += 0.25;
    this.bodyRoll = damp(this.bodyRoll, clamp(targetRoll, -0.55, 0.55), 8, dt);

    // 俯仰：坡度 + 加减速惯性
    const accelPitch = clamp((this.boostTime > 0 ? -0.09 : 0) + (input.brake > 0 && this.forwardSpeed > 4 ? 0.07 : 0), -0.2, 0.2);
    const targetPitch = this.grounded ? -Math.atan(p.grade) + accelPitch : clamp(-this.vy / 40, -0.35, 0.35);
    this.bodyPitch = damp(this.bodyPitch, targetPitch, this.grounded ? 7 : 3.5, dt);

    // 前轮视觉转角
    const tgtSteer = this.drifting
      ? clamp(this.driftDir * 0.55 + input.steer * 0.25, -0.7, 0.7)
      : input.steer * 0.5;
    this.steerVisual = damp(this.steerVisual, tgtSteer, 13, dt);
  }

  /** 渲染插值 */
  interp(alpha: number): { x: number; y: number; z: number; heading: number; roll: number; pitch: number } {
    const a = clamp(alpha, 0, 1);
    const p = this.prev;
    return {
      x: p.x + (this.x - p.x) * a,
      y: p.y + (this.y - p.y) * a,
      z: p.z + (this.z - p.z) * a,
      heading: p.heading + wrapAngle(this.heading - p.heading) * a,
      roll: p.roll + (this.bodyRoll - p.roll) * a,
      pitch: p.pitch + (this.bodyPitch - p.pitch) * a,
    };
  }
}

/** 路面外侧的草地/路肩宽度，超出即撞护栏 */
export const SHOULDER = 4.2;
