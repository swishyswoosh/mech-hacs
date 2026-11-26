import { angleAt } from "./controlModels.ts";
export function domePointerAngle(x: number, y: number, width: number, height: number) {
  const dx = x - width / 2,
    dy = y - height / 2;
  if (
    ![dx, dy, width, height].every(Number.isFinite) ||
    width <= 0 ||
    height <= 0 ||
    Math.hypot(dx, dy) < Math.min(width, height) * 0.15
  )
    return;
  return angleAt(dx, dy);
}
/** Coalesces explicit pointer updates to the newest target, avoiding queued intermediate angles. */
export class DomeTargets {
  private pending?: number;
  private running = false;
  private generation = 0;
  private send: (angle: number) => Promise<void>;
  private allowed: () => boolean;
  private failed: (error: unknown) => void;
  constructor(
    send: (angle: number) => Promise<void>,
    allowed: () => boolean,
    failed: (error: unknown) => void,
  ) {
    this.send = send;
    this.allowed = allowed;
    this.failed = failed;
  }
  set(angle: number) {
    if (!this.allowed() || !Number.isFinite(angle)) return;
    this.pending = Math.max(-160, Math.min(180, Math.round(angle)));
    if (!this.running) void this.drain();
  }
  cancel() {
    this.pending = undefined;
    this.generation++;
  }
  private async drain() {
    this.running = true;
    const generation = this.generation;
    try {
      while (generation === this.generation && this.allowed() && this.pending !== undefined) {
        const angle = this.pending;
        this.pending = undefined;
        await this.send(angle);
      }
    } catch (error) {
      if (generation === this.generation) {
        this.pending = undefined;
        this.failed(error);
      }
    } finally {
      this.running = false;
      if (this.pending !== undefined && this.allowed()) void this.drain();
    }
  }
}
