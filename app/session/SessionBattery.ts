import { commands, DroidResponseError, commandClaim } from "../../core/index.ts";
import type { Command, Packet } from "../../core/index.ts";
import { BatteryProfiling, batteryDeviceKey } from "./BatteryProfiling.ts";
import type { BatteryProfilingStorage } from "./BatteryProfiling.ts";

/** Observation policy only: it never arms, replaces a source, or renews a lease. */
export class SessionBattery {
  readonly model: BatteryProfiling;
  private allowed: () => boolean;
  private execute: (command: Command) => Promise<Packet>;
  private changed: () => void;
  private attempts: Record<number, number> = {};
  private unsupported = new Set<number>();
  private busy = false;
  private bindingGeneration = 0;
  private actionAt?: number;
  readError?: string;
  constructor(options: {
    storage: BatteryProfilingStorage;
    allowed: () => boolean;
    execute: (command: Command) => Promise<Packet>;
    changed: () => void;
  }) {
    this.allowed = options.allowed;
    this.execute = options.execute;
    this.changed = options.changed;
    this.model = new BatteryProfiling(options.storage, options.changed);
  }
  static adoptRuntimePolicy(service: SessionBattery, allowed: () => boolean) {
    Object.setPrototypeOf(service, SessionBattery.prototype);
    Object.setPrototypeOf(service.model, BatteryProfiling.prototype);
    service.allowed = allowed;
  }
  bind(id: string | undefined, hardwareId: string | undefined, name: string | undefined) {
    this.bindingGeneration = (this.bindingGeneration ?? 0) + 1;
    this.attempts = {};
    this.unsupported = new Set();
    this.actionAt = undefined;
    this.readError = undefined;
    this.model.bind(batteryDeviceKey(id, hardwareId), name);
  }
  quiet(now = Date.now()) {
    return (
      this.allowed() &&
      (this.actionAt === undefined || (now >= this.actionAt && now - this.actionAt >= 15000))
    );
  }
  noteCommand(command: Command) {
    if (command.did === 19 && [3, 4].includes(command.cid)) this.attempts[command.cid] = Date.now();
    if (commandClaim(command)) this.actionAt = Date.now();
  }
  recent(cid: number, now = Date.now()) {
    const at = this.attempts[cid];
    return at !== undefined && now >= at && now - at < 60000;
  }
  response(packet: Packet) {
    const at = Date.now();
    if (packet.did === 19 && [3, 4].includes(packet.cid)) this.attempts[packet.cid] = at;
    this.model.response(packet, { quiet: this.quiet(at) }, at);
  }
  notification(packet: Packet) {
    this.model.notification(packet);
  }
  resetBudget() {
    this.attempts = {};
  }
  async poll() {
    if (this.busy || !this.model.needsPolling || !this.quiet()) return;
    const binding = this.bindingGeneration ?? 0;
    const current = () => binding === (this.bindingGeneration ?? 0);
    this.busy = true;
    try {
      const requests =
        this.model.summary.mode === "waiting-full"
          ? [commands.batteryState(), commands.battery()]
          : [commands.battery(), commands.batteryState()];
      for (const command of requests) {
        if (!current() || !this.quiet() || !this.model.needsPolling) return;
        if (command.cid === 3 && this.model.summary.mode === "waiting-full") continue;
        if (this.recent(command.cid) || this.unsupported.has(command.cid)) continue;
        this.attempts[command.cid] = Date.now();
        try {
          await this.execute(command);
          if (!current()) return;
          this.readError = undefined;
        } catch (error) {
          if (!current()) return;
          if (error instanceof DroidResponseError && [1, 2, 3].includes(error.packet.error ?? 0))
            this.unsupported.add(command.cid);
          this.readError = `Battery ${command.cid === 3 ? "voltage" : "state"} read unavailable: ${String(error)}`;
          this.changed();
          if (!(error instanceof DroidResponseError)) return;
        }
      }
    } finally {
      this.busy = false;
    }
  }
}
