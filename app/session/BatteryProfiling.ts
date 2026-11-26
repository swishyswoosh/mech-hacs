import {
  buildBatteryProfile,
  estimateBatteryPercent,
  validBatteryProfile,
} from "../../core/batteryProfile.ts";
import type {
  BatteryCycle,
  BatteryProfile,
  BatteryProfileResult,
  BatterySample,
} from "../../core/batteryProfile.ts";
import type { Packet } from "../../core/protocol.ts";
import { LOCAL_JSON_MAX_BYTES, localTextBytes } from "../../core/localJson.ts";
export const BATTERY_PROFILING_KEY = "battery.profiling.v1";
export interface BatteryProfilingStorage {
  load(): string | null;
  save(value: string, expected: string | null): void | Promise<void>;
}
type Device = {
  name: string;
  armed: boolean;
  recording?: string;
  runs: BatteryCycle[];
  activeProfile?: BatteryProfile;
};
type Document = { version: 1; devices: Record<string, Device> };
export type BatteryProfilingSummary = {
  deviceKey?: string;
  deviceName?: string;
  devices: Array<{ key: string; name: string }>;
  mode: "idle" | "waiting-full" | "recording";
  runs: BatteryCycle[];
  current?: BatteryCycle;
  sampleCount: number;
  pending: boolean;
  storageError?: string;
  observationError?: string;
  observationStatus?: string;
  validation: BatteryProfileResult;
  activeProfile?: BatteryProfile;
  canExport: boolean;
};
export type BatteryEstimate = { percent: number; at: number; volts: number; profileId: string };
const validTime = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export function batteryDeviceKey(id?: string, hardwareId?: string) {
  if (hardwareId?.trim() && hardwareId !== "desktop:last") return `hardware:${hardwareId}`;
  if (id?.trim() && id !== "desktop:last") return `id:${id}`;
  return undefined;
}
function validSample(s: any): s is BatterySample {
  return (
    !!s &&
    validTime(s.at) &&
    Number.isFinite(s.volts) &&
    s.volts > 0 &&
    s.volts <= 655.35 &&
    typeof s.quiet === "boolean" &&
    (s.state === undefined || (Number.isInteger(s.state) && s.state >= 0 && s.state <= 255))
  );
}
function parse(raw: string): Document {
  const doc = JSON.parse(raw);
  if (
    doc?.version !== 1 ||
    !doc.devices ||
    Array.isArray(doc.devices) ||
    typeof doc.devices !== "object" ||
    Object.keys(doc.devices).length > 50
  )
    throw Error("Unrecognized battery profiling data");
  let count = 0;
  for (const [key, d] of Object.entries(doc.devices) as Array<[string, any]>) {
    if (
      !/^(id|hardware):.+/.test(key) ||
      !d ||
      typeof d.name !== "string" ||
      typeof d.armed !== "boolean" ||
      !Array.isArray(d.runs) ||
      d.runs.length > 100
    )
      throw Error("Damaged battery profiling device");
    const ids = new Set<string>();
    for (const c of d.runs) {
      if (
        !c ||
        typeof c.id !== "string" ||
        ids.has(c.id) ||
        c.deviceKey !== key ||
        !validTime(c.startedAt) ||
        !["reported", "confirmed"].includes(c.full) ||
        !Array.isArray(c.samples) ||
        !c.samples.every(validSample) ||
        (c.endedAt !== undefined && (!validTime(c.endedAt) || c.endedAt < c.startedAt)) ||
        (c.endpoint !== undefined && !["critical", "shutdown"].includes(c.endpoint)) ||
        (c.problem !== undefined && typeof c.problem !== "string") ||
        (c.dischargeObserved !== undefined && typeof c.dischargeObserved !== "boolean")
      )
        throw Error("Damaged battery discharge cycle");
      ids.add(c.id);
      count += c.samples.length;
    }
    if (
      d.recording !== undefined &&
      (!ids.has(d.recording) ||
        d.runs.find((c: BatteryCycle) => c.id === d.recording).endedAt !== undefined)
    )
      throw Error("Invalid active discharge cycle");
    if (
      d.activeProfile !== undefined &&
      (!validBatteryProfile(d.activeProfile) ||
        d.activeProfile.deviceKey !== key ||
        !d.activeProfile.trainingCycleIds.every((id: string) => ids.has(id)) ||
        !ids.has(d.activeProfile.validationCycleId))
    )
      throw Error("Invalid saved battery profile");
  }
  if (count > 6000) throw Error("Battery profiling data exceeds 6,000 readings");
  return doc;
}

