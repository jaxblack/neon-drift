/** 轻量数学工具（不依赖 three，物理层可独立于渲染层运行 / 未来可跑在服务端） */

export const TAU = Math.PI * 2;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 帧率无关的指数逼近：rate 越大收敛越快 */
export function damp(a: number, b: number, rate: number, dt: number): number {
  return lerp(a, b, 1 - Math.exp(-rate * dt));
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** 把角度规范到 (-PI, PI] */
export function wrapAngle(a: number): number {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/** 两角之间的最短差值 b - a */
export function angleDelta(a: number, b: number): number {
  return wrapAngle(b - a);
}

export function dampAngle(a: number, b: number, rate: number, dt: number): number {
  return a + angleDelta(a, b) * (1 - Math.exp(-rate * dt));
}

export function moveTowards(current: number, target: number, maxDelta: number): number {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

/** [min, max) 随机 */
export function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

export function randInt(min: number, maxExclusive: number): number {
  return Math.floor(rand(min, maxExclusive));
}

export function pick<T>(arr: readonly T[]): T {
  return arr[randInt(0, arr.length)];
}

/** 可复现随机数（种子化赛道生成用） */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 极简 2D 向量（XZ 平面） */
export interface Vec2 { x: number; z: number; }

export function v2(x = 0, z = 0): Vec2 { return { x, z }; }
export function v2len(v: Vec2): number { return Math.hypot(v.x, v.z); }
export function v2dot(a: Vec2, b: Vec2): number { return a.x * b.x + a.z * b.z; }
/** 2D 叉积（标量），符号表示 b 在 a 的左/右侧 */
export function v2cross(a: Vec2, b: Vec2): number { return a.x * b.z - a.z * b.x; }

export function v2norm(v: Vec2): Vec2 {
  const l = v2len(v);
  return l > 1e-9 ? { x: v.x / l, z: v.z / l } : { x: 0, z: 0 };
}

export function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '--:--.--';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.floor((seconds * 100) % 100);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
