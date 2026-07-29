import type { InputState } from '../core/Input';
import { emptyInput } from '../core/Input';
import type { Track } from '../track/Track';
import type { Racer } from './Racer';
import { AI_PROFILES, KART, type Difficulty } from '../core/Config';
import { clamp, mulberry32, wrapAngle } from '../core/MathUtil';

type Profile = (typeof AI_PROFILES)[Difficulty];

/**
 * AI 车手。
 * 决策完全通过合成 InputState 完成 —— 和玩家走同一套物理，
 * 所以 AI 也会漂移集气、连喷、放氮气，不存在"作弊加速"。
 */
export class AIDriver {
  private input = emptyInput();
  private rng: () => number;
  private profile: Profile;

  // 状态机
  private driftTargetTier = 2;
  private comboPlanned = false;
  private comboDelay = 0;
  private mistakeTimer = 0;
  private mistakeSteer = 0;
  private reactionTimer = 0;
  private cachedSteer = 0;
  private stuckTimer = 0;
  private reverseTimer = 0;
  /** 个体差异：走线偏移与激进度 */
  private lineBias: number;
  private aggression: number;

  constructor(private track: Track, difficulty: Difficulty, seed: number) {
    this.profile = AI_PROFILES[difficulty];
    this.rng = mulberry32(seed);
    this.lineBias = (this.rng() - 0.5) * 0.3;
    this.aggression = 0.82 + this.rng() * 0.42;
  }

  update(dt: number, self: Racer, racers: Racer[], raceTime: number): InputState {
    const k = self.kart;
    const p = this.profile;
    const inp = this.input;

    if (self.finished) {
      // 冲线后自动缓行
      inp.throttle = 0.4; inp.brake = 0; inp.steer = 0;
      inp.drift = false; inp.driftPressed = false; inp.driftReleased = false;
      inp.nitroPressed = false; inp.itemPressed = false; inp.respawn = false;
      return inp;
    }

    // ---------- 卡住检测 ----------
    if (k.speed < 5 && raceTime > 2) this.stuckTimer += dt; else this.stuckTimer = 0;
    if (this.stuckTimer > 0.9) { this.reverseTimer = 0.7; this.stuckTimer = 0; }
    if (this.reverseTimer > 0) {
      this.reverseTimer -= dt;
      inp.throttle = 0; inp.brake = 1;
      inp.steer = k.wrongWay ? 0 : (this.rng() < 0.5 ? -0.8 : 0.8);
      inp.drift = false; inp.driftPressed = false; inp.driftReleased = false;
      inp.nitroPressed = false; inp.itemPressed = false;
      inp.respawn = this.reverseTimer < 0.1 && k.offroad;
      return inp;
    }

    // ---------- 目标点：赛车线 + 前瞻 ----------
    const speedN = clamp(k.speed / KART.maxSpeed, 0, 1.5);
    const look = p.lookahead * (0.6 + speedN * 0.55);
    const aheadDist = k.trackDist + look;
    const s = this.track.sampleAt(aheadDist);
    let targetOffset = this.track.racingLineOffset(aheadDist, this.aggression) + this.lineBias * s.half;

    // ---------- 避让：前方的车 ----------
    targetOffset += this.avoidance(self, racers, look, s.half);
    targetOffset = clamp(targetOffset, -s.half * 0.74, s.half * 0.74);

    const tx = s.x + s.lx * targetOffset;
    const tz = s.z + s.lz * targetOffset;

    // ---------- 转向 ----------
    const desired = Math.atan2(tx - k.x, tz - k.z);
    let diff = wrapAngle(desired - k.heading);

    // 反应延迟：低难度 AI 会"晚一拍"
    this.reactionTimer -= dt;
    if (this.reactionTimer <= 0) {
      // diff > 0 要求 heading 变大，而 heading 变大 = 向左，所以 steer 取反
      this.cachedSteer = clamp(-diff * 2.7, -1, 1);
      this.reactionTimer = p.reaction * (0.6 + this.rng() * 0.8);
    }
    let steer = this.cachedSteer;

    // 随机失误
    this.mistakeTimer -= dt;
    if (this.mistakeTimer <= 0) {
      this.mistakeTimer = 2 + this.rng() * 5;
      this.mistakeSteer = this.rng() < p.mistakeRate ? (this.rng() - 0.5) * 1.4 : 0;
    }
    steer = clamp(steer + this.mistakeSteer, -1, 1);

    // ---------- 弯道速度控制 ----------
    const turn = this.upcomingTurn(k.trackDist, 16 + speedN * 34);
    const corner = clamp(Math.abs(turn) * 11, 0, 1);
    const targetSpeed = KART.maxSpeed * p.speedMult * (1 - corner * 0.52) * (k.offroad ? 0.7 : 1);

    let throttle = 1;
    let brake = 0;
    if (k.speed > targetSpeed * 1.16) { throttle = 0; brake = 0.75; }
    else if (k.speed > targetSpeed) { throttle = 0.35; }
    if (k.offroad) throttle = 1; // 出界了赶紧回来

    // ---------- 漂移决策 ----------
    const canDrift = k.speed > KART.driftMinSpeed * 1.15 && k.grounded;
    const sharp = Math.abs(turn) > 0.055 / Math.max(this.aggression, 0.5);

    let drift = false;
    let driftPressed = false;
    let driftReleased = false;

    if (this.comboDelay > 0) {
      // 连喷：喷射刚开始，等一小会再点漂移
      this.comboDelay -= dt;
      if (this.comboDelay <= 0 && k.comboTimer > 0.02 && canDrift) {
        drift = true;
        driftPressed = true;
        this.driftTargetTier = 1; // 连喷只需要很短的集气
      }
    } else if (!k.drifting) {
      if (canDrift && sharp && p.driftSkill > 0.25) {
        drift = true;
        driftPressed = true;
        // 技术越好，越舍得等大喷
        const r = this.rng();
        this.driftTargetTier = p.driftSkill > 0.8 ? (r < 0.65 ? 3 : 2)
          : p.driftSkill > 0.5 ? (r < 0.5 ? 2 : 1) : 1;
      }
    } else {
      // 漂移中：判断何时松手
      const tierIdx = clamp(this.driftTargetTier - 1, 0, 2);
      const need = KART.tier[tierIdx];
      const cornerEnding = Math.abs(this.upcomingTurn(k.trackDist, 20)) < 0.022;
      const reached = k.driftCharge >= need;
      // 车头偏离目标太多 = 漂过头了，赶紧收
      const overshoot = Math.abs(diff) > 0.9 && Math.sign(-diff) !== k.driftDir;
      // 低于最短漂移时长松手拿不到喷射，所以不提前松；
      // 但漂过头/冲出赛道时必须立刻收，否则会直接撞墙卡死。
      const tooShort = k.driftTime < KART.minDriftTime;
      const wantRelease = reached
        || (cornerEnding && k.driftCharge >= KART.tier[0])
        || k.driftCharge >= 0.995;
      // 快压到路缘了就别再漂了
      const nearEdge = Math.abs(k.trackOffset) > s.half * 0.86;
      if (overshoot || k.offroad || nearEdge || (!tooShort && wantRelease)) {
        drift = false;
        driftReleased = true;
        // 计划连喷
        if (this.rng() < p.driftSkill) {
          this.comboPlanned = true;
          this.comboDelay = 0.12 + this.rng() * 0.16;
        }
      } else {
        drift = true;
        // 漂移中以跟随目标点为主，只给一点漂移方向的偏置（给多了会滑出赛道）
        steer = clamp(steer * 0.85 + k.driftDir * 0.28, -1, 1);
      }
    }

    // ---------- 氮气 ----------
    let nitroPressed = false;
    if (k.nitro >= 1 && k.boostTime <= 0.1 && !k.drifting && corner < 0.28 && k.speed > KART.maxSpeed * 0.6) {
      if (this.rng() < 0.5 + p.driftSkill * 0.5) nitroPressed = true;
    }

    inp.throttle = throttle;
    inp.brake = brake;
    inp.steer = steer;
    inp.drift = drift;
    inp.driftPressed = driftPressed;
    inp.driftReleased = driftReleased;
    inp.nitroPressed = nitroPressed;
    inp.itemPressed = false;
    inp.respawn = false;
    return inp;
  }

