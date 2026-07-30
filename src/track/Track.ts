import { clamp, lerp, mulberry32, TAU } from '../core/MathUtil';

/** 赛道中心线上的一个等距采样点 */
export interface TrackSample {
  /** 中心线位置 */
  x: number; y: number; z: number;
  /** 前进方向（XZ 平面归一化） */
  fx: number; fz: number;
  /** 左方向（= forward 逆时针 90°） */
  lx: number; lz: number;
  /** 路面半宽 */
  half: number;
  /** 侧倾（弧度，正 = 左高，过弯外倾） */
  bank: number;
  /** 累计弧长 */
  dist: number;
  /** 坡度 dy/ds */
  grade: number;
  /** 有符号曲率（1/m），正 = 左转 */
  curv: number;
}

export interface ProjectResult {
  /** 最近采样点索引 */
  index: number;
  /** 沿赛道的累计距离（含段内插值） */
  dist: number;
  /** 有符号侧向偏移，正 = 中心线左侧 */
  offset: number;
  /** 该处的路面高度 */
  height: number;
  /** 该处的路面半宽 */
  half: number;
  /** 车头相对赛道前进方向的夹角（rad，用于判逆行） */
  fx: number; fz: number;
  lx: number; lz: number;
  curv: number;
  grade: number;
  bank: number;
}

export interface Harmonic { k: number; a: number; phase: number; }

export interface TrackTheme {
  skyTop: number;
  skyBottom: number;
  fog: number;
  road: number;
  roadEdge: number;
  accent: number;
  ground: number;
  guardrail: number;
  /** 环境装饰：'city' 楼群 | 'coast' 海面+棕榈 | 'canyon' 岩壁 | 'space' 星空浮空道 */
  env: 'city' | 'coast' | 'canyon' | 'space';
  /** 彩虹路面（彩虹之路专用） */
  rainbow?: boolean;
  /** 悬空赛道：不渲染路肩草地，路面外就是虚空 */
  floating?: boolean;
}

export interface TrackDef {
  id: string;
  name: string;
  desc: string;
  seed: number;
  /** 基准半径（m） */
  radius: number;
  /** 半径谐波：决定弯道形状 */
  shape: Harmonic[];
  /** 高度谐波：决定上下坡 */
  hills: Harmonic[];
  /** 高度幅值（m） */
  hillAmp: number;
  /** 路面基准半宽 */
  half: number;
  /** 半宽调制幅度（0..1），让赛道有宽窄变化 */
  halfVar: number;
  /** 过弯侧倾强度 */
  bankStrength: number;
  /** 跳台数量 */
  ramps: number;
  /** 加速带数量 */
  boostPads: number;
  theme: TrackTheme;
}

export interface RampInfo {
  /** 沿赛道的起点距离 */
  dist: number;
  length: number;
  /** 抬升高度 */
  height: number;
  /** 中心侧向偏移 */
  offset: number;
  width: number;
}

export interface PadInfo { dist: number; offset: number; }

/** 采样间距（m）。越小越精确，代价是内存与投影搜索范围 */
const STEP = 1.6;

export class Track {
  readonly samples: TrackSample[] = [];
  readonly length: number;
  readonly ramps: RampInfo[] = [];
  readonly pads: PadInfo[] = [];
  /** 空间网格加速全局最近点查询 */
  private grid = new Map<number, number[]>();
  private cell = 24;
  private minX = 0; private minZ = 0;

  constructor(readonly def: TrackDef) {
    const raw = this.buildCenterline(def);
    this.length = this.resample(raw);
    this.computeCurvatureAndBank(def);
    this.placeFeatures(def);
    this.buildGrid();
  }

  // ---------------------------------------------------------------
  // 中心线生成：极坐标 r(θ) = R·(1 + Σ aᵢ·sin(kᵢθ + φᵢ))
  // 天然闭合、天然平滑，改谐波就能得到完全不同的赛道性格。
  // ---------------------------------------------------------------
  private buildCenterline(def: TrackDef): Array<{ x: number; y: number; z: number }> {
    const N = 2048;
    const pts: Array<{ x: number; y: number; z: number }> = [];
    for (let i = 0; i < N; i++) {
      const th = (i / N) * TAU;
      let rm = 1;
      for (const h of def.shape) rm += h.a * Math.sin(h.k * th + h.phase);
      const r = def.radius * rm;

      let hm = 0;
      for (const h of def.hills) hm += h.a * Math.sin(h.k * th + h.phase);
      const y = def.hillAmp * hm;

      pts.push({ x: Math.cos(th) * r, y, z: Math.sin(th) * r });
    }
    return pts;
  }

