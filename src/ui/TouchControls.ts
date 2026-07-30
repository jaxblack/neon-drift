import { clamp } from '../core/MathUtil';
import type { Input, Action } from '../core/Input';

/** 转向方式：虚拟摇杆（手指左右拖）/ 陀螺仪（左右倾斜手机） */
export type SteerMode = 'wheel' | 'gyro';

export interface TouchSettings {
  steerMode: SteerMode;
  /** 自动油门：不用一直按住加速键 */
  autoThrottle: boolean;
  /** 陀螺仪灵敏度：达到满舵所需的倾角（度） */
  gyroRange: number;
}

/**
 * 触屏设备判定。
 *
 * 之前是 `coarse || maxTouchPoints > 0 || 'ontouchstart' in window`，
 * 后两个条件在桌面上普遍为真：带触摸屏的 Windows 笔记本 maxTouchPoints 就 > 0，
 * 桌面版 Chrome 默认也带 ontouchstart。结果端游一样弹出一排虚拟按钮。
 *
 * 正确的判据是"主指针是粗指针，且没有任何精确指针"：
 *   - 手机/纯平板：pointer:coarse 真、any-pointer:fine 假  → 显示
 *   - 触屏笔记本（有鼠标/触控板）：pointer:coarse 假       → 不显示
 *   - 纯桌面：两个都指向精确指针                           → 不显示
 */
export function isTouchDevice(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  const coarsePrimary = window.matchMedia('(pointer: coarse)').matches;
  const anyFine = window.matchMedia('(any-pointer: fine)').matches;
  return coarsePrimary && !anyFine;
}

type OrientationEventCtor = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<'granted' | 'denied'>;
};

