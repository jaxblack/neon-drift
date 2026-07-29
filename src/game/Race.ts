import * as THREE from 'three';
import { Track, getTrackDef } from '../track/Track';
import { buildTrackVisual, type TrackVisual } from '../render/TrackMesh';
import { Kart } from '../physics/Kart';
import { KartVisual } from '../render/KartModel';
import { Racer } from './Racer';
import { AIDriver } from './AI';
import { RaceFx } from './RaceFx';
import { Effects } from '../render/Effects';
import type { Stage } from '../render/Stage';
import type { AudioEngine } from '../core/Audio';
import { consumeEdges, emptyInput, type InputState } from '../core/Input';
import { RACE, RACER_COLORS, RACER_NAMES, KART, type Difficulty } from '../core/Config';
import { clamp } from '../core/MathUtil';

export interface RaceConfig {
  trackId: string;
  laps: number;
  aiCount: number;
  difficulty: Difficulty;
  playerName: string;
}

export type RaceState = 'countdown' | 'racing' | 'finished';

export interface RaceCallbacks {
  onCountdown?: (n: number) => void;
  onStart?: () => void;
  onLap?: (racer: Racer, lapTime: number, best: boolean) => void;
  onFinish?: (racer: Racer) => void;
  onRaceOver?: (standings: Racer[]) => void;
  onToast?: (text: string, color: string) => void;
  onCombo?: (text: string) => void;
  onShake?: (amount: number) => void;
}

/** 检查点数量：防止倒车刷圈 / 抄近道跳过赛道 */
const SECTORS = 24;
const PAD_COOLDOWN = 1.2;

export class Race {
  readonly track: Track;
  readonly racers: Racer[] = [];
  readonly player: Racer;
  private trackVisual: TrackVisual;
  private fx: RaceFx;
  private effects: Effects;
  private group = new THREE.Group();

  state: RaceState = 'countdown';
  time = 0;
  countdown = RACE.countdownSeconds + 1;
  /** 自动驾驶：调试手感 / 演示模式时把玩家交给 AI */
  autopilot = false;
  private lastCountdownInt = -1;
  private aiTick = 0;
  private playerFinishedInput = emptyInput();

  cb: RaceCallbacks = {};

  constructor(
    private stage: Stage,
    private audio: AudioEngine,
    readonly config: RaceConfig,
  ) {
    const def = getTrackDef(config.trackId);
    this.track = new Track(def);

    this.trackVisual = buildTrackVisual(this.track);
    this.group.add(this.trackVisual.group);
    stage.scene.add(this.group);
    stage.applyTheme(def.theme);

    this.effects = new Effects(stage.scene);
    this.fx = new RaceFx(this.effects, this.track);

    const total = 1 + config.aiCount;
    const grid = this.track.startGrid(total);

    // 玩家永远从最后一格发车 —— 有超车空间，比赛更有戏
    const playerSlot = total - 1;
    for (let i = 0; i < total; i++) {
      const isPlayer = i === playerSlot;
      // 玩家固定拿 0 号霓虹青，在任何主题下都最醒目
      const color = isPlayer ? RACER_COLORS[0] : RACER_COLORS[(i + 1) % RACER_COLORS.length];
      const name = isPlayer ? config.playerName : RACER_NAMES[i % RACER_NAMES.length];
      const kart = new Kart(this.track);
      const g = grid[i];
      kart.reset(g.x, g.y, g.z, g.heading);
      const visual = new KartVisual({ color, isPlayer });
      if (!isPlayer) visual.setLabel(name, color);
      stage.scene.add(visual.root);

      // 玩家也配一个 AI，用于 autopilot / 掉线托管
      const ai = new AIDriver(this.track, config.difficulty, (def.seed ^ (i * 7919)) >>> 0);
      const racer = new Racer(i, name, color, isPlayer, kart, visual, ai);
      racer.checkpoint = SECTORS - 1;
      this.racers.push(racer);
      this.hookKartEvents(racer);
    }
    this.player = this.racers[playerSlot];
  }

