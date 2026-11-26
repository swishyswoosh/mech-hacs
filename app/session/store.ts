import type {
  ActivitySnapshot,
  AppSnapshot,
  SafetyState,
  SessionSnapshot,
} from "./types.ts";
type Details = {
  droidName?: string;
  droidId?: string;
  motionArmed: boolean;
  stopping: boolean;
  wheelsValidated: boolean;
  activity: ActivitySnapshot;
};
function stable<T extends object>(previous: T | undefined, next: T): T {
  return previous &&
    Object.keys(next).every((key) =>
      Object.is(previous[key as keyof T], next[key as keyof T]),
    )
    ? previous
    : next;
}
/** Snapshots and selectors retain their identity until their values change. */
export class SessionStore {
  private snapshot!: SessionSnapshot;
  private listeners = new Set<() => void>();
  constructor(initial: AppSnapshot) {
    this.update(initial, {
      motionArmed: false,
      stopping: false,
      wheelsValidated: false,
      activity: {
        source: null,
        label: "",
        sources: { automation: "", experience: "" },
      },
    });
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  update(app: AppSnapshot, details: Details) {
    const previous = this.snapshot;
    let safety: SafetyState =
      (app.state === "failed" || !!app.stopFailure)
        ? "failed"
        : app.state === "paused"
          ? "paused"
          : details.stopping
            ? "stopping"
            : app.state === "disconnected" || app.state === "sleeping"
              ? "disconnected"
              : app.state !== "ready"
                ? "connecting"
                : details.activity.source &&
                    details.activity.source !== "manual"
                  ? "busy"
                  : details.motionArmed
                    ? "armed"
                    : "ready-disarmed";
    this.snapshot = {
      ...app,
      connection: stable(previous?.connection, {
        state: app.state,
        droidName: details.droidName,
        droidId: details.droidId,
        battery: app.battery,
        epoch: app.connectionEpoch ?? 0,
      }),
      safety: stable(previous?.safety, {
        state: safety,
        motionArmed: details.motionArmed,
        wheelsValidated: details.wheelsValidated,
        canControl: app.state === "ready" && !details.stopping,
      }),
      activity: stable(previous?.activity, details.activity),
      telemetry: stable(previous?.telemetry, {
        sensors: app.sensors,
        observedDomeAngle: app.sensors?.values.headAngle,
        packets: app.packets,
      }),
    };
    for (const listener of this.listeners) listener();
  }
}
