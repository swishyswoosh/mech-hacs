import { commands } from "../../core/commands.ts";
import { arcade } from "../../core/drive.ts";
import type { Command } from "../../core/index.ts";
interface DrivePort {
  arm(): void;
  allowed(): boolean;
  send(command: Command): Promise<unknown>;
  release(): Promise<void>;
  failed(error: unknown): void;
}
/** The session, not a mounted screen, owns the 100 ms loop and stale-write fence. */
export class SessionDrive {
  private port: DrivePort;
  private timer?: ReturnType<typeof setInterval>;
  private generation = 0;
  get epoch() {
    return this.generation;
  }
  private point: [number, number] = [0, 0];
  private speed = 25;
  private busy = false;
  constructor(port: DrivePort) {
    this.port = port;
  }
  setSpeed(percent: number) {
    if (!Number.isFinite(percent) || percent < 0 || percent > 100)
      throw new Error("Speed must be 0–100");
    this.speed = percent;
  }
  drive(x: number, y: number, speed: number) {
    if (![x, y].every(Number.isFinite) || Math.abs(x) > 1 || Math.abs(y) > 1)
      throw new Error("Drive demand must be normalized");
    if (!this.port.allowed())
      throw new Error("Resume a ready droid connection before driving");
    this.setSpeed(speed);
    this.point = [x, y];
    if (this.timer) return;
    this.port.arm();
    const generation = ++this.generation;
    this.timer = setInterval(() => void this.tick(generation), 100);
    void this.tick(generation);
  }
  private async tick(generation: number) {
    if (generation !== this.generation || this.busy) return;
    if (!this.port.allowed()) {
      this.revoke();
      return;
    }
    this.busy = true;
    try {
      const [left, right] = arcade(...this.point, this.speed / 100);
      await this.port.send(
        commands.tank(
          Math.round(Math.abs(left) * 255),
          Math.round(Math.abs(right) * 255),
          (left < 0 ? 8 : 0) | (right < 0 ? 16 : 0),
        ),
      );
    } catch (error) {
      if (generation === this.generation) {
        this.revoke();
        this.port.failed(error);
      }
    } finally {
      this.busy = false;
    }
  }
  revoke() {
    this.generation++;
    clearInterval(this.timer);
    this.timer = undefined;
    this.point = [0, 0];
  }
  async release() {
    const active = this.timer !== undefined;
    this.revoke();
    const generation = this.generation;
    if (active)
      try {
        await this.port.release();
      } catch (error) {
        if (generation === this.generation) this.port.failed(error);
        throw error;
      }
  }
}