/** Shared session-owned state. Depot is only a view; unmounting it never stops collection. */
export class BatteryProfiling {
  private storage: BatteryProfilingStorage;
  private changed: () => void;
  private saved: Document = { version: 1, devices: {} };
  private draft: Document = this.saved;
  private raw: string | null = null;
  private unreadable = false;
  private work?: Promise<void>;
  private error?: string;
  private key?: string;
  private bindingGeneration = 0;
  private name = "R2-D2";
  private latest?: BatterySample;
  private lastState?: { value: number; at: number };
  summary!: BatteryProfilingSummary;
  constructor(storage: BatteryProfilingStorage, changed: () => void = () => {}) {
    this.storage = storage;
    this.changed = changed;
    try {
      this.raw = storage.load();
      if (this.raw !== null) this.saved = parse(this.raw);
      this.draft = this.saved;
      const keys = Object.keys(this.saved.devices);
      if (keys.length === 1) {
        this.key = keys[0];
        this.name = this.saved.devices[this.key].name;
      }
    } catch (error) {
      this.unreadable = true;
      this.error = `Battery profiling storage: ${String(error)}. Original data retained; resolve storage and reopen.`;
    }
    this.update();
  }
  private update() {
    const d = this.key ? this.draft.devices[this.key] : undefined;
    this.summary = {
      deviceKey: this.key,
      deviceName: this.key ? this.name : undefined,
      devices: Object.entries(this.draft.devices).map(([key, d]) => ({ key, name: d.name })),
      mode: d?.recording ? "recording" : d?.armed ? "waiting-full" : "idle",
      runs: d?.runs ?? [],
      current: d?.runs.find((r) => r.id === d.recording),
      sampleCount: d?.runs.reduce((sum, r) => sum + r.samples.length, 0) ?? 0,
      pending: this.draft !== this.saved,
      storageError: this.error,
      validation: buildBatteryProfile(this.key ?? "", d?.runs ?? []),
      activeProfile: this.key ? this.saved.devices[this.key]?.activeProfile : undefined,
      canExport: this.raw !== null,
    };
  }
  private fail(error: unknown) {
    this.error = `Battery profiling storage: ${String(error)}. Acknowledged data retained; resolve storage and reopen.`;
    this.draft = this.saved;
    this.update();
  }
  private refresh() {
    if (this.work || this.error) return;
    try {
      const raw = this.storage.load();
      if (raw !== this.raw) {
        this.saved = raw === null ? { version: 1, devices: {} } : parse(raw);
        this.draft = this.saved;
        this.raw = raw;
        this.update();
      }
    } catch (error) {
      this.fail(error);
    }
  }
  bind(key: string | undefined, name = "R2-D2") {
    this.bindingGeneration = (this.bindingGeneration ?? 0) + 1;
    this.refresh();
    this.key = key && /^(id|hardware):.+/.test(key) ? key : undefined;
    this.name = name.slice(0, 120);
    this.latest = undefined;
    this.lastState = undefined;
    this.update();
  }
  selectOffline(key: string) {
    const device = this.draft.devices[key];
    if (!device) throw Error("Unknown battery profiling droid");
    this.bind(key, device.name);
  }
  private check() {
    if (this.error) throw Error(this.error);
    if (!this.key) throw Error("Connect a droid with a stable identity before profiling.");
  }
  private edit(change: (device: Device) => void) {
    this.refresh();
    this.check();
    const key = this.key!,
      next = clone(this.draft);
    const d = (next.devices[key] ??= { name: this.name, armed: false, runs: [] });
    d.name = this.name;
    change(d);
    const text = JSON.stringify(next),
      count = Object.values(next.devices).reduce(
        (sum, x) => sum + x.runs.reduce((n, r) => n + r.samples.length, 0),
        0,
      );
    if (
      localTextBytes(text) > 1_500_000 ||
      count > 6000 ||
      d.runs.length > 100 ||
      Object.keys(next.devices).length > 50
    ) {
      this.fail("History is full; export it before arranging further collection.");
      return;
    }
    this.draft = next;
    this.update();
    this.write();
  }
  private write() {
    if (this.work || this.draft === this.saved || this.error) return;
    const next = this.draft,
      text = JSON.stringify(next),
      expected = this.raw;
    const committed = () => {
      this.saved = next;
      this.raw = text;
      this.update();
    };
    try {
      const result = this.storage.save(text, expected);
      if (result && typeof result.then === "function") {
        this.work = Promise.resolve(result).then(
          () => {
            this.work = undefined;
            committed();
            this.write();
            this.changed();
          },
          (error) => {
            this.work = undefined;
            this.fail(error);
            this.changed();
          },
        );
        this.changed();
      } else committed();
    } catch (error) {
      this.fail(error);
    }
  }
  async flush() {
    while (this.work) await this.work;
  }
  private start(full: "reported" | "confirmed", at: number) {
    if (!validTime(at)) throw Error("Invalid full-charge time");
    this.edit((d) => {
      if (d.recording) throw Error("Stop the current cycle before starting another.");
      const id = `${at}-${Math.random().toString(36).slice(2)}`;
      d.runs.push({ id, deviceKey: this.key!, startedAt: at, full, samples: [] });
      d.recording = id;
      d.armed = false;
    });
  }
  arm() {
    this.edit((d) => {
      if (d.recording) throw Error("A cycle is already recording.");
      d.armed = true;
    });
  }
  startFull(at = Date.now()) {
    this.start("confirmed", at);
  }
  stop(at = Date.now()) {
    this.edit((d) => {
      const run = d.runs.find((r) => r.id === d.recording);
      if (run) {
        run.endedAt = Math.max(at, run.startedAt);
        run.problem = "Stopped before a confirmed low-battery endpoint";
      }
      d.recording = undefined;
      d.armed = false;
    });
  }
  private finish(endpoint: "critical" | "shutdown", at: number) {
    this.edit((d) => {
      const run = d.runs.find((r) => r.id === d.recording);
      if (!run) throw Error("No discharge cycle is recording.");
      run.endedAt = Math.max(at, run.startedAt);
      run.endpoint = endpoint;
      d.recording = undefined;
      d.armed = false;
    });
  }
  finishShutdown(at = Date.now()) {
    this.finish("shutdown", at);
  }
  connection(state: string) {
    if (["disconnected", "sleeping", "failed"].includes(state)) {
      this.latest = undefined;
      this.lastState = undefined;
    }
  }
  private state(value: number, at: number) {
    this.lastState = { value, at };
    if (this.error || !this.key) return;
    const d = this.draft.devices[this.key];
    const run = d?.runs.find((r) => r.id === d.recording);
    if (
      value === 0 &&
      run &&
      (run.dischargeObserved ||
        run.samples.some((s) => s.state !== undefined && s.state >= 2 && s.state <= 5))
    ) {
      this.edit((device) => {
        const current = device.runs.find((r) => r.id === device.recording)!;
        current.problem = "Returned to Full after discharge; recharge may have been missed";
        current.endedAt = Math.max(at, current.startedAt);
        device.recording = undefined;
      });
    }
    if (value >= 2 && value <= 5 && run && !run.dischargeObserved)
      this.edit((device) => {
        device.runs.find((r) => r.id === device.recording)!.dischargeObserved = true;
      });
    if (value === 0 && d?.armed && !d.recording) this.start("reported", at);
    if (value === 1 && d?.recording)
      this.edit((device) => {
        const run = device.runs.find((r) => r.id === device.recording)!;
        run.problem = "Charging observed during discharge";
        run.endedAt = Math.max(at, run.startedAt);
        device.recording = undefined;
      });
    if (
      value === 5 &&
      this.draft.devices[this.key]?.recording &&
      this.latest?.quiet &&
      at >= this.latest.at &&
      at - this.latest.at <= 120000
    )
      this.finish("critical", at);
  }
  response(packet: Packet, context: { quiet: boolean }, at = Date.now()) {
    if (!(packet.flags & 1) || packet.error || packet.did !== 19 || !validTime(at)) return;
    try {
      if (packet.cid === 4 && packet.data.length === 1) this.state(packet.data[0], at);
      if (packet.cid === 3 && packet.data.length === 2) {
        const volts = (packet.data[0] * 256 + packet.data[1]) / 100;
        if (volts <= 0) return;
        const state =
          this.lastState && at >= this.lastState.at && at - this.lastState.at <= 120000
            ? this.lastState.value
            : undefined;
        const sample: BatterySample = {
          at,
          volts,
          quiet: context.quiet,
          ...(state !== undefined ? { state } : {}),
        };
        this.latest = sample;
        const current = this.key ? this.draft.devices[this.key]?.recording : undefined;
        if (current && !this.error)
          this.edit((d) => {
            const run = d.runs.find((r) => r.id === current)!;
            const last = run.samples.at(-1);
            if (!last || at - last.at >= 5000) run.samples.push(sample);
          });
        if (current && !this.error && state === 5 && context.quiet) this.finish("critical", at);
      }
    } catch (error) {
      this.fail(error);
    }
    this.update();
  }
  notification(packet: Packet, at = Date.now()) {
    if (
      !(packet.flags & 1) &&
      packet.did === 19 &&
      packet.cid === 6 &&
      packet.data.length === 1 &&
      validTime(at)
    ) {
      try {
        this.state(packet.data[0], at);
      } catch (error) {
        this.fail(error);
      }
      this.update();
    }
  }
  get reportedState() {
    return this.lastState;
  }
  get needsPolling() {
    const d = this.key ? this.draft.devices[this.key] : undefined;
    return !this.error && !!(d?.armed || d?.recording || this.summary.activeProfile);
  }
  estimate(now = Date.now()): BatteryEstimate | undefined {
    const p = this.key ? this.saved.devices[this.key]?.activeProfile : undefined,
      s = this.latest;
    if (!p || !s || !s.quiet || now < s.at || now - s.at > 120000) return undefined;
    if (
      this.lastState &&
      now >= this.lastState.at &&
      now - this.lastState.at <= 120000 &&
      [0, 1].includes(this.lastState.value)
    )
      return undefined;
    const percent = estimateBatteryPercent(p, s.volts);
    return percent === undefined
      ? undefined
      : { percent, at: s.at, volts: s.volts, profileId: p.id };
  }
  private requireBinding(generation: number) {
    if (generation !== (this.bindingGeneration ?? 0))
      throw Error("Battery profiling droid changed; review the selected droid before retrying.");
  }
  async applyRecordingAction(change: () => void) {
    const binding = this.bindingGeneration ?? 0;
    change();
    await this.flush();
    this.requireBinding(binding);
    if (this.error) throw Error(this.error);
  }
  async useProfile(expectedId: string) {
    const binding = this.bindingGeneration ?? 0;
    await this.flush();
    this.requireBinding(binding);
    this.refresh();
    this.check();
    const candidate = this.summary.validation.profile;
    if (!candidate || candidate.id !== expectedId)
      throw Error("The candidate changed or is not validated. Review it again before using it.");
    this.edit((d) => {
      d.activeProfile = clone(candidate);
    });
    await this.flush();
    this.requireBinding(binding);
    if (this.error) throw Error(this.error);
  }
  async useReportedState() {
    const binding = this.bindingGeneration ?? 0;
    await this.flush();
    this.requireBinding(binding);
    this.edit((d) => {
      d.activeProfile = undefined;
    });
    await this.flush();
    this.requireBinding(binding);
    if (this.error) throw Error(this.error);
  }
  export() {
    if (this.work) throw Error("Wait for pending saves before exporting.");
    const text = this.unreadable
      ? JSON.stringify({ version: 1, recovery: true, original: this.raw })
      : JSON.stringify({
          ...this.saved,
          exportedAt: Date.now(),
          notes:
            "Per-droid calibration of usable runtime under similar use; not measured charge. Only explicit Use this profile activates a validated curve. Incomplete cycles and gaps are retained.",
        });
    const bytes = localTextBytes(text);
    if (bytes > LOCAL_JSON_MAX_BYTES) throw Error("Profiling export exceeds the 2 MB file limit.");
    return { name: `r2-battery-profiling-${Date.now()}.json`, text, bytes };
  }
}
