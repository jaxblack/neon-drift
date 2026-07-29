import { clamp } from './MathUtil';

/** 一次采样得到的输入快照（物理层只认这个结构，方便未来做网络回放/AI 复用） */
export interface InputState {
  /** 0..1 */
  throttle: number;
  /** 0..1 */
  brake: number;
  /** -1(左) .. 1(右) */
  steer: number;
  /** 漂移键是否按住 */
  drift: boolean;
  /** 本帧漂移键刚按下（边缘） */
  driftPressed: boolean;
  /** 本帧漂移键刚松开（边缘） */
  driftReleased: boolean;
  /** 本帧氮气键刚按下 */
  nitroPressed: boolean;
  /** 本帧道具键刚按下 */
  itemPressed: boolean;
  /** 复位键按住 */
  respawn: boolean;
}

export function emptyInput(): InputState {
  return {
    throttle: 0, brake: 0, steer: 0,
    drift: false, driftPressed: false, driftReleased: false,
    nitroPressed: false, itemPressed: false, respawn: false,
  };
}

/** 消费掉边缘事件（多 substep 时只在第一步生效） */
export function consumeEdges(s: InputState): void {
  s.driftPressed = false;
  s.driftReleased = false;
  s.nitroPressed = false;
  s.itemPressed = false;
}

export type Action = 'up' | 'down' | 'left' | 'right' | 'drift' | 'nitro' | 'item' | 'respawn' | 'camera' | 'pause';

const KEYMAP: Record<string, Action> = {
  KeyW: 'up', ArrowUp: 'up',
  KeyS: 'down', ArrowDown: 'down',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
  ShiftLeft: 'drift', ShiftRight: 'drift', Space: 'drift',
  ControlLeft: 'nitro', ControlRight: 'nitro', KeyJ: 'nitro',
  KeyE: 'item', KeyK: 'item',
  KeyR: 'respawn',
  KeyC: 'camera',
  Escape: 'pause',
};

export class Input {
  private held = new Set<Action>();
  private pressed = new Set<Action>();
  private released = new Set<Action>();
  /** 模拟轴（手柄/触屏），会与键盘取绝对值较大者 */
  private analogSteer = 0;
  private analogThrottle = 0;
  private analogBrake = 0;

  /** 一次性事件回调（菜单/暂停/切视角这类不进物理的） */
  onCamera?: () => void;
  onPause?: () => void;

  private steerSmooth = 0;
  private gamepadIndex: number | null = null;
  private detached: Array<() => void> = [];