/** iOS 13+ 需要在用户手势里申请陀螺仪权限；其他平台直接返回 true */
export async function requestGyroPermission(): Promise<boolean> {
  if (typeof DeviceOrientationEvent === 'undefined') return false;
  const ctor = DeviceOrientationEvent as OrientationEventCtor;
  if (typeof ctor.requestPermission !== 'function') return true;
  try {
    return (await ctor.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}

/**
 * 陀螺仪转向：把手机绕「屏幕水平轴」的倾角映射到 -1..1 的方向盘。
 * 竖屏用 gamma，横屏用 beta（并按 screen.orientation.angle 取符号）。
 */
class GyroSteer {
  /** -1..1 */
  value = 0;
  /** 是否收到过事件（没有传感器时用来提示玩家） */
  active = false;
  /** 校准零点（度） */
  private neutral: number | null = null;
  private raw = 0;
  private listening = false;
  private handler = (e: DeviceOrientationEvent) => this.onOrientation(e);

  constructor(private range = 26) {}

  setRange(deg: number): void { this.range = clamp(deg, 8, 60); }

  start(): void {
    if (this.listening) return;
    window.addEventListener('deviceorientation', this.handler);
    this.listening = true;
  }

  stop(): void {
    if (!this.listening) return;
    window.removeEventListener('deviceorientation', this.handler);
    this.listening = false;
    this.active = false;
    this.value = 0;
  }

  /** 把当前握持姿势记为「方向盘回正」 */
  calibrate(): void { this.neutral = this.raw; }

  reset(): void { this.neutral = null; this.value = 0; }

  private onOrientation(e: DeviceOrientationEvent): void {
    const beta = e.beta ?? 0;   // 前后倾（-180..180）
    const gamma = e.gamma ?? 0; // 左右倾（-90..90）
    const angle = (screen.orientation?.angle ?? (window as unknown as { orientation?: number }).orientation ?? 0);

    let tilt: number;
    if (angle === 90) tilt = beta;
    else if (angle === 270 || angle === -90) tilt = -beta;
    else if (angle === 180) tilt = -gamma;
    else tilt = gamma;

    this.raw = tilt;
    this.active = true;
    if (this.neutral === null) this.neutral = tilt;

    const dz = 1.2; // 死区（度），消掉手抖
    let d = tilt - this.neutral;
    d = Math.abs(d) < dz ? 0 : d - Math.sign(d) * dz;
    this.value = clamp(d / this.range, -1, 1);
  }
}

/**
 * 移动端触摸控件：
 * - 左半屏虚拟摇杆（按下即出现，左右拖动转向）或陀螺仪
 * - 右侧加速 / 刹车 / 漂移 / 氮气
 * - 顶部小按钮：暂停 / 视角 / 复位
 * 所有输入都通过 Input 的模拟轴与虚拟按键注入，物理层完全无感知。
 */
export class TouchControls {
  onPause?: () => void;
  onCamera?: () => void;
  /** 陀螺仪不可用时通知外部（提示玩家回退到摇杆） */
  onGyroUnavailable?: () => void;
  /** 玩家点了倾角条重新校准 */
  onCalibrate?: () => void;

  private root: HTMLElement;
  private zone: HTMLElement;
  private stick: HTMLElement;
  private knob: HTMLElement;
  private tilt: HTMLElement;
  private tiltNeedle: HTMLElement;
  private throttleBtn: HTMLElement;

  private gyro = new GyroSteer();
  private gyroWarned = false;
  private steer = 0;
  private throttle = 0;
  private brake = 0;

  /** 摇杆满舵半径（px），跟随窗口尺寸，避免在 pointermove 里反复读 layout */
  private stickRadius = 72;
  private stickPointer: number | null = null;
  private stickOriginX = 0;
  private stickOriginY = 0;
  private detach: Array<() => void> = [];

  constructor(private input: Input, private settings: TouchSettings) {
    this.root = document.getElementById('touch') as HTMLElement;
    this.zone = document.getElementById('touch-steer-zone') as HTMLElement;
    this.stick = document.getElementById('touch-stick') as HTMLElement;
    this.knob = document.getElementById('touch-knob') as HTMLElement;
    this.tilt = document.getElementById('touch-tilt') as HTMLElement;
    this.tiltNeedle = document.getElementById('touch-tilt-needle') as HTMLElement;
    this.throttleBtn = document.getElementById('tb-throttle') as HTMLElement;

    this.gyro.setRange(settings.gyroRange);
    this.updateStickRadius();
    const onResize = () => this.updateStickRadius();
    window.addEventListener('resize', onResize);
    this.detach.push(() => window.removeEventListener('resize', onResize));
    this.bindStick();
    this.bindButton('tb-throttle', 'throttle');
    this.bindButton('tb-brake', 'brake');
    this.bindButton('tb-drift', 'drift');
    this.bindButton('tb-nitro', 'nitro');
    this.bindButton('tb-respawn', 'respawn');
    this.bindTap('tb-pause', () => this.onPause?.());
    this.bindTap('tb-camera', () => this.onCamera?.());
    this.bindTap('touch-tilt', () => { this.calibrateGyro(); this.onCalibrate?.(); });
    this.applySettings(settings);
  }

  /** 更新设置（菜单里改了操控方式后调用） */
  applySettings(s: TouchSettings): void {
    this.settings = s;
    this.gyro.setRange(s.gyroRange);
    const useGyro = s.steerMode === 'gyro';
    this.zone.classList.toggle('hidden', useGyro);
    this.tilt.classList.toggle('hidden', !useGyro);
    this.throttleBtn.classList.toggle('auto', s.autoThrottle);
    if (useGyro) this.gyro.start(); else this.gyro.stop();
    if (!useGyro) { this.gyroWarned = false; this.releaseStick(); }
  }

  /** 把当前握持姿势设为方向盘中位 */
  calibrateGyro(): void { this.gyro.calibrate(); }

  show(): void {
    this.root.classList.remove('hidden');
    this.gyro.reset();
    if (this.settings.steerMode === 'gyro') this.gyro.start();
  }

  hide(): void {
    this.root.classList.add('hidden');
    this.reset();
    this.gyro.stop();
  }

  /** 每渲染帧在 Input.sample 之前调用 */
  update(): void {
    if (this.settings.steerMode === 'gyro') {
      if (this.gyro.active) {
        this.steer = this.gyro.value;
      } else if (!this.gyroWarned) {
        this.gyroWarned = true;
        this.onGyroUnavailable?.();
      }
      const pct = (clamp(this.steer, -1, 1) * 0.5 + 0.5) * 100;
      this.tiltNeedle.style.left = `${pct}%`;
    }
    const throttle = this.settings.autoThrottle && this.brake <= 0 ? 1 : this.throttle;
    this.input.setAnalog(this.steer, throttle, this.brake);
  }

  reset(): void {
    this.steer = this.throttle = this.brake = 0;
    this.releaseStick();
    this.input.setAnalog(0, 0, 0);
  }

  dispose(): void {
    this.detach.forEach((fn) => fn());
    this.detach = [];
    this.gyro.stop();
  }

  // ---------- 内部 ----------

  private bindStick(): void {
    const zone = this.zone;

    const down = (e: PointerEvent) => {
      if (this.stickPointer !== null) return;
      e.preventDefault();
      this.stickPointer = e.pointerId;
      zone.setPointerCapture?.(e.pointerId);
      this.stickOriginX = e.clientX;
      this.stickOriginY = e.clientY;
      const r = zone.getBoundingClientRect();
      this.stick.style.left = `${e.clientX - r.left}px`;
      this.stick.style.top = `${e.clientY - r.top}px`;
      this.stick.classList.add('on');
      this.moveKnob(0);
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== this.stickPointer) return;
      e.preventDefault();
      const radius = this.stickRadius;
      const dx = clamp((e.clientX - this.stickOriginX) / radius, -1, 1);
      // 手指上下滑动时慢慢把原点跟过去，长时间拖动不会「跑偏」
      const dy = e.clientY - this.stickOriginY;
      if (Math.abs(dy) > radius) this.stickOriginY += dy - Math.sign(dy) * radius;
      this.steer = Math.abs(dx) < 0.06 ? 0 : dx;
      this.moveKnob(this.steer);
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== this.stickPointer) return;
      this.releaseStick();
    };

    zone.addEventListener('pointerdown', down);
    zone.addEventListener('pointermove', move);
    zone.addEventListener('pointerup', up);
    zone.addEventListener('pointercancel', up);
    this.detach.push(() => {
      zone.removeEventListener('pointerdown', down);
      zone.removeEventListener('pointermove', move);
      zone.removeEventListener('pointerup', up);
      zone.removeEventListener('pointercancel', up);
    });
  }

  private releaseStick(): void {
    this.stickPointer = null;
    this.stick.classList.remove('on');
    if (this.settings.steerMode !== 'gyro') this.steer = 0;
    this.moveKnob(0);
  }

  private updateStickRadius(): void {
    this.stickRadius = Math.min(96, Math.max(56, window.innerWidth * 0.11));
  }

  private moveKnob(v: number): void {
    this.knob.style.transform = `translate(calc(-50% + ${v * this.stickRadius * 0.55}px), -50%)`;
  }

  /** 按住型按钮：throttle/brake 走模拟轴，其余走虚拟按键 */
  private bindButton(id: string, action: Action | 'throttle' | 'brake'): void {
    const el = document.getElementById(id);
    if (!el) return;
    const set = (down: boolean) => {
      el.classList.toggle('down', down);
      if (action === 'throttle') this.throttle = down ? 1 : 0;
      else if (action === 'brake') this.brake = down ? 1 : 0;
      else this.input.setVirtual(action, down);
    };
    const onDown = (e: PointerEvent) => {
      e.preventDefault();
      el.setPointerCapture?.(e.pointerId);
      set(true);
    };
    const onUp = (e: PointerEvent) => { e.preventDefault(); set(false); };

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    el.addEventListener('lostpointercapture', onUp);
    this.detach.push(() => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      el.removeEventListener('lostpointercapture', onUp);
    });
  }

  private bindTap(id: string, fn: () => void): void {
    const el = document.getElementById(id);
    if (!el) return;
    const onDown = (e: PointerEvent) => { e.preventDefault(); fn(); };
    el.addEventListener('pointerdown', onDown);
    this.detach.push(() => el.removeEventListener('pointerdown', onDown));
  }
}
