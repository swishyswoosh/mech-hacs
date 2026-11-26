export type ConnectionBoundary = { state: string; connectionEpoch?: number };
/** This gate consumes every port transition before React is allowed to coalesce
 * snapshots. Validation belongs to one continuously-ready connection only. */
export class WheelMappingGate {
  private ready = false;
  private validated = false;
  private epoch?: number;
  get allowed() {
    return this.ready && this.validated;
  }
  observe(snapshot: ConnectionBoundary) {
    const changed =
      this.epoch !== undefined &&
      snapshot.connectionEpoch !== undefined &&
      snapshot.connectionEpoch !== this.epoch;
    const boundary = (this.ready && snapshot.state !== "ready") || changed;
    if (snapshot.state !== "ready" || changed) this.validated = false;
    this.ready = snapshot.state === "ready";
    if (snapshot.connectionEpoch !== undefined)
      this.epoch = snapshot.connectionEpoch;
    return boundary;
  }
  validate(expectedEpoch?: number) {
    if (expectedEpoch !== undefined && expectedEpoch !== this.epoch)
      throw new Error(
        "Droid connection changed before validation. Validate the current droid explicitly.",
      );
    if (!this.ready)
      throw new Error(
        "A ready droid connection is required before validating wheel mapping.",
      );
    this.validated = true;
  }
  revoke() {
    this.validated = false;
  }
}
export function subscribeWheelMapping<T extends ConnectionBoundary>(
  port: { subscribe: (listener: (snapshot: T) => void) => () => void },
  gate: WheelMappingGate,
  listener: (snapshot: T, boundary: boolean) => void,
) {
  return port.subscribe((snapshot) => {
    const boundary = gate.observe(snapshot);
    listener(snapshot, boundary);
  });
}
