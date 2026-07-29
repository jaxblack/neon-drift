import type { Kart } from '../physics/Kart';
import type { KartVisual } from '../render/KartModel';
import type { AIDriver } from './AI';
import type { InputState } from '../core/Input';

/** 一位车手（玩家 / AI / 未来的远端玩家）的完整比赛状态 */
export class Racer {
  // 比赛进度
  lap = 0;
  /** 已通过的检查点序号（防止倒车刷圈） */
  checkpoint = 0;
  /** lap * trackLength + trackDist，排名用 */
  progress = 0;
  finished = false;
  finishTime = 0;
  rank = 1;
  lapTimes: number[] = [];
  currentLapStart = 0;
  bestLap = Infinity;

  // 统计
  driftBoosts = 0;
  maxCombo = 0;
  topSpeed = 0;

  /** 上一次通过加速带的时间戳，避免同一条带重复触发 */
  lastPadAt = -99;
  /** 车车碰撞的冷却，避免一次接触反复扣速度 */
  bumpCooldown = 0;
  /** AI 以 1/4 频率决策，中间帧复用上次的输入 */
  aiCache: InputState | null = null;

  constructor(
    readonly id: number,
    public name: string,
    readonly color: number,
    readonly isPlayer: boolean,
    readonly kart: Kart,
    readonly visual: KartVisual,
    public ai: AIDriver | null = null,
  ) {}

  get trackLength(): number { return this.kart.track.length; }

  /** 排名依据：跑过的总距离 */
  updateProgress(): void {
    this.progress = this.lap * this.trackLength + this.kart.trackDist;
  }

  reset(): void {
    this.lap = 0;
    this.checkpoint = 0;
    this.progress = 0;
    this.finished = false;
    this.finishTime = 0;
    this.rank = 1;
    this.lapTimes = [];
    this.currentLapStart = 0;
    this.bestLap = Infinity;
    this.driftBoosts = 0;
    this.maxCombo = 0;
    this.topSpeed = 0;
    this.lastPadAt = -99;
    this.bumpCooldown = 0;
  }
}