  private hookKartEvents(racer: Racer): void {
    const k = racer.kart;
    k.events = {
      onBoost: (e) => {
        racer.driftBoosts++;
        racer.maxCombo = Math.max(racer.maxCombo, e.combo);
        this.fx.boostBurst(k, e.tier, e.combo);
        if (racer.isPlayer) {
          this.audio.boost(e.tier, e.combo);
          this.cb.onShake?.(0.12 + e.tier * 0.06);
          if (e.combo >= 2) {
            const names = ['', '', '双喷', '三喷', '四喷', '五喷', '六喷'];
            this.cb.onCombo?.(`${names[Math.min(e.combo, 6)]}${e.perfect ? ' PERFECT!' : '!'} ×${e.combo}`);
          } else {
            const t = ['', '小喷', '中喷', '大喷'][e.tier];
            this.cb.onCombo?.(t);
          }
        }
      },
      onDriftFizzle: () => { if (racer.isPlayer) this.audio.fizzle(); },
      onDriftStart: () => {
        this.fx.driftStart(k);
        if (racer.isPlayer) this.cb.onShake?.(0.1);
      },
      onNitro: () => {
        this.fx.nitroBurst(k);
        if (racer.isPlayer) { this.audio.nitro(); this.cb.onShake?.(0.35); }
      },
      onWallHit: (sev) => {
        this.fx.wallSparks(k, sev);
        // 高速正面撞墙会失控打转，不能只是揉一下就走
        if (sev > 0.92) k.hit('spin', 0.4);
        if (racer.isPlayer) { this.audio.crash(sev); this.cb.onShake?.(sev * 0.8); }
      },
      onLand: (hard, boosted) => {
        this.fx.landing(k, hard);
        if (racer.isPlayer) {
          this.audio.land(hard);
          if (hard) this.cb.onShake?.(0.4);
          if (boosted) this.cb.onToast?.('落地喷！', '#ffd23f');
        }
      },
    };
  }

  // =================================================================
  // 固定步长
  // =================================================================
  step(dt: number, playerInput: InputState, firstSubstep: boolean): void {
    if (!firstSubstep) consumeEdges(playerInput);

    if (this.state === 'countdown') {
      this.countdown -= dt;
      const n = Math.ceil(this.countdown - 1);
      if (n !== this.lastCountdownInt && n >= 0) {
        this.lastCountdownInt = n;
        this.cb.onCountdown?.(n);
        this.audio.countdown(n);
      }
      if (this.countdown <= 1) {
        this.state = 'racing';
        this.cb.onStart?.();
        // 起步加速：所有人一致，不算作弊
        for (const r of this.racers) r.kart.applyBoost(6, 26, 0.8, 'start');
      }
      // 倒计时期间允许打方向预热，但不能动
      for (const r of this.racers) r.kart.savePrev();
      return;
    }

    this.time += dt;
    this.aiTick++;
    const aiFrame = this.aiTick % 4 === 0;

    // ---- 追赶机制 ----
    this.applyRubberBand();

    // ---- 每辆车 ----
    for (const r of this.racers) {
      let input: InputState;
      const manual = r.isPlayer && !this.autopilot;
      if (manual) {
        input = r.finished ? this.autoDrive(r) : playerInput;
        if (!r.finished) {
          if (input.nitroPressed) r.kart.tryNitro();
          if (input.respawn) r.kart.respawn();
        }
      } else {
        if (aiFrame || !r.ai) {
          r.aiCache = r.ai
            ? r.ai.update(dt * 4, r, this.racers, this.time)
            : emptyInput();
        }
        input = r.aiCache ?? emptyInput();
        if (input.nitroPressed) { r.kart.tryNitro(); input.nitroPressed = false; }
      }

      r.kart.step(dt, input);
      r.updateProgress();
      r.topSpeed = Math.max(r.topSpeed, r.kart.speed);
      if (r.bumpCooldown > 0) r.bumpCooldown -= dt;

      this.checkLap(r);
    }

    this.resolveKartCollisions();
    this.checkBoostPads();
    this.updateRanks();

    if (this.state !== 'finished' && this.racers.every((r) => r.finished)) {
      this.state = 'finished';
      this.cb.onRaceOver?.(this.standings());
    }
  }

  /** 冲线后自动缓行 */
  private autoDrive(r: Racer): InputState {
    const i = this.playerFinishedInput;
    i.throttle = r.kart.speed > 14 ? 0 : 0.35;
    i.brake = 0;
    i.steer = clamp(-r.kart.trackOffset * 0.06, -1, 1);
    i.drift = false; i.driftPressed = false; i.driftReleased = false;
    i.nitroPressed = false; i.itemPressed = false; i.respawn = false;
    return i;
  }

  private applyRubberBand(): void {
    if (RACE.rubberBandMax <= 0) return;
    let lead = -Infinity;
    for (const r of this.racers) if (r.progress > lead) lead = r.progress;
    for (const r of this.racers) {
      const behind = lead - r.progress;
      // 玩家的追赶加成减半，避免"赢得不真实"
      const scale = r.isPlayer ? 0.5 : 1;
      r.kart.rubberBand = clamp(behind / 260, 0, 1) * RACE.rubberBandMax * scale;
    }
  }

