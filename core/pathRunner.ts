import { previewPath, parsePathDraft, serializePathDraft } from './automation.ts';
import type { PathDraft, AutomationPort } from './automation.ts';
import { commands } from './commands.ts';
import { decodeSensorReading } from './service.ts';
import type { Packet, Command } from './protocol.ts';
import { SchedulerSourceLease } from './automationLease.ts';
export type DroidPathState = {
  status: 'idle' | 'preparing' | 'running' | 'paused' | 'completed' | 'cancelled' | 'failed';
  progress: number;
  segment: number;
  error?: string;
};
export function planDroidPath(input: PathDraft) {
  const draft = parsePathDraft(serializePathDraft(input));
  if (draft.speedPercent <= 0) throw Error('Choose a positive path speed.');
  const geometry = previewPath(draft.points, draft.speedPercent, draft.startOrientation);
  if (!geometry.length) throw Error('Draw at least two distinct waypoints.');
  let endMs = 0;
  const segments = geometry.map((segment, index) => {
    const startMs = endMs;
    endMs += segment.length / draft.speedPercent * 1000;
    const previous = index ? geometry[index - 1].heading : segment.heading;
    const turn = Math.abs((segment.heading - previous + 540) % 360 - 180);
    // Bends use 37.5% of straight-line speed within the user's cap;
    // drawing units have no verified physical distance scale.
    return {
      ...segment,
      speed: Math.max(1, Math.round(segment.speed * (turn > 15 ? 0.375 : 1))),
      startMs,
      endMs
    };
  });
  if (endMs > 60000) throw Error('A droid route must finish within 60 seconds. Shorten the route or increase its speed.');
  return {
    draft,
    segments,
    durationMs: endMs
  };
}
type Clock = {
  now: () => number;
  wait: (ms: number) => Promise<void>;
  isReady: () => boolean;
};
/** Foreground drive stream, using the droid's heading controller. Encoders are
 * checked only for progress; their undocumented scale is never called metres. */
