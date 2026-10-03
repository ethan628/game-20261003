/**
 * GameLoop.ts - 固定時間步長遊戲迴圈 (Fixed Timestep Accumulator Loop)
 * 保證在不同更新率螢幕與不同負載下，物理模擬與移動邏輯精確一致
 */

import { CONFIG } from '../config.ts';

export class GameLoop {
  private updateFn: (fixedDelta: number) => void;
  private renderFn: (alpha: number) => void;
  private onFpsUpdate?: (fps: number) => void;

  private isRunning = false;
  private reqId: number | null = null;
  private lastTime = 0;
  private accumulator = 0;

  // FPS 計數
  private frameCount = 0;
  private fpsTimer = 0;
  private currentFps = 60;

  constructor(
    updateFn: (fixedDelta: number) => void,
    renderFn: (alpha: number) => void,
    onFpsUpdate?: (fps: number) => void
  ) {
    this.updateFn = updateFn;
    this.renderFn = renderFn;
    this.onFpsUpdate = onFpsUpdate;
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.lastTime = performance.now();
    this.accumulator = 0;
    this.frameCount = 0;
    this.fpsTimer = performance.now();
    this.tick(this.lastTime);
  }

  public stop(): void {
    this.isRunning = false;
    if (this.reqId !== null) {
      cancelAnimationFrame(this.reqId);
      this.reqId = null;
    }
  }

  private tick = (timestamp: number): void => {
    if (!this.isRunning) return;

    let deltaSeconds = (timestamp - this.lastTime) / 1000.0;
    this.lastTime = timestamp;

    // 防止切換分頁後恢復時產生巨幅 delta (限制最大 0.2 秒)
    if (deltaSeconds > 0.2) {
      deltaSeconds = 0.2;
    }

    this.accumulator += deltaSeconds;

    // 固定步長物理與邏輯更新
    const fixedDelta = CONFIG.PHYSICS.FIXED_DELTA;
    let subSteps = 0;
    while (this.accumulator >= fixedDelta && subSteps < CONFIG.PHYSICS.MAX_SUB_STEPS) {
      this.updateFn(fixedDelta);
      this.accumulator -= fixedDelta;
      subSteps++;
    }

    // 計算插值係數並渲染畫面
    const alpha = this.accumulator / fixedDelta;
    this.renderFn(alpha);

    // 計算 FPS
    this.frameCount++;
    if (timestamp - this.fpsTimer >= 500) {
      this.currentFps = Math.round((this.frameCount * 1000) / (timestamp - this.fpsTimer));
      this.onFpsUpdate?.(this.currentFps);
      this.frameCount = 0;
      this.fpsTimer = timestamp;
    }

    this.reqId = requestAnimationFrame(this.tick);
  };

  public getFps(): number {
    return this.currentFps;
  }
}
