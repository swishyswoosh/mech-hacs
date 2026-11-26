import { cockpitSchema, routineTelemetryIntervalMs } from "../../core/cockpitTelemetry.ts";
import { sensorSchemaFor } from "../../core/sensorSchema.ts";
import type { Command, CommandAccess } from "../../core/index.ts";
import {
  R2Controller,
  commands,
  ResourceConflictError,
  SensorSchemaManager,
} from "../../core/index.ts";
import { SensorSession } from "../../core/sensorSession.ts";
import type { TelemetryEvent } from "../../core/telemetryEvents.ts";
import { TelemetryEventStream } from "../../core/telemetryEvents.ts";
import { SessionActivity } from "./Activity.ts";
import { SessionDrive } from "./Drive.ts";
import { ManualMotionLease } from "./ManualMotion.ts";
import { SessionStore } from "./store.ts";
import type {
  AppSnapshot,
  ConnectionOwnership,
  ExperienceHandle,
  SessionHooks,
  SessionOptions,
} from "./types.ts";
import { WheelMappingGate } from "./WheelMapping.ts";
import { SessionBattery } from "./SessionBattery.ts";
import { BATTERY_PROFILING_KEY } from "./BatteryProfiling.ts";
import { batteryResponse } from "./compatibility.ts";
export abstract class SessionState {
  abstract execute(
    command: Command,
    access?: CommandAccess,
  ): Promise<import("../../core/protocol.ts").Packet>;
  abstract armMotion(): void;
  abstract executeManual(
    command: Command,
    access?: CommandAccess,
  ): Promise<import("../../core/index.ts").Packet>;
  abstract releaseDrive(): Promise<void>;
  abstract stop(preserveConnection?: boolean): Promise<void>;
  abstract cancelLocalSources(): void;

