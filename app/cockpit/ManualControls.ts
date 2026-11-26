import { mappedPoint, mappedPulse } from "./Calibration.ts";
import { toArcadeInput } from "./controlModels.ts";
import type { ControllerSession } from "../session/ControllerSession.ts";
import type { ManualMotionToken } from "../session/ManualMotion.ts";
import { AccessiblePulseRunner } from "../../core/accessiblePulse.ts";
import type { PulseDirection } from "../../core/accessiblePulse.ts";
import { boundedDrive, nativeBoundedDrive } from "../../core/controlValues.ts";
export type DriveSource = "pointer" | "keyboard" | "gamepad" | "tilt";
/** One owner across continuous and bounded input; source switches require another gesture. */
export class ManualControls {
  private session: ControllerSession;
  private allowed: () => boolean;
  private notify: (error: unknown) => void;
  private token?: ManualMotionToken;
  private source?: DriveSource;
  private releasing?: Promise<void>;
  private pulseRunner = new AccessiblePulseRunner();
  private remove: () => void;
  constructor(
    session: ControllerSession,
    allowed: () => boolean,
    notify: (error: unknown) => void,
  ) {
    this.session = session;
    this.allowed = allowed;
    this.notify = notify;
    this.remove = session.registerCancel(() => this.revoke());
  }
  begin(source: DriveSource) {
    if (
      !this.allowed() ||
      this.releasing
    )
      return false;
    if (this.token) {
      if (source === this.source) return true;
      void this.release().catch(this.notify);
      return false;
    }
    try {
      this.token = this.session.manualMotion.acquire(source);
      this.source = source;
      return true;
    } catch (error) {
      this.notify(error);
      return false;
    }
  }
  move(source: DriveSource, point: [number, number], speed: number) {
    if (source !== this.source || !this.token) return;
    if (!this.allowed()) {
      void this.release().catch(this.notify);
      return;
    }
    try {
      this.session.drive(
        ...toArcadeInput(
          mappedPoint(
            this.session,
            this.session.store.getSnapshot().connection.epoch,
            point,
          ),
        ),
        speed,
      );
    } catch (error) {
      void this.release().catch(this.notify);
      this.notify(error);
    }
  }
  async release() {
    if (this.releasing) return this.releasing;
    const token = this.token;
    this.token = undefined;
    this.source = undefined;
    this.pulseRunner.cancel();
    if (!token) return;
    this.releasing = this.session.release().finally(() => {
      this.session.manualMotion.release(token);
      this.releasing = undefined;
    });
    return this.releasing;
  }
  revoke() {
    this.pulseRunner.cancel(true);
    this.token = undefined;
    this.source = undefined;
    this.session.manualMotion.revoke();
  }
  async pulse(
    direction: PulseDirection,
    cap: number,
    native: boolean,
    check = false,
  ) {
    if (!this.allowed())
      throw Error("Resume a ready droid connection before driving.");
    if (this.releasing) throw Error("Wait for release to finish.");
    const lease = this.session.manualMotion.acquire(
      check ? "wheel check" : "accessible pulse",
    );
    try {
      await this.pulseRunner.start(
        check
          ? direction
          : mappedPulse(
              this.session,
              this.session.store.getSnapshot().connection.epoch,
              direction,
            ),
        10,
        Math.min(25, cap),
        async (command, signal) => {
          this.session.assertManualSource(command);
          if (signal.aborted) return;
          this.session.armMotion();
          const release = this.session.manualMotion.guard(lease, () =>
            this.session.releaseDrive(),
          );
          const stop = this.session.manualMotion.guard(lease, () =>
            this.session.stop(true),
          );
          if (native)
            await nativeBoundedDrive(
              () => this.session.pulseDrive(command),
              release,
              stop,
              signal,
            );
          else
            await boundedDrive(
              () => this.session.executeManual(command),
              release,
              stop,
              { signal, durationMs: 200 },
            );
        },
      );
    } finally {
      this.session.manualMotion.release(lease);
    }
  }
  dispose() {
    this.remove();
    this.pulseRunner.cancel();
    void this.release().catch(this.notify);
  }
}