  private checkLap(r: Racer): void {
    if (r.finished) return;
    const sector = Math.floor((r.kart.trackDist / this.track.length) * SECTORS) % SECTORS;
    const expected = (r.checkpoint + 1) % SECTORS;
    if (sector !== expected) return;

    r.checkpoint = sector;
    if (sector !== 0) return;

    // 通过起跑线
    r.lap++;
    const lapTime = this.time - r.currentLapStart;
    r.currentLapStart = this.time;
    if (r.lap > 1) {
      r.lapTimes.push(lapTime);
      const best = lapTime < r.bestLap;
      if (best) r.bestLap = lapTime;
      this.cb.onLap?.(r, lapTime, best);
    } else {
      this.cb.onLap?.(r, 0, false);
    }
    if (r.isPlayer) this.audio.lap();

    if (r.lap > this.config.laps) {
      r.finished = true;
      r.finishTime = this.time;
      this.cb.onFinish?.(r);
      if (r.isPlayer) this.audio.finish(r.rank === 1);
    }
  }

  /** 车车碰撞：弹性推开 + 轻微失控 */
  private resolveKartCollisions(): void {
    const R = KART.radius;
    for (let i = 0; i < this.racers.length; i++) {
      for (let j = i + 1; j < this.racers.length; j++) {
        const a = this.racers[i].kart;
        const b = this.racers[j].kart;
        let dx = b.x - a.x, dz = b.z - a.z;
        const dy = b.y - a.y;
        if (Math.abs(dy) > 3) continue;
        const d2 = dx * dx + dz * dz;
        const minD = R * 2;
        if (d2 > minD * minD || d2 < 1e-6) continue;

        const d = Math.sqrt(d2);
        dx /= d; dz /= d;
        const overlap = minD - d;
        a.x -= dx * overlap * 0.5; a.z -= dz * overlap * 0.5;
        b.x += dx * overlap * 0.5; b.z += dz * overlap * 0.5;

        // 相对速度沿法线的分量
        const rvx = b.vx - a.vx, rvz = b.vz - a.vz;
        const vn = rvx * dx + rvz * dz;
        if (vn > 0) continue; // 已经在分离
        const imp = -vn * 0.55 + KART.bumpImpulse * 0.12;
        a.vx -= dx * imp; a.vz -= dz * imp;
        b.vx += dx * imp; b.vz += dz * imp;

        const sev = clamp(-vn / 24, 0, 1);
        if (sev > 0.25) {
          const ra = this.racers[i], rb = this.racers[j];
          if (ra.bumpCooldown <= 0) { ra.kart.hit('bump', sev); ra.bumpCooldown = 0.4; }
          if (rb.bumpCooldown <= 0) { rb.kart.hit('bump', sev); rb.bumpCooldown = 0.4; }
          if (ra.isPlayer || rb.isPlayer) {
            this.audio.crash(sev * 0.7);
            this.cb.onShake?.(sev * 0.5);
          }
          this.fx.bumpSparks(a, b);
        }
      }
    }
  }

  /** 加速带 */
  private checkBoostPads(): void {
    for (const pad of this.track.pads) {
      const s = this.track.sampleAt(pad.dist);
      const px = s.x + s.lx * pad.offset;
      const pz = s.z + s.lz * pad.offset;
      for (const r of this.racers) {
        if (r.finished) continue;
        if (this.time - r.lastPadAt < PAD_COOLDOWN) continue;
        const k = r.kart;
        const dx = k.x - px, dz = k.z - pz;
        if (dx * dx + dz * dz > 22) continue;
        r.lastPadAt = this.time;
        k.applyBoost(22, 68, 1.3, 'pad');
        k.addNitro(0.35);
        this.fx.padBurst(k);
        if (r.isPlayer) {
          this.audio.boost(2, 0);
          this.cb.onToast?.('加速带！', '#35f5a0');
        }
      }
    }
  }

  private updateRanks(): void {
    const sorted = [...this.racers].sort((a, b) => {
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      return b.progress - a.progress;
    });
    for (let i = 0; i < sorted.length; i++) sorted[i].rank = i + 1;
  }

  standings(): Racer[] {
    return [...this.racers].sort((a, b) => a.rank - b.rank);
  }

  // =================================================================
  // 渲染帧
  // =================================================================
  render(alpha: number, dt: number): void {
    for (const r of this.racers) {
      r.visual.update(r.kart, alpha, dt);
      this.fx.perFrame(r, dt);
    }
    this.trackVisual.update(this.time);
    this.effects.update(dt);
    this.stage.updateCamera(this.player.kart, alpha, dt);

    // 名牌只在近处显示，远了太乱
    const cam = this.stage.camera.position;
    for (const r of this.racers) {
      if (r.isPlayer) continue;
      const d2 = (r.kart.x - cam.x) ** 2 + (r.kart.z - cam.z) ** 2;
      r.visual.setLabelVisible(d2 < 120 * 120);
    }
  }

  dispose(): void {
    for (const r of this.racers) {
      this.stage.scene.remove(r.visual.root);
      r.visual.dispose();
    }
    this.effects.dispose();
    this.trackVisual.dispose();
    this.stage.scene.remove(this.group);
  }
}