  /** 把任意间距的原始点重采样成等距（STEP）采样点 */
  private resample(raw: Array<{ x: number; y: number; z: number }>): number {
    const n = raw.length;
    // 累计弧长
    const cum: number[] = new Array(n + 1);
    cum[0] = 0;
    for (let i = 0; i < n; i++) {
      const a = raw[i];
      const b = raw[(i + 1) % n];
      cum[i + 1] = cum[i] + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    }
    const total = cum[n];
    const count = Math.max(64, Math.round(total / STEP));
    const step = total / count;

    let seg = 0;
    for (let i = 0; i < count; i++) {
      const d = i * step;
      while (seg < n - 1 && cum[seg + 1] < d) seg++;
      const t = (d - cum[seg]) / Math.max(cum[seg + 1] - cum[seg], 1e-6);
      const a = raw[seg];
      const b = raw[(seg + 1) % n];
      this.samples.push({
        x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t),
        fx: 0, fz: 0, lx: 0, lz: 0,
        half: 0, bank: 0, dist: d, grade: 0, curv: 0,
      });
    }

    // 切线 / 左向量（中心差分，闭合环）
    const m = this.samples.length;
    for (let i = 0; i < m; i++) {
      const p = this.samples[(i - 1 + m) % m];
      const q = this.samples[(i + 1) % m];
      let dx = q.x - p.x, dz = q.z - p.z;
      const dy = q.y - p.y;
      const l = Math.hypot(dx, dz) || 1;
      dx /= l; dz /= l;
      const s = this.samples[i];
      s.fx = dx; s.fz = dz;
      // 左 = 前进方向逆时针旋转 90°（Y 轴向上的右手系）
      s.lx = -dz; s.lz = dx;
      s.grade = dy / (2 * step);
    }
    return total;
  }

  /** 曲率 → 侧倾 + 宽度调制（弯道略窄、直道略宽，逼出走线选择） */
  private computeCurvatureAndBank(def: TrackDef): void {
    const m = this.samples.length;
    const rng = mulberry32(def.seed ^ 0x9e3779b9);
    const wPhase = rng() * TAU;

    for (let i = 0; i < m; i++) {
      const a = this.samples[(i - 2 + m) % m];
      const b = this.samples[(i + 2) % m];
      // 航向变化率 = 曲率
      const ha = Math.atan2(a.fz, a.fx);
      const hb = Math.atan2(b.fz, b.fx);
      let dh = hb - ha;
      while (dh > Math.PI) dh -= TAU;
      while (dh < -Math.PI) dh += TAU;
      const ds = 4 * STEP;
      this.samples[i].curv = -dh / ds; // 取负：左转为正
    }
    // 平滑曲率
    const sm = new Array<number>(m);
    const R = 6;
    for (let i = 0; i < m; i++) {
      let s = 0;
      for (let k = -R; k <= R; k++) s += this.samples[(i + k + m) % m].curv;
      sm[i] = s / (2 * R + 1);
    }
    for (let i = 0; i < m; i++) {
      const s = this.samples[i];
      s.curv = sm[i];
      s.bank = clamp(sm[i] * def.radius * def.bankStrength, -0.22, 0.22);
      const th = (i / m) * TAU;
      const wob = Math.sin(3 * th + wPhase) * 0.5 + Math.sin(7 * th + wPhase * 2) * 0.28;
      // 弯道收窄一点，让内外线差异更明显
      const curveNarrow = 1 - Math.min(Math.abs(sm[i]) * def.radius * 0.55, 0.3);
      s.half = def.half * (1 + def.halfVar * wob) * curveNarrow;
    }
  }

  /** 分布跳台 / 加速带 / 道具箱 —— 尽量放在直道或缓弯上 */
  private placeFeatures(def: TrackDef): void {
    const rng = mulberry32(def.seed);
    const m = this.samples.length;
    const straightness = (i: number) => 1 - Math.min(Math.abs(this.samples[i].curv) * 260, 1);

    const spread = (count: number, minStraight: number, minGapM: number): number[] => {
      const out: number[] = [];
      let guard = 0;
      while (out.length < count && guard++ < count * 400) {
        const i = Math.floor(rng() * m);
        if (straightness(i) < minStraight) continue;
        const d = this.samples[i].dist;
        // 起跑线附近留空
        if (d < 90 || d > this.length - 60) continue;
        if (out.some((o) => Math.abs(o - d) < minGapM || Math.abs(o - d) > this.length - minGapM)) continue;
        out.push(d);
      }
      return out.sort((a, b) => a - b);
    };

    for (const d of spread(def.ramps, 0.72, 150)) {
      this.ramps.push({
        dist: d,
        length: 22 + rng() * 12,
        height: 2.6 + rng() * 2.4,
        offset: (rng() - 0.5) * this.sampleAt(d).half * 0.7,
        width: 9 + rng() * 5,
      });
    }

    for (const d of spread(def.boostPads, 0.55, 110)) {
      this.pads.push({ dist: d, offset: (rng() - 0.5) * this.sampleAt(d).half * 1.1 });
    }
  }

  private buildGrid(): void {
    let minX = Infinity, minZ = Infinity;
    for (const s of this.samples) { if (s.x < minX) minX = s.x; if (s.z < minZ) minZ = s.z; }
    this.minX = minX - this.cell;
    this.minZ = minZ - this.cell;
    for (let i = 0; i < this.samples.length; i++) {
      const s = this.samples[i];
      const key = this.key(s.x, s.z);
      let arr = this.grid.get(key);
      if (!arr) { arr = []; this.grid.set(key, arr); }
      arr.push(i);
    }
  }

  private key(x: number, z: number): number {
    const cx = Math.floor((x - this.minX) / this.cell);
    const cz = Math.floor((z - this.minZ) / this.cell);
    return cx * 73856093 ^ cz * 19349663;
  }

  /** 沿赛道距离取样（线性插值，距离自动 wrap） */
  sampleAt(dist: number): TrackSample {
    const m = this.samples.length;
    let d = dist % this.length;
    if (d < 0) d += this.length;
    const fi = (d / this.length) * m;
    const i0 = Math.floor(fi) % m;
    const i1 = (i0 + 1) % m;
    const t = fi - Math.floor(fi);
    const a = this.samples[i0], b = this.samples[i1];
    return {
      x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t),
      fx: lerp(a.fx, b.fx, t), fz: lerp(a.fz, b.fz, t),
      lx: lerp(a.lx, b.lx, t), lz: lerp(a.lz, b.lz, t),
      half: lerp(a.half, b.half, t), bank: lerp(a.bank, b.bank, t),
      dist: d, grade: lerp(a.grade, b.grade, t), curv: lerp(a.curv, b.curv, t),
    };
  }

  /**
   * 把世界坐标投影到赛道上。
   * hint = 上一帧的采样索引，有它就只做局部搜索（O(1)），赛车是连续运动的所以几乎总能命中。
   */
  project(x: number, z: number, hint = -1): ProjectResult {
    const m = this.samples.length;
    let best = -1;
    let bestD2 = Infinity;

    if (hint >= 0) {
      const R = 48; // ±48 * 1.6m ≈ ±77m，足够覆盖一帧位移与轻微偏离
      for (let k = -R; k <= R; k++) {
        const i = (hint + k + m) % m;
        const s = this.samples[i];
        const d2 = (s.x - x) ** 2 + (s.z - z) ** 2;
        if (d2 < bestD2) { bestD2 = d2; best = i; }
      }
      // 局部搜索结果太远说明 hint 失效，退回全局
      if (bestD2 > 90 * 90) best = -1;
    }

    if (best < 0) {
      const cx = Math.floor((x - this.minX) / this.cell);
      const cz = Math.floor((z - this.minZ) / this.cell);
      for (let r = 0; r <= 3 && best < 0; r++) {
        for (let ox = -r; ox <= r; ox++) {
          for (let oz = -r; oz <= r; oz++) {
            if (r > 0 && Math.abs(ox) !== r && Math.abs(oz) !== r) continue;
            const arr = this.grid.get(((cx + ox) * 73856093) ^ ((cz + oz) * 19349663));
            if (!arr) continue;
            for (const i of arr) {
              const s = this.samples[i];
              const d2 = (s.x - x) ** 2 + (s.z - z) ** 2;
              if (d2 < bestD2) { bestD2 = d2; best = i; }
            }
          }
        }
      }
      if (best < 0) {
        // 兜底：全量扫描（只会在车飞出地图很远时发生）
        for (let i = 0; i < m; i++) {
          const s = this.samples[i];
          const d2 = (s.x - x) ** 2 + (s.z - z) ** 2;
          if (d2 < bestD2) { bestD2 = d2; best = i; }
        }
      }
    }

    // 在 best 与相邻点之间做线性投影，得到亚采样精度
    const s = this.samples[best];
    const dx = x - s.x, dz = z - s.z;
    const along = dx * s.fx + dz * s.fz;      // 沿前进方向的分量
    const offset = dx * s.lx + dz * s.lz;     // 侧向分量（左正）
    const t = clamp(along / STEP, -1, 1);
    const nb = this.samples[(best + (t >= 0 ? 1 : m - 1)) % m];
    const w = Math.abs(t);

    let dist = s.dist + along;
    if (dist < 0) dist += this.length;
    if (dist >= this.length) dist -= this.length;

    return {
      index: best,
      dist,
      offset,
      height: lerp(s.y, nb.y, w),
      half: lerp(s.half, nb.half, w),
      fx: s.fx, fz: s.fz, lx: s.lx, lz: s.lz,
      curv: lerp(s.curv, nb.curv, w),
      grade: lerp(s.grade, nb.grade, w),
      bank: lerp(s.bank, nb.bank, w),
    };
  }

  /** 世界坐标 → 路面高度（含跳台抬升与侧倾） */
  surfaceHeight(x: number, z: number, hint = -1): { y: number; proj: ProjectResult } {
    const p = this.project(x, z, hint);
    let y = p.height - Math.sin(p.bank) * p.offset;
    y += this.rampLift(p.dist, p.offset);
    return { y, proj: p };
  }

  /** 跳台在给定位置的抬升高度（梯形剖面：上坡 → 平台 → 断崖） */
  rampLift(dist: number, offset: number): number {
    for (const r of this.ramps) {
      let d = dist - r.dist;
      if (d < -this.length / 2) d += this.length;
      if (d > this.length / 2) d -= this.length;
      if (d < 0 || d > r.length) continue;
      if (Math.abs(offset - r.offset) > r.width * 0.5) continue;
      // 边缘做平滑过渡，避免侧向撞上"看不见的台阶"
      const lateral = 1 - Math.min(Math.abs(offset - r.offset) / (r.width * 0.5), 1);
      const lat = lateral * lateral * (3 - 2 * lateral);
      const t = d / r.length;
      const profile = t < 0.78 ? Math.sin((t / 0.78) * Math.PI * 0.5) : 1;
      return r.height * profile * lat;
    }
    return 0;
  }

  /** 起跑格位置：2 列错开排布，站在起跑线之前 */
  startGrid(n: number): Array<{ x: number; y: number; z: number; heading: number }> {
    const out = [];
    for (let i = 0; i < n; i++) {
      const row = Math.floor(i / 2);
      const col = i % 2 === 0 ? -1 : 1;
      const d = -18 - row * 9;
      const s = this.sampleAt(d);
      const off = col * Math.min(s.half * 0.42, 5);
      const x = s.x + s.lx * off;
      const z = s.z + s.lz * off;
      out.push({
        x,
        // 必须用 surfaceHeight 而不是中心线采样的 s.y：
        // 起跑格在中心线侧方 off 米处，路面带 banking，两者相差能到 0.8m。
        // 以前写 s.y + 0.4 相当于把车直接塑在路面以下半米。
        y: this.surfaceHeight(x, z).y + 0.05,
        z,
        heading: Math.atan2(s.fx, s.fz),
      });
    }
    return out;
  }

  /**
   * 生成一条 AI 参考线（贴内道，带前瞻切弯）。
   * 注意 offset 的符号约定：+ = 中心线的 lx/lz 侧，从驾驶员视角看是右侧。
   * curv > 0 表示左转弯，内道在左，所以要取负。
   */
  racingLineOffset(dist: number, aggression = 1): number {
    const ahead = this.sampleAt(dist + 20);
    const here = this.sampleAt(dist);
    const k = (here.curv * 0.6 + ahead.curv * 0.4);
    return -clamp(k * 900 * aggression, -1, 1) * here.half * 0.36;
  }
}

