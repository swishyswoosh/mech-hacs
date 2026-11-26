import { installPlannedSensorSchema } from "../../core/sensorSchema.ts";
import type { BleTransport, Packet } from "../../core/index.ts";
import { decodeNotification, R2Controller } from "../../core/index.ts";
import { captureTelemetryPacket } from "../../core/telemetryEvents.ts";
import { compatibilityProbes } from "./compatibility.ts";
import { SessionState } from "./SessionState.ts";
import type { CompatibilityReport, TransportConnection } from "./types.ts";
export abstract class SessionConnection extends SessionState {
  /** Rebind the retained controller only after the existing focus STOP barrier.
   * No initialization, subscription, disconnect, queue reset or state clearing. */
  async adoptControllerRuntimePolicy(): Promise<boolean> {
    const controller = this.controller;
    if (!controller) return false;
    try { await this.focusStop; await this.stopWork; } catch { return false; }
    if (this.controller !== controller || this.stopping || controller.motionArmed ||
        controller.state !== "ready" || !["ready", "paused"].includes(this.snapshot.state)) return false;
    this.adoptBatteryProfilingPolicy();
    this.bindBatteryProfiling();
    R2Controller.adoptRuntimePolicy(controller, packet => this.captureControllerPacket(controller, packet),packet=>{if(this.controller===controller)this.captureProfileResponse(packet);});
    this.publish({});
    return true;
  }
  protected captureControllerPacket(controller: R2Controller, packet: Packet) {
    if (this.controller !== controller) return;
    this.sessionBattery.notification(packet);
    if (packet.did === 19 && [25, 26].includes(packet.cid)) this.recordLifecycle(packet.cid === 25 ? "droid-will-sleep" : "droid-did-sleep", `Firmware notification ${packet.did}/${packet.cid}`);
    this.hooks.packet?.(packet);
    const { wireLog } = captureTelemetryPacket(this.telemetry, this.sensorSession, packet);
    this.publish({ sensors: this.sensorSession.snapshot, packets: [wireLog, ...this.snapshot.packets].slice(0, 100) });
  }
  async connect(services: string[]) {
    this.lastAuthorizedId = undefined;
    const intent = ++this.sensorIntent;
    await this.openConnection(services, intent);
  }
  async authorizedDroids() {
    return this.options.factory.authorizedDroids?.() ?? [];
  }
  async reconnectDroid(id: string, services: string[]) {
    this.lastAuthorizedId = id;
    const intent = ++this.sensorIntent;
    await this.openConnection(services, intent, id);
  }
  protected async openConnection(
    services: string[],
    intent: number,
    authorizedId?: string,
  ) {
    this.checkIntent(intent);
    await this.closeConnection(intent);
    this.checkIntent(intent);
    const permitted =
      this.options.factory.validateServices?.(services) ?? services;
    this.lastServices = permitted;
    this.publish({
      state: "scanning",
      battery: undefined,
      detail: authorizedId
        ? "Reconnecting to the selected authorized droid."
        : "Choose the intended R2-D2 in Chrome’s Bluetooth chooser.",
    });
    let controller: R2Controller | undefined;
    let restartDisconnect = false;
    let requestedSleepFinished = false;
    let disconnectedDuring: string | undefined;
    let phase = "Bluetooth selection";
    try {
      await this.ownership.acquire();
      if (intent !== this.sensorIntent) {
        this.ownership.release();
        this.checkIntent(intent);
      }
      this.ownershipIntent = intent;
      this.chooserOpen = authorizedId === undefined;
      let transport: BleTransport;
      let connection: TransportConnection;
      try {
        const onDisconnect = () => {
          if (!controller || this.controller !== controller) return;
          this.recordLifecycle("transport-lost",`Transport callback during ${phase}`);
          restartDisconnect = controller.state === "awaiting-restart";
          disconnectedDuring = phase;
          if (!(restartDisconnect && this.options.factory.restart))
            this.sensorIntent++;
          this.connectionEpoch++;
          if (!(restartDisconnect && this.options.factory.restart))
            this.releaseOwnership(intent);
          controller.disconnected();
          this.sensorManager.cancel();
          this.publish({
            connectionEpoch: this.connectionEpoch,
            sensors: this.sensorSession.snapshot,
            state: "disconnected",
            battery: undefined,
            detail: requestedSleepFinished
              ? ""
              : restartDisconnect
              ? "Droid restarted. Choose the droid again to complete initialization."
              : `Bluetooth disconnected during ${phase}. Droid state unconfirmed; no activity resumes.`,
          });
        };
        connection = await this.options.factory.open({
          services: permitted,
          authorizedId,
          onDisconnect,
          check: () => this.checkIntent(intent),
          selection: (open) => {
            this.chooserOpen = open;
          },
        });
        transport = connection.transport;
        this.droidName = connection.name;
        this.droidId = connection.id;
        this.droidHardwareId=connection.hardwareId;
        this.bindBatteryProfiling();
      } finally {
        this.chooserOpen = false;
      }
      if (intent !== this.sensorIntent) {
        await transport.disconnect();
        this.checkIntent(intent);
      }
      controller = new R2Controller(transport, {
        onState: (state) => {
          if (this.controller !== controller) return;
          this.hooks.state?.(state);
          if (state !== "ready") {
            this.sensorSession.reset(
              state === "sleeping"
                ? "stale · droid sleeping"
                : "stale · connection unavailable",
            );
          }
          if (state === "sleeping") {
            this.sensorIntent++;
            this.sensorManager.cancel("stale · droid sleeping");
          }
          this.publish({
            serviceBusy: controller?.serviceTransitionPending ?? false,
            serviceState: controller?.serviceState ?? "locked",
            sensors: this.sensorSession.snapshot,
            ...(state !== "ready" ? { battery: undefined } : {}),
            state: state === "ready" ? "checking-compatibility" : state,
            detail:
              state === "ready"
                ? "Wake response matched. Checking compatibility."
                : state === "awaiting-restart"
                  ? "Application-start requested. Disconnect and choose droid again after restart."
                  : `Connection: ${state}`,
          });
        },
        onError: (error) => {
          if (this.controller !== controller) return;
          this.recordLifecycle("controller-error", error.message);
          if (this.snapshot.state === "failed")
            this.publish({detail: `Connection failed: ${error.message}`});
        },
        onPacket: (packet) => {
          if (!controller || this.controller !== controller) return;
          if (
            this.snapshot.state === "sleep-requested" &&
            decodeNotification(packet)?.type === "did-sleep"
          ) requestedSleepFinished = true;
          this.captureControllerPacket(controller, packet);
        },
        onResponse:(packet)=>{if(this.controller===controller)this.captureProfileResponse(packet);},
      });
      this.controller = controller;
      this.hooks.attach?.(controller);
      this.publish({
        connectionEpoch: ++this.connectionEpoch,
        unsupportedStopModes: [],
      });
      phase = "Bluetooth initialization";
      let initialized = await controller.initialize();
      if (initialized === "awaiting-restart" && this.options.factory.restart) {
        await this.options.factory.restart(connection!, () =>
          this.checkIntent(intent),
        );
        initialized = await controller.initialize();
      }
      if (
        initialized === "awaiting-restart" &&
        (intent === this.sensorIntent || restartDisconnect)
      )
        throw new Error(
          "Droid restarted or is restarting. Choose the droid again to complete initialization.",
        );
      this.checkIntent(intent);
      if (initialized === "ready") {
        phase = "compatibility checks";
        const result: CompatibilityReport = this.hooks.prepare
          ? await this.hooks.prepare(controller, () => this.checkIntent(intent))
          : await compatibilityProbes(
              (command) => controller!.probe(command),
              () => this.checkIntent(intent),
            );
        this.checkIntent(intent);
        if (this.options.attitudeTelemetry) {
          // Configure only during an actual new transport connection. Never
          // replace a working connection to obtain a footer reading.
          this.attitudeEpoch=undefined;
          try { await installPlannedSensorSchema(async(command)=>{
            this.checkIntent(intent);
            const reply=await controller!.command(command);
            this.checkIntent(intent);return reply;
          },this.attitudeSchema);
          this.attitudeEpoch=this.connectionEpoch;
          this.sensorSession.enable(this.attitudeSchema);
          } catch(error) {
            this.checkIntent(intent);
            if(controller.state!=='ready')throw error;
            // Optional display telemetry must not tear down an otherwise ready
            // connection when firmware readback differs. Never decode guesses.
            this.attitudeEpoch=undefined;
            this.sensorSession.reset(`Attitude readings unavailable: ${String(error)}`);
            result.warnings.push(`Attitude readings unavailable: ${String(error)}`);
          }
        }
        if (this.focusPaused) await controller.emergencyStop();
        this.checkIntent(intent);
        this.publish({
          state: this.focusPaused ? "paused" : "ready",
          battery: result.battery,
          sensors: this.sensorSession.snapshot,
          detail: this.focusPaused
            ? "Control paused; Bluetooth retained. Return to Chrome to continue."
            : (result.detail ??
              (result.warnings.length
                ? `Ready with compatibility warnings: ${result.warnings.join("; ")}`
                : "Wake and compatibility checks completed. Droid ready.")),
        });
      }
    } catch (error) {
      try {
        if (this.controller === controller && controller) {
          this.controller = undefined;
          await controller.disconnect();
        } else if (controller) {
          await this.closing;
        }
      } finally {
        this.releaseOwnership(intent);
      }
      if (intent === this.sensorIntent)
        this.publish({
          // Selection/permission failures have no controller to stop. Retain the
          // error for the caller without presenting a failed physical STOP.
          state: !controller && !this.controller ? "disconnected" : "failed",
          detail: String(error),
        });
      if (disconnectedDuring && !restartDisconnect)
        throw new Error(
          `Bluetooth disconnected during ${disconnectedDuring}. ${error instanceof Error ? error.message : String(error)}`,
        );
      throw error;
    }
  }
  protected async closeConnection(intent: number) {
    // Old STOP completions are fenced by controller identity; they must not
    // suppress a later session's focus-loss safety work.
    this.focusStop = undefined;
    this.stopWork = undefined;
    this.stopping = false;
    this.cancelLocalSources();
    this.sensorSession.reset();
    const controller = this.controller,
      ownershipIntent = this.ownershipIntent;
    this.controller = undefined;
    this.publish({cockpitReadings:undefined,cockpitTelemetryStatus:undefined});
    if (controller) {
      this.closingControllers++;
      this.publish({ connectionEpoch: ++this.connectionEpoch });
    }
    if (controller || ownershipIntent !== undefined)
      this.publish({
        state: "disconnecting",
        sensors: this.sensorSession.snapshot,
        battery: undefined,
        detail: "Disconnecting…",
      });
    const closing = this.closing
      .then(async () => {
        if (controller) {
          // Revoke UI ownership immediately, but retain GATT long enough for priority STOP.
          // Browser suspension/transport failure can prevent delivery; never wait indefinitely.
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              Promise.resolve()
                .then(() => controller.emergencyStop())
                .catch(() => {}),
              new Promise<void>((resolve) => {
                timer = setTimeout(resolve, this.disconnectStopTimeoutMs);
              }),
            ]);
          } finally {
            clearTimeout(timer);
            await controller.disconnect();
          }
        }
      })
      .finally(() => {
        if (controller) this.closingControllers--;
        this.releaseOwnership(ownershipIntent);
      });
    this.closing = closing.catch(() => {});
    await closing;
    if (intent === this.sensorIntent)
      this.publish({
        state: "disconnected",
        sensors: this.sensorSession.snapshot,
        battery: undefined,
        detail: "",
      });
  }
  async disconnect() {
    this.recordLifecycle("disconnect-requested","Session disconnect invoked");
    this.options.factory.cancel?.();
    this.hooks.cancelSources?.();
    this.sensorManager.cancel();
    const intent = ++this.sensorIntent;
    await this.closeConnection(intent);
  }
}