export class DroidPathRunner {
  private generation = 0;
  private active = false;
  private elapsed = 0;
  private plan?: ReturnType<typeof planDroidPath>;
  private stopPending?: Promise<void>;
  private port: AutomationPort;
  private changed: (state: DroidPathState) => void;
  private clock: Clock;
  snapshot: DroidPathState = {
    status: 'idle',
    progress: 0,
    segment: 0
  };
  constructor(port: AutomationPort, changed: (state: DroidPathState) => void = () => {}, clock?: Partial<Clock>) {
    this.port = port;
    this.changed = changed;
    this.clock = {
      now: () => performance.now(),
      wait: ms => new Promise(r => setTimeout(r, ms)),
      isReady: () => true,
      ...clock
    };
  }
  private publish(next: Partial<DroidPathState>) {
    this.snapshot = {
      ...this.snapshot,
      ...next
    };
    this.changed(this.snapshot);
  }
  async cancel(sendStop = true, pause = false) {
    if (!this.active) {
      if (this.snapshot.status === 'paused' && !pause) {
        ++this.generation;
        // Source revocation invalidates a queued Resume immediately. Pause's
        // own STOP callback retains the route until a fresh explicit action.
        if (sendStop) this.publish({status: 'cancelled'});
      }
      return;
    }
    this.active = false;
    ++this.generation;
    this.publish({
      status: pause ? 'paused' : 'cancelled'
    });
    if (sendStop) {
      const work = this.port.stop();
      this.stopPending = work;
      try {
        await work;
      } catch (error) {
        this.publish({
          status: 'failed',
          error: String(error)
        });
        throw error;
      } finally {
        if (this.stopPending === work) this.stopPending = undefined;
      }
    }
  }
  async resume() {
    if (this.snapshot.status !== 'paused' || !this.plan) throw Error('No paused route.');
    await this.run(true);
  }
  async start(input: PathDraft, beforeStart?: () => Promise<void>) {
    if (this.active || this.stopPending) throw Error('The previous route is still stopping.');
    const plan = planDroidPath(input);
    if (beforeStart) await beforeStart();
    if (this.active || this.stopPending) throw Error('A route is already active.');
    this.plan = plan;
    this.elapsed = 0;
    await this.run(false);
  }
  private async run(resuming: boolean) {
    const requestedGeneration = this.generation;
    if (this.stopPending) await this.stopPending;
    // Stop or another resume can supersede this request while its STOP is pending.
    if (this.generation !== requestedGeneration) return;
    if (!this.clock.isReady()) throw Error('Droid controls are not ready.');
    const plan = this.plan!;
    const generation = ++this.generation;
    this.active = true;
    const valid = () => this.active && this.generation === generation && this.clock.isReady();
    this.publish({
      status: 'preparing',
      error: undefined,
      progress: this.elapsed / plan.durationMs
    });
    let leaseError: unknown;
    const lease = new SchedulerSourceLease(this.port, 'drawn-path', valid, error => {
      leaseError = error;
      void this.port.stop().catch(() => {});
    }, {
      externalPulse: true,
      drive: true
    });
    const unsubscribe = this.port.subscribeEvents?.(event => {
      if (event.type === 'connection' && event.state !== 'ready') void this.cancel(false);
    });
    const check = () => {
      if (!valid()) throw Error('Path cancelled');
      if (leaseError) throw leaseError;
    };
    let lastResponseAt = this.clock.now();
    const send = async (command: Command) => {
      check();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const response = await Promise.race([this.port.execute(command), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Error('Droid response deadline missed')), 250);
        })]);
        check();
        if (!lease.pulse()) throw leaseError ?? Error('Path scheduler deadline missed');
        lastResponseAt = this.clock.now();
        return response as Packet;
      } finally {
        clearTimeout(timer);
      }
    };
    const readEncoders = async () => {
      const reading = decodeSensorReading('encoders', await send(commands.encoderCounts()));
      if (reading.kind !== 'encoders') throw Error('Encoder progress unavailable');
      return [reading.counter0, reading.counter1];
    };
    try {
      if (!this.port.replaceSources) throw Error('Source handoff unavailable');
      await this.port.replaceSources();
      check();
      if (!(await lease.acquire())) return;
      this.port.armMotion();
      const stance = await send(commands.getLegAction());
      if (stance.data.length !== 1) throw Error('Cannot verify three-leg drive stance.');
      if (stance.data[0] !== 1) {
        await send(commands.legAction(1));
        const until = this.clock.now() + 5000;
        let settled = false;
        while (valid() && this.clock.now() < until) {
          await this.clock.wait(100);
          if (!lease.pulse()) throw Error('Stance preparation deadline missed');
          const status = await send(commands.getLegAction());
          if (status.data.length === 1 && status.data[0] === 1) {
            settled = true;
            break;
          }
        }
        if (!settled) throw Error('Three-leg stance did not complete.');
      }
      if (!resuming) await send(commands.resetYaw());
      let encoders = await readEncoders();
      let lastProgress = this.clock.now(),
        lastRead = lastProgress;
      const started = this.clock.now() - this.elapsed;
      this.publish({
        status: 'running'
      });
      while (valid()) {
        const now = this.clock.now();
        if (now - lastResponseAt > 250) throw Error('Path scheduler deadline missed');
        this.elapsed = Math.min(plan.durationMs, now - started);
        if (this.elapsed >= plan.durationMs) break;
        const index = plan.segments.findIndex(s => s.endMs > this.elapsed);
        const segment = plan.segments[index];
        this.publish({
          progress: this.elapsed / plan.durationMs,
          segment: index
        });
        await send(commands.drive(segment.speed, segment.heading));
        if (now - lastRead >= 200) {
          const next = await readEncoders();
          const delta = next.reduce((sum, v, i) => sum + Math.abs((v - encoders[i] + 98304) % 65536 - 32768), 0);
          if (delta > 0) lastProgress = this.clock.now();
          encoders = next;
          lastRead = this.clock.now();
          if (lastRead - lastProgress >= 1000) throw Error('Wheel progress stalled; path stopped.');
        }
        // BLE replies consume the tick budget. Waiting only its remainder avoids
        // falsely tripping the 250 ms guard after successful command progress.
        await this.clock.wait(Math.max(0, Math.min(100 - (this.clock.now() - now), plan.durationMs - (this.clock.now() - started))));
        if (valid() && !lease.pulse()) throw leaseError ?? Error('Path scheduler deadline missed');
      }
      if (valid()) {
        this.active = false;
        const work = this.port.stop();
        this.stopPending = work;
        try {
          await work;
        } finally {
          if (this.stopPending === work) this.stopPending = undefined;
        }
        if (this.generation === generation) this.publish({
          status: 'completed',
          progress: 1
        });
      }
    } catch (error) {
      if (this.generation === generation) {
        this.active = false;
        this.publish({
          status: 'failed',
          error: String(error)
        });
        await this.port.stop().catch(stopError => this.publish({
          error: `${String(error)}; STOP failed: ${String(stopError)}`
        }));
      }
    } finally {
      lease.close();
      unsubscribe?.();
    }
  }
}
