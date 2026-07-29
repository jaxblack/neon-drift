/**
 * 手感调参中心 —— 所有影响驾驶体验的常数都在这里。
 * 单位：距离 m，时间 s，速度 m/s，角度 rad。
 * 显示速度 km/h = m/s * 3.6，但为了"飞车感"我们乘一个展示系数。
 */

export const TICK_HZ = 120;
export const FIXED_DT = 1 / TICK_HZ;
export const MAX_SUBSTEPS = 6;

/** 速度表展示系数：物理 62 m/s 显示成 ~310 km/h，符合飞车类游戏观感 */
export const SPEED_DISPLAY_SCALE = 5.0;

export const KART = {
  // ---- 纵向 ----
  /** 基础极速（未加速状态） */
  maxSpeed: 62,
  /** 倒车极速 */
  reverseMaxSpeed: 16,
  /** 油门加速度（会随速度衰减，见 accelCurve） */
  accel: 42,
  /** 高速时加速度衰减到的比例 */
  accelHighSpeedFactor: 0.22,
  /** 刹车减速度 */
  brakeDecel: 78,
  /** 松油门的引擎制动 */
  engineBrake: 11,
  /** 空气阻力系数（v² 项） */
  drag: 0.0042,
  /** 滚动阻力 */
  rollResist: 1.6,

  // ---- 转向 ----
  /** 低速最大转向角速度 */
  steerRateLow: 2.75,
  /** 高速最大转向角速度 */
  steerRateHigh: 1.35,
  /** 转向输入的平滑速率（越大越跟手） */
  steerLerp: 9.5,
  /** 漂移时车头额外偏转（决定漂移弧线的锐利程度） */
  driftYawBias: 1.66,
  /** 漂移中方向键对弧线的调整幅度 */
  driftSteerAuthority: 1.15,

  // ---- 抓地 ----
  /** 正常行驶时速度方向收敛到车头的速率（越大越"贴地"） */
  gripNormal: 9.0,
  /** 漂移时的抓地力（越小滑得越夸张，但太小会直接滑出赛道） */
  gripDrift: 1.85,
  /** 出界（路肩/草地）时的抓地力 */
  gripOffroad: 4.5,

  // ---- 漂移 / 集气 ----
  /** 进入漂移所需的最低速度（太高的话弯道里根本起不了漂） */
  driftMinSpeed: 13,
  /** 漂移开始时给的一脚"甩尾"冲量（rad/s） */
  driftKick: 1.5,
  /**
   * 起漂瞬间的速度惩罚（比例）。
   * 这是每次漂移都要付的固定代价 —— 没它的话无脑连点漂移键就是白嫖。
   */
  driftEntryCost: 0.06,
  /** 短于这个时长的漂移不给喷射（防止"点一下就喷"） */
  minDriftTime: 0.16,
  /**
   * 漂移的代价：基础纵向阻力（m/s²）。
   * 漂移必须明显掉速，才能形成"掉速集气 → 喷射赚回来"的正循环；
   * 不掉速的话漂移就变成无脑一直按着，没有取舍。
   */
  driftDrag: 11,
  /** 侧滑带来的额外阻力：滑得越狠掉速越多 */
  driftSlipDrag: 26,
  /** 漂移时的极速上限倍率 */
  driftSpeedCap: 0.85,
  /** 集气速率基准（每秒） */
  chargeRate: 1.0,
  /** 侧滑角对集气速率的加成（滑得越狠涨得越快） */
  chargeSlipBonus: 1.35,
  /** 三档喷射阈值（集气值） */
  tier: [0.30, 0.58, 0.84] as const,
  /** 集气上限 */
  chargeMax: 1.0,
  /** 各档喷射：[持续时间, 额外速度上限, 推力]。漂移掉速越多，这里就要给得越狠 */
  boostTiers: [
    { time: 0.6, extraSpeed: 10, thrust: 50 },  // 小喷
    { time: 1.05, extraSpeed: 18, thrust: 68 }, // 中喷
    { time: 1.6, extraSpeed: 26, thrust: 88 },  // 大喷
  ] as const,

  // ---- 连喷（QQ飞车核心技巧） ----
  /** 喷射开始后允许接下一次漂移的黄金窗口 */
  comboWindow: 0.45,
  /** 连喷时集气的初始值（只给一点种子，仍然需要真的漂一下） */
  comboSeedCharge: 0.10,
  /** 连喷时集气速率倍率 */
  comboChargeMult: 1.9,
  /** 每层连击对喷射时长的加成（连喷主要买“持续高速”，不无限叠极速） */
  comboTimeBonus: 0.16,
  /** 每层连击对极速上限的加成（刻意做得很小） */
  comboSpeedBonus: 0.05,
  /** 连击上限 */
  comboMax: 4,

  // ---- 氮气 ----
  /** 漂移集气转化为氮气的比率 */
  nitroFromDrift: 0.55,
  /** 氮气格数（最多积攒两格） */
  nitroCells: 2,
  /** 每格氮气喷射时长 */
  nitroTime: 1.9,
  nitroExtraSpeed: 30,
  nitroThrust: 96,

  // ---- 跳跃 / 落地 ----
  gravity: -46,
  /** 落地喷的时间窗口 */
  landingBoostWindow: 0.22,
  /** 起跳需要的最小离地时间才算"腾空" */
  airborneThreshold: 0.12,

  // ---- 碰撞 ----
  /** 车辆半径（用于车车碰撞） */
  radius: 1.5,
  /** 撞墙后速度保留比例 */
  wallBounce: 0.42,
  /** 撞墙时的减速 */
  wallSpeedLoss: 0.55,
  /** 车车碰撞的推开强度 */
  bumpImpulse: 16,

  // ---- 路面 ----
  /** 赛道外（路肩）速度上限倍率 */
  offroadSpeedMult: 0.55,
  offroadDrag: 16,
} as const;

