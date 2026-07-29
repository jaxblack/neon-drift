import { clamp } from './MathUtil';

/**
 * 全程序化音频 —— 不加载任何音频文件。
 * 引擎声用锯齿波 + 模拟档位的 RPM 曲线合成，漂移/氮气用滤波噪声。
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private noiseBuffer!: AudioBuffer;

  // 引擎
  private engOsc: OscillatorNode[] = [];
  private engGain!: GainNode;
  private engFilter!: BiquadFilterNode;
  private gear = 0;
  private rpm = 0;

  // 持续音
  private windSrc: AudioBufferSourceNode | null = null;
  private windGain!: GainNode;
  private windFilter!: BiquadFilterNode;
  /** 轮胎尖叫：高频共振层 */
  private screechSrc: AudioBufferSourceNode | null = null;
  private screechGain!: GainNode;
  private screechFilter!: BiquadFilterNode;
  /** 轮胎摩擦：低频“沙沙”层 */
  private scrubSrc: AudioBufferSourceNode | null = null;
  private scrubGain!: GainNode;
  private scrubFilter!: BiquadFilterNode;
  /** 集气充能：音调随 driftCharge 上升 */
  private chargeOsc!: OscillatorNode;
  private chargeOsc2!: OscillatorNode;
  private chargeGain!: GainNode;
  private boostSrc: AudioBufferSourceNode | null = null;
  private boostGain!: GainNode;
  private boostFilter!: BiquadFilterNode;

  private started = false;
  enabled = true;
  private volume = 0.7;

  /** 必须在用户手势里调用 */
  async start(): Promise<void> {
    if (this.started) {
      if (this.ctx?.state === 'suspended') await this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    this.ctx = ctx;
    this.started = true;

    this.master = ctx.createGain();
    this.master.gain.value = this.enabled ? this.volume : 0;
    this.master.connect(ctx.destination);

    // 预生成 2 秒白噪声，循环播放
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuffer = buf;

    // ---- 引擎 ----
    this.engFilter = ctx.createBiquadFilter();
    this.engFilter.type = 'lowpass';
    this.engFilter.frequency.value = 900;
    this.engFilter.Q.value = 1.1;
    this.engGain = ctx.createGain();
    this.engGain.gain.value = 0;
    this.engFilter.connect(this.engGain).connect(this.master);

    const mk = (type: OscillatorType, detune: number, gain: number): OscillatorNode => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = 70;
      o.detune.value = detune;
      const g = ctx.createGain();
      g.gain.value = gain;
      o.connect(g).connect(this.engFilter);
      o.start();
      return o;
    };
    this.engOsc = [
      mk('sawtooth', 0, 0.5),
      mk('sawtooth', 11, 0.34),
      mk('square', -1200, 0.24),
      mk('sawtooth', -7, 0.2),
    ];

    // ---- 风噪 ----
    ({ src: this.windSrc, gain: this.windGain, filter: this.windFilter } =
      this.makeNoiseChain('bandpass', 900, 0.7));
    // ---- 轮胎尖叫（高 Q 共振，就是这个“呱——”让漂移有存在感）----
    ({ src: this.screechSrc, gain: this.screechGain, filter: this.screechFilter } =
      this.makeNoiseChain('bandpass', 2600, 14));
    // ---- 轮胎摩擦底层 ----
    ({ src: this.scrubSrc, gain: this.scrubGain, filter: this.scrubFilter } =
      this.makeNoiseChain('bandpass', 700, 2.2));
    // ---- 喷射轰鸣 ----
    ({ src: this.boostSrc, gain: this.boostGain, filter: this.boostFilter } =
      this.makeNoiseChain('lowpass', 1500, 3.5));

    // ---- 集气充能音：两个略失谐的三角波，频率随集气上升 ----
    this.chargeGain = ctx.createGain();
    this.chargeGain.gain.value = 0;
    this.chargeGain.connect(this.master);
    const mkCharge = (detune: number, gain: number): OscillatorNode => {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = 200;
      o.detune.value = detune;
      const g = ctx.createGain();
      g.gain.value = gain;
      o.connect(g).connect(this.chargeGain);
      o.start();
      return o;
    };
    this.chargeOsc = mkCharge(0, 0.6);
    this.chargeOsc2 = mkCharge(9, 0.4);
  }

  private makeNoiseChain(type: BiquadFilterType, freq: number, q: number) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(this.master);
    src.start();
    return { src, gain, filter };
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (this.master) this.master.gain.value = on ? this.volume : 0;
  }

  setVolume(v: number): void {
    this.volume = clamp(v, 0, 1);
    if (this.master && this.enabled) this.master.gain.value = this.volume;
  }

  suspend(): void { void this.ctx?.suspend(); }
  resume(): void { void this.ctx?.resume(); }

  /**
   * 每渲染帧更新持续音。
   * @param speedN  速度 / 极速
   * @param throttle 0..1
   * @param slip    侧滑 0..1
   * @param boosting 是否在喷射
   * @param offroad 是否出界
   * @param drifting 是否在漂移
   * @param charge  集气 0..1
   */
  updateEngine(
    speedN: number, throttle: number, slip: number,
    boosting: boolean, offroad: boolean, dt: number,
    drifting = false, charge = 0,
  ): void {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;

    // 模拟 5 速变速箱：每档内 RPM 从低爬到高，换挡瞬间回落 —— 声音一下子就"有车了"
    const GEARS = 5;
    const sn = clamp(speedN, 0, 1.45);
    const raw = sn * GEARS;
    const gear = Math.min(Math.floor(raw), GEARS - 1);
    if (gear !== this.gear) this.gear = gear;
    const inGear = clamp(raw - gear, 0, 1);
    const targetRpm = 0.18 + inGear * 0.82 + throttle * 0.12 + (boosting ? 0.25 : 0);
    this.rpm += (targetRpm - this.rpm) * Math.min(1, dt * 9);

    const base = 58 + this.rpm * 128 + gear * 9;
    for (let i = 0; i < this.engOsc.length; i++) {
      const mult = i === 2 ? 0.5 : 1;
      this.engOsc[i].frequency.setTargetAtTime(base * mult, t, 0.035);
    }
    this.engFilter.frequency.setTargetAtTime(520 + this.rpm * 2600 + (boosting ? 1400 : 0), t, 0.06);
    const engVol = 0.055 + this.rpm * 0.1 + throttle * 0.045;
    this.engGain.gain.setTargetAtTime(engVol, t, 0.05);

    // 风噪
    this.windGain.gain.setTargetAtTime(clamp(sn - 0.2, 0, 1) * 0.075, t, 0.12);
    this.windFilter.frequency.setTargetAtTime(600 + sn * 1800, t, 0.15);

    // ---- 轮胎尖叫：漂移时才有，音高随侧滑与速度走 ----
    // 高 Q 带通 + 随 slip 上滑的中心频率，听起来就是胎噪那种"咿——"
    const screechAmt = drifting ? clamp(0.35 + slip * 1.3, 0, 1) * clamp(sn * 1.6, 0, 1) : 0;
    this.screechGain.gain.setTargetAtTime(screechAmt * 0.13, t, drifting ? 0.03 : 0.09);
    this.screechFilter.frequency.setTargetAtTime(1500 + slip * 2200 + sn * 900, t, 0.06);

    // 摩擦底层：漂移 + 出界都有
    const scrub = Math.max(drifting ? 0.4 + slip * 0.6 : 0, offroad ? 0.75 : 0);
    this.scrubGain.gain.setTargetAtTime(scrub * 0.075, t, 0.05);
    this.scrubFilter.frequency.setTargetAtTime(offroad ? 480 : 800 + slip * 700, t, 0.08);

    // ---- 集气充能：音调随集气线性上升，松手前能听出攒到几档 ----
    const chargeVol = drifting && charge > 0.02 ? 0.05 : 0;
    this.chargeGain.gain.setTargetAtTime(chargeVol, t, 0.05);
    if (chargeVol > 0) {
      const f = 190 + charge * 520;
      this.chargeOsc.frequency.setTargetAtTime(f, t, 0.04);
      this.chargeOsc2.frequency.setTargetAtTime(f * 1.5, t, 0.04);
    }

    // 喷射轰鸣
    this.boostGain.gain.setTargetAtTime(boosting ? 0.14 : 0, t, boosting ? 0.02 : 0.14);
    this.boostFilter.frequency.setTargetAtTime(boosting ? 2400 : 700, t, 0.08);
  }

  // ---------------- 一次性音效 ----------------

  private blip(freq: number, dur: number, type: OscillatorType, vol: number, sweepTo?: number): void {
    if (!this.ctx || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (sweepTo !== undefined) o.frequency.exponentialRampToValueAtTime(Math.max(sweepTo, 1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private noiseBurst(dur: number, vol: number, type: BiquadFilterType, f0: number, f1: number, q = 1): void {
    if (!this.ctx || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  /**
   * 漂移喷射。分三层：
   *   1. 涡轮泄压“咄”（快速下扫的带通噪声）
   *   2. 低频轰鸣（方波上扫）
   *   3. 金属感高频点缀（档位/连喷越高越亮）
   */
  boost(tier: number, combo: number): void {
    const lift = tier * 0.5 + Math.min(combo, 4) * 0.35;
    // 泄压
    this.noiseBurst(0.26 + tier * 0.05, 0.1 + tier * 0.03, 'bandpass', 5200, 900, 3.2);
    // 轰鸣
    this.blip(90 + tier * 26, 0.3 + tier * 0.06, 'square', 0.075, 260 + lift * 90);
    // 金属点缀
    const ping = 620 + tier * 190 + combo * 90;
    setTimeout(() => this.blip(ping, 0.16, 'triangle', 0.055, ping * 1.7), 30);
  }

  /** 起漂：一下短促的胎噪，告诉玩家漂移真的进去了 */
  driftStart(): void {
    this.noiseBurst(0.16, 0.075, 'bandpass', 900, 2400, 4);
  }

  /** 集气跨档：三个递升的“叮”，不看 HUD 也能判断什么时候松手 */
  chargeTierUp(tier: 1 | 2 | 3): void {
    const f = [0, 760, 1020, 1380][tier];
    this.blip(f, 0.09, 'sine', 0.06);
    if (tier === 3) setTimeout(() => this.blip(f * 1.34, 0.12, 'sine', 0.055), 55);
  }

  nitro(): void {
    this.blip(150, 0.7, 'sawtooth', 0.1, 1500);
    this.noiseBurst(0.75, 0.15, 'lowpass', 420, 6000, 1.2);
    setTimeout(() => this.blip(1180, 0.22, 'triangle', 0.05, 2100), 70);
  }

  fizzle(): void {
    this.blip(280, 0.14, 'triangle', 0.05, 150);
  }

  crash(severity: number): void {
    this.noiseBurst(0.18 + severity * 0.2, 0.1 + severity * 0.16, 'lowpass', 1800, 160, 1);
    this.blip(90, 0.2, 'square', 0.06 * severity, 40);
  }

  land(hard: boolean): void {
    this.noiseBurst(hard ? 0.22 : 0.12, hard ? 0.13 : 0.06, 'lowpass', 900, 120);
  }

  hit(): void {
    this.blip(160, 0.35, 'sawtooth', 0.11, 55);
    this.noiseBurst(0.32, 0.12, 'bandpass', 2400, 300, 1.6);
  }

  countdown(n: number): void {
    if (n > 0) this.blip(520, 0.16, 'square', 0.11);
    else {
      this.blip(880, 0.5, 'square', 0.13);
      setTimeout(() => this.blip(1320, 0.4, 'sine', 0.09), 60);
    }
  }

  lap(): void {
    this.blip(720, 0.12, 'square', 0.08);
    setTimeout(() => this.blip(1080, 0.18, 'square', 0.08), 90);
  }

  finish(win: boolean): void {
    const seq = win ? [523, 659, 784, 1047] : [523, 494, 440];
    seq.forEach((f, i) => setTimeout(() => this.blip(f, 0.3, 'square', 0.1), i * 130));
  }

  ui(): void {
    this.blip(600, 0.05, 'sine', 0.05);
  }

  /** 停止所有持续音（暂停/回菜单） */
  silence(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (const g of [this.engGain, this.windGain, this.screechGain, this.scrubGain, this.chargeGain, this.boostGain]) {
      g?.gain.setTargetAtTime(0, t, 0.05);
    }
  }

  dispose(): void {
    this.engOsc.forEach((o) => { try { o.stop(); } catch { /* already stopped */ } });
    [this.chargeOsc, this.chargeOsc2].forEach((o) => { try { o?.stop(); } catch { /* already stopped */ } });
    [this.windSrc, this.screechSrc, this.scrubSrc, this.boostSrc].forEach((s) => {
      try { s?.stop(); } catch { /* already stopped */ }
    });
    void this.ctx?.close();
    this.ctx = null;
    this.started = false;
  }
}