  constructor(private target: HTMLElement | Window = window) {
    const el = this.target as HTMLElement;

    const onKeyDown = (e: KeyboardEvent) => {
      const a = KEYMAP[e.code];
      if (!a) return;
      // 避免空格滚动页面 / Ctrl 触发浏览器快捷键冲突
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
      if (e.repeat) return;
      this.held.add(a);
      this.pressed.add(a);
      if (a === 'camera') this.onCamera?.();
      if (a === 'pause') this.onPause?.();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const a = KEYMAP[e.code];
      if (!a) return;
      this.held.delete(a);
      this.released.add(a);
    };
    const onBlur = () => { this.held.clear(); };

    // 触屏会补发一套鼠标事件，短时间内忽略掉，免得点虚拟按键顺手放了氮气
    let lastTouchAt = -1e9;
    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType === 'touch' || e.pointerType === 'pen') lastTouchAt = performance.now();
    };
    const onMouseDown = (e: MouseEvent) => {
      if (performance.now() - lastTouchAt < 800) return;
      if (e.button === 0) { this.held.add('nitro'); this.pressed.add('nitro'); }
      if (e.button === 2) { this.held.add('item'); this.pressed.add('item'); }
    };
    const onMouseUp = (e: MouseEvent) => {
      if (e.button === 0) this.held.delete('nitro');
      if (e.button === 2) this.held.delete('item');
    };
    const onContext = (e: Event) => e.preventDefault();

    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    el.addEventListener('mousedown', onMouseDown as EventListener);
    window.addEventListener('mouseup', onMouseUp);
    el.addEventListener('contextmenu', onContext);

    this.detached.push(() => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      el.removeEventListener('mousedown', onMouseDown as EventListener);
      window.removeEventListener('mouseup', onMouseUp);
      el.removeEventListener('contextmenu', onContext);
    });

    window.addEventListener('gamepadconnected', (e) => { this.gamepadIndex = (e as GamepadEvent).gamepad.index; });
    window.addEventListener('gamepaddisconnected', () => { this.gamepadIndex = null; });
  }

  /** 触屏 / 外部虚拟摇杆注入 */
  setAnalog(steer: number, throttle: number, brake: number): void {
    this.analogSteer = clamp(steer, -1, 1);
    this.analogThrottle = clamp(throttle, 0, 1);
    this.analogBrake = clamp(brake, 0, 1);
  }
  setVirtual(action: Action, down: boolean): void {
    if (down) { this.held.add(action); this.pressed.add(action); }
    else { this.held.delete(action); this.released.add(action); }
  }

  private pollGamepad(): void {
    if (this.gamepadIndex === null || !navigator.getGamepads) return;
    const gp = navigator.getGamepads()[this.gamepadIndex];
    if (!gp) return;
    const dz = (v: number) => (Math.abs(v) < 0.14 ? 0 : v);
    this.analogSteer = dz(gp.axes[0] ?? 0);
    this.analogThrottle = Math.max(gp.buttons[7]?.value ?? 0, gp.buttons[0]?.pressed ? 1 : 0);
    this.analogBrake = Math.max(gp.buttons[6]?.value ?? 0, gp.buttons[1]?.pressed ? 1 : 0);
    const sync = (a: Action, down: boolean) => {
      const was = this.held.has(a);
      if (down && !was) { this.held.add(a); this.pressed.add(a); }
      else if (!down && was) { this.held.delete(a); this.released.add(a); }
    };
    sync('drift', !!(gp.buttons[5]?.pressed || gp.buttons[2]?.pressed));
    sync('nitro', !!(gp.buttons[4]?.pressed || gp.buttons[3]?.pressed));
    sync('item', !!(gp.buttons[1]?.pressed));
  }

  /** 每渲染帧调用一次；返回快照并清空边缘事件 */
  sample(dt: number): InputState {
    this.pollGamepad();

    const kbSteer = (this.held.has('right') ? 1 : 0) - (this.held.has('left') ? 1 : 0);
    const targetSteer = Math.abs(this.analogSteer) > Math.abs(kbSteer) ? this.analogSteer : kbSteer;

    // 键盘转向做一次平滑，避免数字输入的突兀感
    const rate = targetSteer === 0 ? 16 : 11;
    this.steerSmooth += (targetSteer - this.steerSmooth) * (1 - Math.exp(-rate * Math.max(dt, 1 / 240)));
    if (Math.abs(this.steerSmooth) < 0.002) this.steerSmooth = 0;

    const s: InputState = {
      throttle: Math.max(this.held.has('up') ? 1 : 0, this.analogThrottle),
      brake: Math.max(this.held.has('down') ? 1 : 0, this.analogBrake),
      steer: clamp(this.steerSmooth, -1, 1),
      drift: this.held.has('drift'),
      driftPressed: this.pressed.has('drift'),
      driftReleased: this.released.has('drift'),
      nitroPressed: this.pressed.has('nitro'),
      itemPressed: this.pressed.has('item'),
      respawn: this.held.has('respawn'),
    };

    this.pressed.clear();
    this.released.clear();
    return s;
  }

  reset(): void {
    this.held.clear();
    this.pressed.clear();
    this.released.clear();
    this.steerSmooth = 0;
    this.analogSteer = this.analogThrottle = this.analogBrake = 0;
  }

  dispose(): void {
    this.detached.forEach((fn) => fn());
    this.detached = [];
  }
}
