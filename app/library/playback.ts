import type { TelemetryEvent } from "../../core/telemetryEvents.ts";
import { libraryItems } from "./catalog.ts";
export type PlaybackState = {
  kind: "animation" | "sound";
  id: number;
  name: string;
  requestedAt: number;
  ackAt?: number;
  status:
    | "requested"
    | "acknowledged"
    | "stop-acknowledged"
    | "failed"
    | "interrupted";
  error?: string;
};
/** Acknowledgement is never interpreted as physical or audible completion. */
export class LibraryPlayback {
  state?: PlaybackState;
  private requestId = 0;
  private pending: Array<{ key: string; id: number }> = [];
  accept(event: TelemetryEvent): boolean {
    if (event.type !== "command") return false;
    const stop =
      (event.did === 0x17 &&
        event.cid === 43 &&
        this.state?.kind === "animation") ||
      (event.did === 0x1a && event.cid === 10 && this.state?.kind === "sound");
    if (stop && event.phase === "acknowledged" && this.state) {
      this.state = { ...this.state, status: "stop-acknowledged" };
      this.pending = [];
      return true;
    }
    const kind =
      event.did === 0x17 && event.cid === 5
        ? "animation"
        : event.did === 0x1a && event.cid === 7
          ? "sound"
          : undefined;
    if (!kind || event.data.length < 2) return false;
    const key = `${event.did}/${event.cid}/${event.data.join(",")}`,
      id = (event.data[0] << 8) | event.data[1];
    if (event.phase === "requested") {
      this.pending.push({ key, id: event.id });
      this.requestId = event.id;
      const item = libraryItems.find(
        (item) =>
          item.kind === kind &&
          (kind === "sound" ? item.sector === id : item.id === id),
      );
      this.state = {
        kind,
        id,
        name: item?.name || "Uncatalogued sound",
        requestedAt: event.at,
        status: "requested",
      };
      return true;
    }
    const index = this.pending.findIndex((request) => request.key === key);
    if (index < 0) return false;
    const [request] = this.pending.splice(index, 1);
    if (request.id !== this.requestId || !this.state) return false;
    this.state = {
      ...this.state,
      status: event.phase === "acknowledged" ? "acknowledged" : "failed",
      ...(event.phase === "acknowledged"
        ? { ackAt: event.at }
        : { error: event.error }),
    };
    return true;
  }
  interrupt() {
    this.pending = [];
    this.requestId = 0;
    if (this.state) this.state = { ...this.state, status: "interrupted" };
  }
  elapsed(now: number) {
    return this.state?.ackAt === undefined
      ? 0
      : Math.max(0, now - this.state.ackAt);
  }
}