  /** 前方一段距离内的累计转角（弧度），正 = 左转 */
  private upcomingTurn(dist: number, span: number): number {
    let sum = 0;
    const steps = 6;
    for (let i = 1; i <= steps; i++) {
      const s = this.track.sampleAt(dist + (span * i) / steps);
      sum += s.curv;
    }
    return (sum / steps) * span;
  }

  /** 返回一个横向偏移修正，用来绕开前方的车。幅度按赛道宽度缩放，否则窄路上会直接把自己推出去 */
  private avoidance(self: Racer, racers: Racer[], look: number, half: number): number {
    let adjust = 0;
    const k = self.kart;
    const strength = half * 0.42;
    for (const r of racers) {
      if (r.id === self.id) continue;
      const rk = r.kart;
      let gap = rk.trackDist - k.trackDist;
      const L = this.track.length;
      if (gap < -L / 2) gap += L;
      if (gap > L / 2) gap -= L;
      if (gap < 0.5 || gap > look * 1.1) continue;
      const lateral = rk.trackOffset - k.trackOffset;
      if (Math.abs(lateral) > 6.5) continue;
      // 越近躲得越狠
      const urgency = 1 - gap / (look * 1.1);
      adjust += (lateral >= 0 ? -1 : 1) * strength * urgency * this.aggression;
    }
    return clamp(adjust, -half * 0.55, half * 0.55);
  }

  get plannedCombo(): boolean { return this.comboPlanned; }
}
