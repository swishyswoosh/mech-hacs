import {
  cockpitSchema,
  cockpitQueries,
  cockpitQueryIntervals,
  setCockpitStreamInterval,
  decodeCockpitReading,
  expandCockpitStream,
} from "../../core/cockpitTelemetry.ts";
import { installPlannedSensorSchema } from "../../core/sensorSchema.ts";
import type {
  Command,
  CommandAccess,
  SensorConsumerRequest,
  ServiceRead,
  ServiceReading,
  ServiceState,
} from "../../core/index.ts";
import { commands, DroidResponseError } from "../../core/index.ts";
import { batteryResponse } from "./compatibility.ts";
import { SensorSession } from "../../core/sensorSession.ts";
import { SessionConnection } from "./SessionConnection.ts";
import type {AppSnapshot} from "./types.ts";
export abstract class SessionOperations extends SessionConnection {
  private cockpitObservers = 0;
  private cockpitTimer?: ReturnType<typeof setInterval>;
  private cockpitBusy = false;
  private cockpitQuery = 0;
  private cockpitQueryDue: number[] = [];
  private telemetryRates = new Map<string, number>();
  private failedTelemetryRate?: string;
  private telemetryRateUncertain = false;
  private startTelemetryTimer() {
    const needsRateReset = this.cockpitSchemaEpoch === this.connectionEpoch &&
      (this.cockpitIntervalMs !== 1000 || this.telemetryRateUncertain) &&
      this.failedTelemetryRate !== `${this.connectionEpoch}:1000`;
    if (this.snapshot.state !== "ready" || this.focusPaused ||
        !(this.cockpitObservers || this.telemetryRates?.size || needsRateReset)) {
      clearInterval(this.cockpitTimer);
      this.cockpitTimer = undefined;
      return;
    }
    if (!this.cockpitTimer) {
      this.cockpitTimer = setInterval(() => void this.refreshCockpitTelemetry(), 1000);
      (this.cockpitTimer as unknown as { unref?: () => void }).unref?.();
    }
  }
  protected override publish(change: Partial<AppSnapshot>) {
    super.publish(change);
    this.startTelemetryTimer();
  }
  private cockpitQueryEpoch?: number;
  private cockpitAttemptEpoch?: number;
  private cockpitAttemptMask?: number;
  private cockpitUnsupported = new Set<number>();
  /** Migrate the retained instance after a development hot update; never replace its transport. */
  ensureTelemetryPolicy() {
    this.telemetryRates ??= new Map();
    this.cockpitQueryDue ??= [];
    this.cockpitIntervalMs ??= this.sensorSession.snapshot.intervalMs;
    Object.setPrototypeOf(this.sensorSession, SensorSession.prototype);
    if (this.cockpitTimer) {
      clearInterval(this.cockpitTimer);
      this.cockpitTimer = undefined;
      this.startTelemetryTimer();
    }
  }
  observeCockpitTelemetry() {
    this.cockpitObservers = (this.cockpitObservers ?? 0) + 1;
    this.startTelemetryTimer();
    void this.refreshCockpitTelemetry();
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.cockpitObservers--;
        this.startTelemetryTimer();
      }
    };
  }
  async ensureCockpitTelemetry() {
    if (
      this.cockpitSchemaEpoch === this.connectionEpoch &&
      this.sensorSession.snapshot.fieldNames?.join() === cockpitSchema.fieldNames.join()
    )
      return true;
    const controller = this.controller,
      intent = this.sensorIntent;
    if (
      !controller ||
      this.snapshot.state !== "ready" ||
      this.focusPaused ||
      this.stopping ||
      this.sensorApplying ||
      controller.motionArmed ||
      this.activity.snapshot.source
    )
      return false;
    let changed = false;
    this.sensorApplying = true;
    this.publish({ cockpitTelemetryBusy: true, cockpitTelemetryStatus: "Reading sensors" });
    const check = () => {
      this.checkIntent(intent);
      if (
        this.controller !== controller ||
        this.focusPaused ||
        this.stopping ||
        this.snapshot.state !== "ready"
      )
        throw Error("Sensor setup cancelled");
    };
    try {
      await expandCockpitStream(
        async (c) => {
          check();
          const p = await controller.command(c);
          check();
          return p;
        },
        () => {
          changed = true;
          this.attitudeEpoch = undefined;
          this.sensorSession.reset("stale · expanding cockpit telemetry");
        },
      );
      check();
      this.cockpitSchemaEpoch = this.connectionEpoch;
      this.attitudeEpoch = this.connectionEpoch;
      this.cockpitIntervalMs = cockpitSchema.intervalMs;
      this.sensorSession.enable(cockpitSchema);
      this.publish({ sensors: this.sensorSession.snapshot, cockpitTelemetryStatus: undefined });
      return true;
    } catch (error) {
      // Preserve heading telemetry if this firmware rejects optional channels.
      // Old 10-float packets cannot decode as the restored 3-float schema.
      if (changed) {
        check();
        await installPlannedSensorSchema(async (c) => {
          check();
          const p = await controller.command(c);
          check();
          return p;
        }, this.attitudeSchema);
        this.cockpitSchemaEpoch = undefined;
        this.attitudeEpoch = this.connectionEpoch;
        this.sensorSession.enable(this.attitudeSchema);
        this.publish({ sensors: this.sensorSession.snapshot });
      }
      throw error;
    } finally {
      this.sensorApplying = false;
      this.publish({ cockpitTelemetryBusy: false });
    }
  }
  private async refreshCockpitTelemetry() {
    if (
      this.cockpitBusy ||
      this.snapshot.state !== "ready" ||
      this.focusPaused ||
      this.stopping ||
      this.sensorApplying ||
      this.manualMotion.active ||
      this.activity.snapshot.source ||
      this.controller?.serviceState !== "locked"
    )
      return;
    this.cockpitBusy = true;
    const epoch = this.connectionEpoch;
    if (this.cockpitQueryEpoch !== epoch) {
      this.cockpitQueryEpoch = epoch;
      this.cockpitUnsupported = new Set();
      this.cockpitQuery = 0;
      this.cockpitQueryDue = [];
    }
    try {
      if (
        (this.cockpitObservers || this.telemetryRates.size) &&
        (this.cockpitAttemptEpoch !== epoch ||
          this.cockpitAttemptMask !== cockpitSchema.standardMask)
      ) {
        this.cockpitUnsupported ??= new Set();
        try {
          if (await this.ensureCockpitTelemetry()) {
            this.cockpitAttemptEpoch = epoch;
            this.cockpitAttemptMask = cockpitSchema.standardMask;
          }
        } catch (error) {
          if (epoch === this.connectionEpoch && !this.focusPaused && !this.stopping) {
            this.cockpitAttemptEpoch = epoch;
            this.cockpitAttemptMask = cockpitSchema.standardMask;
            this.publish({ cockpitTelemetryStatus: String(error) });
          }
        }
      }
      await this.refreshTelemetryRate();
      if (
        this.snapshot.state !== "ready" ||
        this.focusPaused ||
        this.stopping ||
        !this.cockpitObservers
      )
        return;
      const now = Date.now();
      const index = Array.from(
        { length: cockpitQueries.length },
        (_, i) => (i + this.cockpitQuery) % cockpitQueries.length,
      ).find(
        (i) =>
          !this.cockpitUnsupported.has(i) &&
          now >= (this.cockpitQueryDue[i] ?? 0) &&
          !(
            this.sessionBattery.model.needsPolling &&
            cockpitQueries[i] === commands.battery &&
            this.sessionBattery.recent(3, now)
          ),
      );
      if (index === undefined) return;
      this.cockpitQuery = (index + 1) % cockpitQueries.length;
      this.cockpitQueryDue[index] = now + cockpitQueryIntervals[index];
      try {
        const packet = (await this.execute(
          cockpitQueries[index](),
        )) as import("../../core/protocol.ts").Packet;
        if (epoch !== this.connectionEpoch || this.snapshot.state !== "ready") return;
        const values = decodeCockpitReading(packet),
          at = Date.now();
        this.publish({
          cockpitReadings: {
            ...this.snapshot.cockpitReadings,
            ...Object.fromEntries(
              Object.entries(values).map(([key, value]) => [key, { value, at }]),
            ),
          },
        });
      } catch (error) {
        if (
          epoch === this.connectionEpoch &&
          !this.focusPaused &&
          !this.stopping &&
          this.snapshot.state === "ready"
        ) {
          if (error instanceof DroidResponseError && [1, 2, 3].includes(error.packet.error ?? 0))
            this.cockpitUnsupported.add(index);
          this.recordLifecycle("sensor-readback-unavailable", String(error));
        }
      }
    } finally {
      this.cockpitBusy = false;
      this.startTelemetryTimer();
    }
  }
  private async refreshTelemetryRate() {
    if (this.cockpitSchemaEpoch !== this.connectionEpoch) return;
    const interval = Math.min(1000, ...this.telemetryRates.values());
    const key = `${this.connectionEpoch}:${interval}`;
    if (this.cockpitIntervalMs === interval && !this.telemetryRateUncertain) {
      this.failedTelemetryRate = undefined;
      return;
    }
    if (this.failedTelemetryRate === key || this.controller?.motionArmed) return;
    const controller = this.controller,
      intent = this.sensorIntent;
    if (!controller) return;
    this.sensorApplying = true;
    const check = () => {
      this.checkIntent(intent);
      if (
        this.controller !== controller ||
        this.focusPaused ||
        this.stopping ||
        this.snapshot.state !== "ready"
      )
        throw Error("Sensor rate change cancelled");
    };
    try {
      this.telemetryRateUncertain = true;
      await setCockpitStreamInterval(async (c) => {
        check();
        const p = await controller.command(c);
        check();
        return p;
      }, interval);
      check();
      this.telemetryRateUncertain = false;
      this.cockpitIntervalMs = interval;
      this.sensorSession.setIntervalMs(interval);
      this.failedTelemetryRate = undefined;
      this.publish({ sensors: this.sensorSession.snapshot, cockpitTelemetryStatus: undefined });
    } catch (error) {
      if (
        this.controller === controller &&
        !this.focusPaused &&
        !this.stopping &&
        intent === this.sensorIntent
      ) {
        this.failedTelemetryRate = key;
        this.publish({ cockpitTelemetryStatus: `Sensor rate unchanged: ${String(error)}` });
      }
    } finally {
      this.sensorApplying = false;
    }
  }
  async ensureAttitudeTelemetry() {
    this.resumeAttitudeTelemetry();
    if (
      !this.options.attitudeTelemetry ||
      this.attitudeEpoch === this.connectionEpoch ||
      this.attitudeAttemptEpoch === this.connectionEpoch ||
      this.sensorSession.snapshot.schemaEpoch !== 0 ||
      this.sensorManager.plan ||
      this.sensorApplying ||
      !this.controller ||
      !this.store.getSnapshot().safety.canControl ||
      this.controller.motionArmed
    )
      return;
    // Bootstrap only an empty decoder and a verified disabled firmware stream.
    // Reconfiguring an established consumer schema still uses the strict manager.
    this.attitudeAttemptEpoch = this.connectionEpoch;
    const controller = this.controller,
      intent = this.sensorIntent;
    const check = () => {
      this.checkIntent(intent);
      if (
        this.controller !== controller ||
        this.focusPaused ||
        this.stopping ||
        this.snapshot.state !== "ready"
      )
        throw Error("Attitude setup canceled");
    };
    const execute = async (command: Command) => {
      check();
      const packet = await controller.command(command);
      check();
      return packet;
    };
    try {
      const standard = await execute(commands.getStreaming()),
        extended = await execute(commands.getExtendedStreaming());
      if (standard.data.length !== 7 || extended.data.length !== 4) return;
      const view = new DataView(standard.data.buffer, standard.data.byteOffset, 7);
      if (
        view.getUint16(0) !== 0 ||
        view.getUint8(2) !== 0 ||
        view.getUint32(3) !== 0 ||
        new DataView(extended.data.buffer, extended.data.byteOffset, 4).getUint32(0) !== 0
      )
        return;
      await installPlannedSensorSchema(execute, this.attitudeSchema);
      check();
      this.attitudeEpoch = this.connectionEpoch;
      this.sensorSession.enable(this.attitudeSchema);
      this.publish({ sensors: this.sensorSession.snapshot });
    } catch (error) {
      if (this.controller === controller && intent === this.sensorIntent) {
        this.sensorSession.reset(`Attitude readings unavailable: ${String(error)}`);
        this.publish({ sensors: this.sensorSession.snapshot });
      }
    }
  }
  async execute(command: Command, access: CommandAccess = {}) {
    const controller = this.controller;
    const generation = this.activity.generation;
    if (this.snapshot.state === "sleep-requested") throw new Error("Sleep sequence is in progress");
    if (this.stopping) throw new Error("STOP is still in progress");
    if (this.snapshot.state === "failed")
      throw new Error("Droid session failed; establish a ready connection first");
    this.hooks.assertReady?.();
    if (this.focusPaused || this.snapshot.state === "paused")
      throw new Error("Control paused while Chrome is unfocused.");
    if (command.did === 0x18 && [0, 12].includes(command.cid)) {
      this.cockpitSchemaEpoch = undefined;
      this.attitudeEpoch = undefined;
      this.attitudeAttemptEpoch = this.connectionEpoch;
      this.sensorManager.cancel("stale · external stream configuration");
    }
    if (!controller) throw new Error("Choose a droid first.");
    const metadata = {
      type: "command" as const,
      did: command.did,
      cid: command.cid,
      data: Array.from(command.data),
    };
    this.telemetry.emit({ ...metadata, phase: "requested" });
    try {
      const check = () => {
        if (
          controller !== this.controller ||
          generation !== this.activity.generation ||
          this.stopping ||
          this.focusPaused ||
          this.snapshot.state === "failed"
        )
          throw new Error("Command canceled by session transition");
      };
      await this.hooks.beforeExecute?.(command, access);
      check();
      // Platform hooks may await native cleanup; revocation also fences their send callback.
      const send = () => {
        check();
        this.sessionBattery.noteCommand(command);
        return controller.command(command, access);
      };
      const packet = this.hooks.execute ? await this.hooks.execute(command, send) : await send();
      check();
      this.publish({});
      this.telemetry.emit({ ...metadata, phase: "acknowledged" });
      if (command.did === 0x13 && command.cid === 3)
        this.publish({ battery: batteryResponse(packet.data) });
      return packet;
    } catch (error) {
      this.telemetry.emit({
        ...metadata,
        phase: "failed",
        error: String(error),
      });
      this.publish({});
      throw error;
    }
  }
  async setSensorConsumer(
    id: "visible" | "recording" | "automation",
    request: SensorConsumerRequest | null,
  ) {
    if (request) this.sensorManager.request(id, request);
    else this.sensorManager.release(id);
    if (request?.fields.length)
      this.telemetryRates.set(id, Math.max(25, Math.min(65535, Math.ceil(request.intervalMs))));
    else this.telemetryRates.delete(id);
    this.startTelemetryTimer();
    this.publish({});
  }
  async startSensors() {
    this.cockpitSchemaEpoch = undefined;
    this.attitudeEpoch = undefined;
    this.attitudeAttemptEpoch = this.connectionEpoch;
    if (this.sensorApplying) throw new Error("Sensor schema installation already in progress");
    if (!this.controller || this.snapshot.state !== "ready") throw new Error("Droid is not ready.");
    this.sensorApplying = true;
    const intent = ++this.sensorIntent,
      previous = this.controller;
    const services = this.lastServices.length
      ? this.lastServices
      : (
          this.loadPreference("services") ||
          "00010001-574f-4f20-5370-6865726f2121,00020001-574f-4f20-5370-6865726f2121"
        )
          .split(/[\s,]+/)
          .filter(Boolean);
    try {
      await this.sensorManager.reconcile({
        check: () => this.checkIntent(intent),
        stopStream: async () => {
          await previous.emergencyStop();
          this.checkIntent(intent);
          await previous.command(commands.streaming(0, 0, 0));
          this.checkIntent(intent);
        },
        reconnectStopped: async () => {
          await this.openConnection(services, intent, this.lastAuthorizedId);
          this.attitudeEpoch = undefined;
          this.checkIntent(intent);
          if (!this.controller || this.snapshot.state !== "ready")
            throw new Error("Reconnect did not reach ready.");
          return this.connectionEpoch;
        },
        execute: async (command) => {
          if (!this.controller) throw new Error("Droid disconnected during sensor setup.");
          return this.controller.command(command);
        },
        onFailure: async () => {
          if (intent === this.sensorIntent) await this.disconnect();
        },
      });
    } finally {
      this.sensorApplying = false;
      this.publish({ sensors: this.sensorSession.snapshot });
    }
  }
  async stopSensors() {
    this.cockpitSchemaEpoch = undefined;
    this.attitudeEpoch = undefined;
    this.sensorIntent++;
    this.sensorManager.cancel("stopped · retained values stale");
    this.publish({ sensors: this.sensorSession.snapshot });
    if (!this.controller) throw new Error("Choose a droid first.");
    await this.controller.command(commands.streaming(0, 0, 0));
  }
  isServiceBusy() {
    return this.controller?.serviceTransitionPending ?? false;
  }
  getServiceState(): ServiceState {
    return this.controller?.serviceState ?? "locked";
  }
  protected serviceController() {
    if (!this.controller || this.snapshot.state !== "ready" || this.controller.state !== "ready")
      throw new Error("Ready connection required for service session");
    return this.controller;
  }
  async beginServiceSession() {
    this.cockpitSchemaEpoch = undefined;
    this.attitudeEpoch = undefined;
    this.sensorIntent++;
    this.sensorManager.cancel("stale · service session");
    try {
      const work = this.serviceController().beginServiceSession();
      this.publish({ serviceBusy: this.isServiceBusy() });
      return await work;
    } finally {
      this.publish({
        serviceBusy: this.isServiceBusy(),
        serviceState: this.getServiceState(),
      });
    }
  }
  async enterServiceSession() {
    try {
      const work = this.serviceController().enterServiceSession();
      this.publish({ serviceBusy: this.isServiceBusy() });
      await work;
    } finally {
      this.publish({
        serviceBusy: this.isServiceBusy(),
        serviceState: this.getServiceState(),
      });
    }
  }
  async readService(kind: ServiceRead, index = 0): Promise<ServiceReading> {
    return this.serviceController().readService(kind, index);
  }
  async endServiceSession() {
    try {
      const work = this.serviceController().endServiceSession();
      this.publish({ serviceBusy: this.isServiceBusy() });
      await work;
      this.cockpitAttemptEpoch = undefined;
    } finally {
      this.publish({
        serviceBusy: this.isServiceBusy(),
        serviceState: this.getServiceState(),
      });
    }
  }
  async replaceSources() {
    const current = this.controller;
    const generation = this.activity.generation;
    if (this.focusPaused || this.stopping || this.snapshot.state === "failed")
      throw new Error("Droid is not ready for source replacement");
    this.hooks.assertReady?.();
    this.driveLoop.revoke();
    await this.hooks.beforeReplace?.();
    if (
      this.controller !== current ||
      generation !== this.activity.generation ||
      this.focusPaused ||
      this.stopping ||
      this.snapshot.state === "failed"
    )
      throw new Error("Source replacement canceled");
    const controller = this.controller;
    if (!controller) throw new Error("Choose a droid first.");
    try {
      await controller.replaceSources();
    } finally {
      if (this.controller === controller)
        this.publish({ unsupportedStopModes: controller.unsupportedStopModes });
    }
  }
  async releaseDrive() {
    this.driveLoop.revoke();
    if (!this.controller) throw new Error("Choose a droid first.");
    const controller = this.controller;
    const send = () => controller.releaseDrive();
    try {
      if (this.hooks.releaseDrive) await this.hooks.releaseDrive(send);
      else await send();
    } catch (error) {
      // Retain controller identity for the priority STOP fallback after wheel
      // release fails; unrelated controls do not inherit a wheel-drive fault.
      if (this.controller === controller && (controller.state === "failed" || controller.driveStopUnconfirmed))
        await this.stop().catch(() => {});
      throw error;
    } finally {
      this.publish({});
    }
  }
  stop(preserveConnection = false): Promise<void> {
    if (this.stopWork) return this.stopWork;
    const work = this.performStop(preserveConnection);
    this.stopWork = work;
    const clear = () => {
      if (this.stopWork === work) this.stopWork = undefined;
    };
    void work.then(clear, clear);
    return work;
  }
  private async performStop(preserveConnection: boolean) {
    this.cancelLocalSources();
    this.options.factory.cancel?.();
    this.hooks.cancelSources?.();
    this.sensorIntent++;
    this.sensorManager.cancel("stale · stopped");
    this.publish({ sensors: this.sensorSession.snapshot });
    if (!this.controller) {
      if (!this.closingControllers) this.releaseOwnership();
      throw new Error("No ready connection. STOP delivery cannot be confirmed; check the droid.");
    }
    if (!["ready", "failed", "paused"].includes(this.snapshot.state))
      throw new Error("No ready connection. STOP delivery cannot be confirmed; check the droid.");
    const controller = this.controller;
    this.stopping = true;
    this.publish({});
    try {
      const work = controller.emergencyStop();
      this.publish({
        serviceBusy: this.isServiceBusy(),
        serviceState: this.getServiceState(),
      });
      await work;
      if (controller.driveStopUnconfirmed) await controller.replaceSources();
      if (this.controller === controller) this.publish({stopFailure: undefined});
    } catch (error) {
      if (this.controller === controller)
        this.publish({
          state: controller.state === "ready" && !this.focusPaused ? "ready" : "failed",
          stopFailure: `STOP failed: ${String(error)}`,
          detail: `STOP failed: ${String(error)}`,
        });
      throw error;
    } finally {
      if (this.controller === controller) {
        this.stopping = false;
        this.publish({
          serviceBusy: this.isServiceBusy(),
          serviceState: this.getServiceState(),
        });
        if (this.hooks.disconnectOnStop && !preserveConnection) await this.disconnect();
      }
    }
  }
}
