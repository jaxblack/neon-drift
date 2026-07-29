import { FIXED_DT, MAX_SUBSTEPS } from './Config';

/**
 * 固定步长循环：物理跑 120Hz，渲染跟显示器刷新率。
 * 这样物理表现与帧率解耦 —— 60Hz / 144Hz / 240Hz 屏幕上手感完全一致，
 * 也是未来做服务器权威 + 客户端预测的前提。
 */
export class GameLoop {
  private raf = 0;
  private last = 0;
  private acc = 0;
  private running = false;

  /** 供渲染层做插值的 [0,1) 系数 */
  alpha = 0;
  /** 上一帧真实耗时（秒），用于统计 */
  frameTime = 0;
  fps = 60;
  private fpsAcc = 0;
  private fpsFrames = 0;

  constructor(
    private step: (dt: number, first: boolean) => void,
    private render: (alpha: number, frameDt: number) => void,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.acc = 0;
    this.raf = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  private tick = (now: number): void => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.tick);

    // 上限 0.25s：切标签页回来时不要一次补几百步
    let frameDt = (now - this.last) / 1000;
    this.last = now;
    if (frameDt > 0.25) frameDt = 0.25;
    this.frameTime = frameDt;

    this.fpsAcc += frameDt;
    this.fpsFrames++;
    if (this.fpsAcc >= 0.5) {
      this.fps = this.fpsFrames / this.fpsAcc;
      this.fpsAcc = 0;
      this.fpsFrames = 0;
    }

    this.acc += frameDt;
    let steps = 0;
    while (this.acc >= FIXED_DT && steps < MAX_SUBSTEPS) {
      this.step(FIXED_DT, steps === 0);
      this.acc -= FIXED_DT;
      steps++;
    }
    // 防止低端机上累加器爆炸导致"越跑越慢"
    if (steps === MAX_SUBSTEPS && this.acc > FIXED_DT * 4) this.acc = 0;

    this.alpha = this.acc / FIXED_DT;
    this.render(this.alpha, frameDt);
  };
}