/** AI 难度参数。lookahead 不能太大：赛道只有 ~20m 宽，前瞻太远会把弯切到路外 */
export const AI_PROFILES = {
  easy: { speedMult: 0.78, lookahead: 30, driftSkill: 0.28, mistakeRate: 0.16, reaction: 0.35 },
  normal: { speedMult: 0.88, lookahead: 26, driftSkill: 0.52, mistakeRate: 0.08, reaction: 0.17 },
  hard: { speedMult: 0.98, lookahead: 23, driftSkill: 0.82, mistakeRate: 0.025, reaction: 0.1 },
} as const;

export type Difficulty = keyof typeof AI_PROFILES;

export const CAMERA = {
  distance: 9.0,
  height: 3.9,
  /** 注视点前瞻距离——这个值直接决定了车在屏幕上的高度，调大会把车压到屏幕底部 */
  lookAhead: 8,
  /** 注视点相对车轮的高度 */
  lookHeight: 0.9,
  /** 相机跟随的平滑速率 */
  posLerp: 9.0,
  lookLerp: 11.0,
  fovBase: 68,
  fovSpeedGain: 17,
  fovBoostGain: 14,
  /** 漂移时相机的侧向偏移 */
  driftOffset: 2.2,
} as const;

export const RACE = {
  countdownSeconds: 3,
  /** 落后时的橡皮筋加速（追赶机制），0 = 关闭 */
  rubberBandMax: 0.10,
  /** 复位到赛道所需的按键时长 */
  respawnHold: 0.25,
  /** 逆行/离开赛道过久自动复位 */
  autoRespawnAfter: 2.2,
} as const;

/** 玩家可选颜色（索引 0 固定给玩家，亮青色最醒目） */
export const RACER_COLORS = [
  0x22e6ff, 0xff2fb9, 0xffd23f, 0x35f5a0,
  0x8b5cff, 0xff7a3d, 0xffffff, 0xff4d5e,
];

export const RACER_NAMES = [
  '闪电狼', '夜行者', '涡轮猫', '赤焰',
  '零式', '银翼', '雷霆', '幻影',
];
