import type { Command } from '../../core/index.ts';
import { selectedLightCommand } from './lights.ts';

export const RAINBOW_DURATION_MS = 6000;
const FRAME_MS = 100;
const DOME_CHANNELS = [true, true, true, true, true, true, false, false];

/** Masked RGB updates leave the fixed-color readouts and projector untouched. */
export function rainbowCommand(elapsedMs: number): Command {
  const phase = ((Math.max(0, elapsedMs) % RAINBOW_DURATION_MS) / RAINBOW_DURATION_MS) * 6;
  const x = Math.round(255 * (1 - Math.abs((phase % 2) - 1)));
  const rgb = [[255,x,0],[x,255,0],[0,255,x],[0,x,255],[x,0,255],[255,0,x]][Math.floor(phase)];
  return selectedLightCommand([...rgb, ...rgb, 0, 0], DOME_CHANNELS);
}

type Port = {
  store: { getSnapshot(): { state: string; connectionEpoch?: number; safety: { canControl: boolean } } };
  executeManual(command: Command): Promise<unknown>;
  executeLightFrame?(command: Command, current?: () => boolean): Promise<unknown>;
  cancelLocalSources(): void;
  registerCancel(cancel: () => void): () => void;
};
type Clock = {
  now(): number;
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(timer: unknown): void;
};
const clock: Clock = {
  now: () => performance.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/** Foreground-only effect; delayed acknowledgments never create a catch-up queue. */
export class RainbowAnimation {
  private generation = 0;
  private running = false;
  private wake?: () => void;
  private port: Port;
  private changed: (active: boolean) => void;
  private clock: Clock;
  constructor(port: Port, changed: (active: boolean) => void, scheduler: Clock = clock) {
    this.port = port; this.changed = changed; this.clock = scheduler;
  }

  cancel() {
    this.generation++;
    this.wake?.();
  }

  async start() {
    if (this.running) throw Error('The previous light update is still settling.');
    const initial = this.port.store.getSnapshot();
    if (initial.state !== 'ready' || !initial.safety.canControl) throw Error('Droid is not ready.');
    const connectionEpoch = initial.connectionEpoch;
    this.port.cancelLocalSources();
    const generation = ++this.generation;
    const valid = () => {
      const current = this.port.store.getSnapshot();
      return generation === this.generation && current.state === 'ready' && current.safety.canControl && current.connectionEpoch === connectionEpoch;
    };
    const unregister = this.port.registerCancel(() => this.cancel());
    this.running = true;
    this.changed(true);
    try {
      if (!valid()) return;
      const send = (elapsed: number) => this.port.executeLightFrame
        ? this.port.executeLightFrame(rainbowCommand(elapsed), valid)
        : this.port.executeManual(rainbowCommand(elapsed));
      await send(0);
      const start = this.clock.now();
      while (valid()) {
        await new Promise<void>(resolve => {
          const timer = this.clock.setTimeout(() => { this.wake = undefined; resolve(); }, FRAME_MS);
          this.wake = () => { this.clock.clearTimeout(timer); this.wake = undefined; resolve(); };
        });
        if (!valid()) return;
        const elapsed = this.clock.now() - start;
        await send(elapsed);
      }
    } finally {
      unregister();
      this.running = false;
      this.changed(false);
    }
  }
}