  private maintenanceTimer?: ReturnType<typeof setInterval>;
  private maintenanceBusy = false;
  private lastConnectionReply?: {at: number; epoch: number};
  private batteryService?: SessionBattery;
  protected get sessionBattery() {
    return (this.batteryService ??= new SessionBattery({
      storage: this.options.batteryProfilingStorage ?? {
        load: () => this.options.preferences.load(BATTERY_PROFILING_KEY),
        save: (value, expected) => {
          if (this.options.preferences.load(BATTERY_PROFILING_KEY) !== expected)
            throw Error("Battery profiling data changed in another session");
          return this.options.preferences.save(BATTERY_PROFILING_KEY, value);
        },
      },
      allowed: () => this.batteryObservationAllowed(),
      execute: (command) => this.execute(command),
      changed: () => this.publish({}),
    }));
  }
  private batteryObservationAllowed() {
    return (
      !!this.controller &&
      this.controller.state === "ready" &&
      !this.controller.hasOngoingActivity &&
      this.snapshot.state === "ready" &&
      !this.focusPaused &&
      !this.stopping &&
      !this.sensorApplying &&
      this.controller.serviceState === "locked" &&
      !this.controller.serviceTransitionPending &&
      !this.manualMotion.active &&
      !this.activity.snapshot.source
    );
  }
  protected adoptBatteryProfilingPolicy() {
    SessionBattery.adoptRuntimePolicy(this.sessionBattery, () => this.batteryObservationAllowed());
  }
  protected bindBatteryProfiling() {
    this.sessionBattery.bind(this.droidId, this.droidHardwareId, this.droidName);
  }
  protected captureProfileResponse(packet: import("../../core/protocol.ts").Packet) {
    this.lastConnectionReply = {at: Date.now(), epoch: this.connectionEpoch};
    this.sessionBattery.response(packet);
    if (packet.did === 19 && packet.cid === 3 && packet.data.length === 2)
      this.publish({
        battery: batteryResponse(packet.data),
        cockpitReadings: {
          ...this.snapshot.cockpitReadings,
          "battery.volts": { value: (packet.data[0] * 256 + packet.data[1]) / 100, at: Date.now() },
        },
      });
  }
  private async profilingAction(action: () => void) {
    const saving = this.sessionBattery.model.applyRecordingAction(action);
    this.publish({});
    await saving;
    this.publish({});
  }
  selectBatteryProfilingDevice(key: string) {
    if (this.controller)
      throw Error(
        "Droid selection is available after disconnecting. The connected identity always owns collection.",
      );
    this.sessionBattery.model.selectOffline(key);
    this.publish({});
  }
  async armBatteryProfiling() {
    this.requireReady();
    await this.profilingAction(() => this.sessionBattery.model.arm());
    this.sessionBattery.resetBudget();
    await this.sessionBattery.poll();
  }
  async startBatteryProfileFull() {
    this.requireReady();
    await this.profilingAction(() => this.sessionBattery.model.startFull());
    this.sessionBattery.resetBudget();
    await this.sessionBattery.poll();
  }
  async stopBatteryProfiling() {
    await this.profilingAction(() => this.sessionBattery.model.stop());
  }
  async finishBatteryProfileShutdown() {
    await this.profilingAction(() => this.sessionBattery.model.finishShutdown());
  }
  async useBatteryProfile(id: string) {
    await this.sessionBattery.model.useProfile(id);
    this.publish({});
  }
  async useReportedBatteryState() {
    await this.sessionBattery.model.useReportedState();
    this.publish({});
  }
  async exportBatteryProfiling() {
    await this.sessionBattery.model.flush();
    return this.sessionBattery.model.export();
  }
  /** Successful command replies maintain connection liveness. An idle link uses
   * a fallback ping that cannot renew motion ownership or wake a sleeping droid. */
  ensureConnectionMaintenance() {
    if (!this.controller || !["ready", "paused"].includes(this.snapshot.state)) {
      clearInterval(this.maintenanceTimer);
      this.maintenanceTimer = undefined;
      return;
    }
    if (this.maintenanceTimer !== undefined) return;
    this.maintenanceTimer = setInterval(() => void this.maintainConnection(), 30000);
    (this.maintenanceTimer as unknown as { unref?: () => void }).unref?.();
  }
  private async maintainConnection() {
    const controller = this.controller;
    if (
      this.maintenanceBusy ||
      !controller ||
      controller.state !== "ready" ||
      !["ready", "paused"].includes(this.snapshot.state) ||
      this.stopping ||
      this.sensorApplying ||
      controller.serviceState !== "locked" ||
      controller.serviceTransitionPending ||
      this.manualMotion.active ||
      this.activity.snapshot.source
    )
      return;
    this.maintenanceBusy = true;
    const metadata = { type: "command" as const, did: 16, cid: 0, data: [] as number[] };
    const reply = this.lastConnectionReply;
    const age = reply ? Date.now() - reply.at : Infinity;
    const needsPing = reply?.epoch !== this.connectionEpoch || age < 0 || age >= 30000;
    try {
      if (needsPing) {
        this.telemetry.emit({ ...metadata, phase: "requested" });
        await controller.command(commands.ping());
        this.telemetry.emit({ ...metadata, phase: "acknowledged" });
      }
      await this.sessionBattery.poll();
    } catch (error) {
      this.telemetry.emit({ ...metadata, phase: "failed", error: String(error) });
      this.recordLifecycle("keepalive-failed", String(error));
      if (this.controller === controller && this.snapshot.state === "failed")
        await this.stop(true).catch(() => {});
    } finally {
      this.maintenanceBusy = false;
    }
  }
  private lifecycleWrites: Promise<void> = Promise.resolve();
  protected recordLifecycle(event: string, detail: string) {
    // Lifecycle entries omit the high-rate sensor stream; failed writes cannot
    // interrupt safety or transport cleanup.
    const entry = { at: new Date().toISOString(), event, detail, epoch: this.connectionEpoch };
    this.lifecycleWrites = this.lifecycleWrites
      .then(() => {
        const previous = JSON.parse(
          this.options.preferences.load("connection.lifecycle.v1") || "[]",
        );
        const entries = Array.isArray(previous) ? previous.slice(-63) : [];
        entries.push(entry);
        return this.options.preferences.save("connection.lifecycle.v1", JSON.stringify(entries));
      })
      .catch(() => {});
  }
  protected controller?: R2Controller;
  protected sensorSession = new SensorSession();
  protected sensorManager = new SensorSchemaManager(this.sensorSession);
  enableAttitudeTelemetry() {
    this.options.attitudeTelemetry = true;
  }
  protected attitudeEpoch?: number;
  protected cockpitSchemaEpoch?: number;
  protected cockpitIntervalMs = cockpitSchema.intervalMs;
  protected attitudeAttemptEpoch?: number;
  protected get attitudeSchema() {
    return sensorSchemaFor([
      { fields: ["attitude.pitch", "attitude.roll", "attitude.yaw"], intervalMs: routineTelemetryIntervalMs },
    ])!;
  }
  /** Re-enable only the exact schema installed on this transport. STOP never
   * changes firmware masks; explicit stream commands invalidate this proof. */
  resumeAttitudeTelemetry() {
    if (
      this.attitudeEpoch !== this.connectionEpoch ||
      this.snapshot.state !== "ready" ||
      this.focusPaused ||
      this.stopping ||
      this.sensorApplying ||
      this.snapshot.serviceState !== "locked"
    )
      return;
    if (this.sensorSession.snapshot.status.startsWith("streaming")) return;
    this.sensorSession.enable(
      this.cockpitSchemaEpoch === this.connectionEpoch
        ? { ...cockpitSchema, intervalMs: this.cockpitIntervalMs }
        : this.attitudeSchema,
    );
    this.publish({ sensors: this.sensorSession.snapshot });
  }
  protected sensorIntent = 0;
  protected sensorApplying = false;
  protected chooserOpen = false;

