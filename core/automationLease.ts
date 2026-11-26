export interface SourceLeasePort {
  acquireSourceLease?(sourceId: string, drive?: boolean): Promise<void>;
  renewSourceLease?(sourceId: string): void;
  releaseSourceLease?(sourceId: string): void;
}
let nextSourceId = 0;
export function validateSourceLeasePort(port: SourceLeasePort) {
  const hooks = [port.acquireSourceLease, port.renewSourceLease, port.releaseSourceLease];
  if (hooks.some(Boolean) && !hooks.every(Boolean))
    throw new Error("Source safety lease is unavailable; reconnect before running local activity.");
}
/** A scheduler-owned renewal loop. Generic app heartbeats never touch this source. */
export class SchedulerSourceLease {
  private port: SourceLeasePort;
  private valid: () => boolean;
  private failed: (error: unknown) => void;
  private lastRenewAt = 0;
  private id: string;
  private closed = false;
  private acquired = false;
  private released = false;
  private started = false;
  private externalPulse: boolean;
  private drive: boolean;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(
    port: SourceLeasePort,
    kind: string,
    valid: () => boolean,
    failed: (error: unknown) => void,
    options: { externalPulse?: boolean; drive?: boolean } = {},
  ) {
    validateSourceLeasePort(port);
    this.port = port;
    this.valid = valid;
    this.failed = failed;
    this.id = `${kind}-${++nextSourceId}`;
    this.externalPulse = !!options.externalPulse;
    this.drive = !!options.drive;
  }
  async acquire(): Promise<boolean> {
    if (this.closed || !this.valid()) return false;
    if (this.port.acquireSourceLease) {
      await this.port.acquireSourceLease(this.id, this.drive);
      this.acquired = true;
    }
    if (this.closed || !this.valid()) {
      this.close();
      return false;
    }
    this.started = true;
    this.lastRenewAt = performance.now();
    if (this.port.acquireSourceLease && !this.externalPulse) this.schedule();
    return true;
  }
  /** External schedulers call this only after actual progress; blocked command
   * responses cannot be kept alive by an independent background renewal timer. */
  pulse(): boolean {
    if (this.closed || !this.started) return false;
    if (!this.valid()) {
      this.close();
      return false;
    }
    const elapsed = performance.now() - this.lastRenewAt;
    if (elapsed >= 250) {
      this.abandon(new Error("Source scheduler lease expired; stale renewal rejected."));
      return false;
    }
    if (this.externalPulse && elapsed < 50) return true;
    try {
      this.port.renewSourceLease?.(this.id);
      this.lastRenewAt = performance.now();
      return true;
    } catch (error) {
      this.abandon(error);
      return false;
    }
  }
  private abandon(error: unknown) {
    this.closed = true;
    clearTimeout(this.timer);
    // The native deadline remains armed so a stalled JS scheduler cannot retire
    // its expired ID before the independent radio watchdog stops the droid.
    this.released = true;
    this.failed(error);
  }
  private schedule() {
    this.timer = setTimeout(() => {
      if (this.pulse()) this.schedule();
    }, 50);
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
    if (this.acquired && !this.released) {
      this.released = true;
      try {
        this.port.releaseSourceLease!(this.id);
      } catch (error) {
        this.failed(error);
      }
    }
  }
}