// =================================================================
// 内置赛道
// =================================================================
export const TRACKS: TrackDef[] = [
  {
    id: 'neon-city',
    name: '霓虹都市',
    desc: '中速弯 · 多连续 S 弯 · 新手友好',
    seed: 20260729,
    radius: 330,
    shape: [
      { k: 2, a: 0.20, phase: 0.4 },
      { k: 3, a: 0.13, phase: 2.1 },
      { k: 5, a: 0.055, phase: 4.4 },
    ],
    hills: [{ k: 1, a: 0.6, phase: 0.9 }, { k: 3, a: 0.4, phase: 3.2 }],
    hillAmp: 12,
    half: 11.5,
    halfVar: 0.12,
    bankStrength: 0.55,
    ramps: 2,
    boostPads: 6,
    theme: {
      skyTop: 0x141438, skyBottom: 0x46208c, fog: 0x2a1e58,
      road: 0x4c5268, roadEdge: 0x22e6ff, accent: 0xff2fb9,
      ground: 0x1d2340, guardrail: 0x8b5cff, env: 'city',
    },
  },
  {
    id: 'coastal-loop',
    name: '环海高速',
    desc: '长直道 · 高速弯 · 极速对决',
    seed: 777001,
    radius: 430,
    shape: [
      { k: 1, a: 0.26, phase: 1.2 },
      { k: 2, a: 0.11, phase: 3.6 },
      { k: 4, a: 0.04, phase: 0.2 },
    ],
    hills: [{ k: 2, a: 0.7, phase: 2.4 }, { k: 5, a: 0.3, phase: 1.1 }],
    hillAmp: 9,
    half: 13,
    halfVar: 0.1,
    bankStrength: 0.7,
    ramps: 3,
    boostPads: 8,
    theme: {
      skyTop: 0x1b4a78, skyBottom: 0xff9a6b, fog: 0x4d7398,
      road: 0x565b6e, roadEdge: 0xffd23f, accent: 0x35f5a0,
      ground: 0x1c6b7d, guardrail: 0x22e6ff, env: 'coast',
    },
  },
  {
    id: 'canyon-rush',
    name: '极限峡谷',
    desc: '窄路 · 急弯 · 大落差跳台',
    seed: 424242,
    radius: 290,
    shape: [
      { k: 3, a: 0.26, phase: 0.7 },
      { k: 4, a: 0.15, phase: 2.9 },
      { k: 7, a: 0.07, phase: 5.1 },
    ],
    hills: [{ k: 2, a: 0.55, phase: 0.3 }, { k: 4, a: 0.45, phase: 2.2 }, { k: 6, a: 0.25, phase: 4.8 }],
    hillAmp: 22,
    half: 9.5,
    halfVar: 0.16,
    bankStrength: 0.5,
    ramps: 4,
    boostPads: 5,
    theme: {
      skyTop: 0x2e1450, skyBottom: 0xf2703c, fog: 0x6b3a2e,
      road: 0x585044, roadEdge: 0xff7a3d, accent: 0xffd23f,
      ground: 0x6b4228, guardrail: 0xff4d5e, env: 'canyon',
    },
  },
  {
    id: 'mountain-pass',
    name: '盘山夜道',
    desc: '连续发夹弯 · 大落差盘山 · 漂移天堂',
    seed: 8686861,
    radius: 265,
    shape: [
      { k: 5, a: 0.21, phase: 1.6 },
      { k: 3, a: 0.17, phase: 4.2 },
      { k: 8, a: 0.065, phase: 2.4 },
      { k: 2, a: 0.09, phase: 0.5 },
    ],
    hills: [{ k: 1, a: 0.85, phase: 1.4 }, { k: 3, a: 0.32, phase: 3.9 }, { k: 6, a: 0.14, phase: 0.8 }],
    hillAmp: 36,
    half: 9.8,
    halfVar: 0.14,
    bankStrength: 0.42,
    ramps: 2,
    boostPads: 4,
    theme: {
      skyTop: 0x0d1430, skyBottom: 0x2a3f6b, fog: 0x22304f,
      road: 0x4a4f5c, roadEdge: 0xffb03a, accent: 0xff5a3c,
      ground: 0x24331f, guardrail: 0xffd23f, env: 'canyon',
    },
  },
  {
    id: 'rainbow-road',
    name: '星际彩虹',
    desc: '悬空窄道 · 超高倾斜弯 · 掉下去就重来',
    seed: 19851124,
    radius: 400,
    shape: [
      { k: 2, a: 0.23, phase: 0.9 },
      { k: 3, a: 0.14, phase: 3.3 },
      { k: 5, a: 0.085, phase: 5.6 },
    ],
    hills: [{ k: 2, a: 0.72, phase: 2.0 }, { k: 5, a: 0.42, phase: 4.6 }, { k: 3, a: 0.3, phase: 0.4 }],
    hillAmp: 44,
    half: 10.5,
    halfVar: 0.1,
    bankStrength: 0.95,
    ramps: 3,
    boostPads: 7,
    theme: {
      skyTop: 0x03030f, skyBottom: 0x160a33, fog: 0x0a0820,
      road: 0x2a2450, roadEdge: 0xffffff, accent: 0x35f5a0,
      ground: 0x0a0820, guardrail: 0x22e6ff, env: 'space',
      rainbow: true, floating: true,
    },
  },
];

export function getTrackDef(id: string): TrackDef {
  return TRACKS.find((t) => t.id === id) ?? TRACKS[0];
}
