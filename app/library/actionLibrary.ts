import { commands } from "../../core/index.ts";
import { animations, sounds } from "../../core/catalogs.ts";
import { actionSchedules } from "../../core/actionSchedules.ts";
import type { TelemetryEvent } from "../../core/telemetryEvents.ts";
const validKeys = new Set([
  ...animations.map((item) => `animation:${item.id}`),
  "animation:55",
  ...sounds.map((item) => `sound:${item.id}`),
]);
export function loadFavorites(value: string | null): string[] {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed)
      ? [
          ...new Set(
            parsed.filter((key): key is string => typeof key === "string" && validKeys.has(key)),
          ),
        ]
      : [];
  } catch {
    return [];
  }
}
export function toggleFavorite(keys: string[], key: string) {
  if (!validKeys.has(key)) throw new Error("Unknown library favorite.");
  return keys.includes(key) ? keys.filter((item) => item !== key) : [...keys, key];
}
export function soundCategory(name: string) {
  return (
    /^R2_(Alarm|Chatty|Excited|Hey|Laugh|Negative|Positive|Sad)(?:_|\b)/.exec(name)?.[1] ||
    "Effects"
  );
}
export function animationName(id: number) {
  return (
    animations
      .find((item) => item.id === id)
      ?.name.replace(/^R2D2_/, "")
      .replace(/\.bin$/, "")
      .replace(/_/g, " ") || (id === 55 ? "Additional motor sound" : "Unknown animation")
  );
}
export function actionDescription(id: number) {
  const schedule = actionSchedules.find((item) => item.id === id);
  if (!schedule) return "No decoded schedule available; movement content and completion unknown.";
  const audio = schedule.audioSectors
    .map(
      (sector) =>
        `${sector}${sounds.some((item) => item.sector === sector) ? "" : " (uncatalogued)"}`,
    )
    .join(", ");
  const tracksDescription = `Decoded schedule requests ${schedule.tracks.join(", ")}.`;
  const audioDescription = audio ? ` Droid audio sectors: ${audio}.` : "";
  const timingDescription =
    schedule.scheduleMs > 0
      ? `Encoded schedule span ${(schedule.scheduleMs / 1000).toFixed(3)} s; sound duration and physical completion unknown.`
      : "Immediate schedule; sound duration unknown. Physical completion unknown.";
  return `${tracksDescription}${audioDescription} ${timingDescription}`;
}
export type PlaybackState = {
  kind: "animation" | "audio";
  id: number;
  name: string;
  requestedAt: number;
  ackAt?: number;
  status: "requested" | "acknowledged" | "stop-acknowledged" | "failed" | "interrupted";
  error?: string;
};
export class ActionPlayback {
  state?: PlaybackState;
  private requestId = 0;
  private pending: Array<{ key: string; id: number }> = [];
  accept(event: TelemetryEvent): boolean {
    if (event.type !== "command") return false;
    const stop =
      (event.did === 0x17 && event.cid === 43 && this.state?.kind === "animation") ||
      (event.did === 0x1a && event.cid === 10 && this.state?.kind === "audio");
    if (stop && event.phase === "acknowledged" && this.state) {
      this.pending = [];
      this.requestId = 0;
      this.state = { ...this.state, status: "stop-acknowledged" };
      return true;
    }
    const kind =
      event.did === 0x17 && event.cid === 5
        ? "animation"
        : event.did === 0x1a && event.cid === 7
          ? "audio"
          : undefined;
    if (!kind || event.data.length < 2) return false;
    const key = `${event.did}/${event.cid}/${event.data.join(",")}`,
      id = (event.data[0] << 8) | event.data[1];
    if (event.phase === "requested") {
      this.pending.push({ key, id: event.id });
      this.requestId = event.id;
      this.state = {
        kind,
        id,
        name:
          kind === "animation"
            ? animationName(id)
            : sounds.find((sound) => sound.sector === id)?.name || `Sector ${id}`,
        requestedAt: event.at,
        status: "requested",
      };
      return true;
    }
    const pendingIndex = this.pending.findIndex((request) => request.key === key);
    if (pendingIndex < 0) return false;
    const [request] = this.pending.splice(pendingIndex, 1);
    if (request.id !== this.requestId || !this.state) return false;
    this.state = {
      ...this.state,
      status: event.phase === "acknowledged" ? "acknowledged" : "failed",
      ...(event.phase === "acknowledged" ? { ackAt: event.at } : { error: event.error }),
    };
    return true;
  }
  interrupt() {
    this.pending = [];
    this.requestId = 0;
    if (this.state) this.state = { ...this.state, status: "interrupted" };
  }
  elapsed(now: number) {
    return this.state?.ackAt === undefined ? 0 : Math.max(0, now - this.state.ackAt);
  }
}

/** Local playback history cannot determine whether firmware still needs either scoped stop. */
export const actionLibraryStops = [
  { title: "Stop animation", build: commands.stopAnimation },
  { title: "Stop all audio", build: commands.stopAudio },
] as const;