  protected focusPaused = false;
  protected focusStop?: Promise<void>;
  protected stopWork?: Promise<void>;
  protected connectionEpoch = 0;
  protected telemetry = new TelemetryEventStream();
  protected disconnectStopTimeoutMs: number;
  protected closing: Promise<void> = Promise.resolve();
  protected closingControllers = 0;
  protected ownership: ConnectionOwnership;
  protected ownershipIntent?: number;
  protected releaseOwnership(intent?: number) {
    if (intent !== undefined && intent !== this.ownershipIntent) return;
    this.ownershipIntent = undefined;
    this.ownership.release();
  }
  constructor(options: SessionOptions) {
    this.options = options;
    this.hooks = options.hooks ?? {};
    this.disconnectStopTimeoutMs = options.disconnectStopTimeoutMs ?? 500;
    this.ownership = this.hooks.ownership ?? {
      acquire: async () => {},
      release() {},
    };
    this.snapshot = {
      connectionEpoch: 0,
      state: "disconnected",
      detail: options.initialDetail ?? "Choose a droid to begin.",
      packets: [],
      batteryProfiling: this.sessionBattery.model.summary,
    };
    this.importLocalJson = this.hooks.importLocalJson;
    this.importLocalJsonFiles = this.hooks.importLocalJsonFiles;
    this.exportLocalJson = this.hooks.exportLocalJson;
    this.hashLocalText = this.hooks.hashLocalText;
    this.store = new SessionStore(this.snapshot);
    this.activity = new SessionActivity(() => this.publish({}));
    this.driveLoop = new SessionDrive({
      arm: () => this.armMotion(),
      allowed: () => this.snapshot.state === "ready" && !this.focusPaused && !this.stopping && !this.controller?.driveStopUnconfirmed,
      send: (command) => this.executeManual(command),
      release: () => this.releaseDrive(),
      failed: (error) => {
        this.cancelLocalSources();
        this.publish({ detail: String(error) });
        if (!(error instanceof ResourceConflictError)) void this.stop().catch(() => {});
      },
    });
  }
  readonly importLocalJson?: SessionHooks["importLocalJson"];
  readonly importLocalJsonFiles?: SessionHooks["importLocalJsonFiles"];
  readonly exportLocalJson?: SessionHooks["exportLocalJson"];
  readonly hashLocalText?: SessionHooks["hashLocalText"];
  protected experiences = new Map<string, ExperienceHandle>();
  protected options: SessionOptions;
  protected hooks: SessionHooks;
  readonly store: SessionStore;
  readonly activity: SessionActivity;
  readonly manualMotion = new ManualMotionLease();
  protected wheelGate = new WheelMappingGate();
  protected driveLoop: SessionDrive;
  protected stopping = false;
  protected droidName?: string;
  protected droidId?: string;
  protected droidHardwareId?: string;
  protected lastServices: string[] = [];
  protected lastAuthorizedId?: string;
  protected snapshot: AppSnapshot;
  protected listeners = new Set<(snapshot: AppSnapshot) => void>();
  protected publish(change: Partial<AppSnapshot>) {
    if (change.state === "disconnected") change = { ...change, unsupportedStopModes: [], stopFailure: undefined };
    if (change.state === "failed") {
      this.sensorIntent++;
      this.sensorManager.cancel("stale · connection failed");
      change = { ...change, sensors: this.sensorSession.snapshot };
    }
    const previous = this.snapshot;
    if (change.state !== undefined && change.state !== previous.state)
      this.sessionBattery.model.connection(change.state);
    this.snapshot = {
      ...this.snapshot,
      ...change,
      batteryProfiling: {
        ...this.sessionBattery.model.summary,
        observationError: this.sessionBattery.readError,
        observationStatus:
          this.sessionBattery.model.needsPolling && !this.sessionBattery.quiet()
            ? "Waiting for a quiet, ready controller. Ongoing or unknown firmware activity must be stopped and its release confirmed, for example by changing controller screens."
            : undefined,
      },
      batteryStateReading: this.sessionBattery.model.reportedState,
      batteryEstimate:
        (change.state ?? this.snapshot.state) === "ready"
          ? this.sessionBattery.model.estimate()
          : undefined,
      sensorPlan: this.sensorManager.plan,
      sensorPlanPending: this.sensorManager.pending,
    };
    if (previous.state !== this.snapshot.state) {
      this.recordLifecycle(this.snapshot.state, this.snapshot.detail ?? "");
      this.telemetry.emit({
        type: "connection",
        state: this.snapshot.state,
        detail: this.snapshot.detail,
      });
    }
    this.ensureConnectionMaintenance();
    const sensors = this.snapshot.sensors;
    if (
      sensors &&
      (previous.sensors?.status !== sensors.status ||
        previous.sensors?.invalid !== sensors.invalid ||
        previous.sensors?.schemaEpoch !== sensors.schemaEpoch)
    )
      this.telemetry.emit({
        type: "stream-status",
        status: sensors.status,
        invalid: sensors.invalid,
        intervalMs: sensors.intervalMs,
        schemaEpoch: sensors.schemaEpoch,
      });
    this.wheelGate.observe(this.snapshot);
    if (previous.state === "ready" && this.snapshot.state !== "ready" && !this.stopping)
      this.cancelLocalSources();
    this.store.update(this.snapshot, {
      droidName: this.droidName,
      droidId: this.droidId,
      motionArmed: this.controller?.motionArmed ?? false,
      stopping: this.stopping,
      wheelsValidated: this.wheelGate.allowed,
      activity: this.activity.snapshot,
    });
    for (const listener of this.listeners) listener(this.snapshot);
  }
  subscribe(listener: (snapshot: AppSnapshot) => void) {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => {
      this.listeners.delete(listener);
    };
  }
  subscribeEvents(listener: (event: TelemetryEvent) => void) {
    return this.telemetry.subscribe(listener);
  }
  loadPreference(key: string) {
    return this.options.preferences.load(key);
  }
  savePreference(key: string, value: string) {
    return this.options.preferences.save(key, value);
  }
  protected checkIntent(intent: number) {
    if (intent !== this.sensorIntent)
      throw new Error("Sensor setup canceled by connection or STOP.");
  }

  protected requireReady() {
    if (this.snapshot.state !== "ready" || this.focusPaused || this.stopping)
      throw new Error("Droid is not ready");
    this.hooks.assertReady?.();
  }
  nativePulseEnded() {
    this.controller?.nativeDrivePulseEnded();
    this.publish({});
  }
  fail(reason: string) {
    this.sensorIntent++;
    this.sensorManager.cancel();
    this.cancelLocalSources();
    this.publish({ state: "failed", detail: reason });
  }
}
