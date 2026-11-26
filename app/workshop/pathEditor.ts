import { parsePathDraft, previewPath } from "../../core/automation.ts";
import type { PathDraft, PathPoint } from "../../core/automation.ts";
export function editWaypoint(
  points: PathPoint[],
  index: number,
  operation: "replace" | "insert" | "delete",
  point?: PathPoint,
): PathPoint[] {
  if (!Number.isInteger(index) || index < 0 || index >= points.length)
    throw new Error("Select a waypoint first.");
  if (
    operation !== "delete" &&
    (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y))
  )
    throw new Error("Enter finite X and Y coordinates.");
  if (operation === "insert" && points.length >= 256)
    throw new Error("A path supports at most 256 waypoints.");
  const next = points.map((p) => ({ ...p }));
  if (operation === "delete") next.splice(index, 1);
  else if (operation === "insert") next.splice(index + 1, 0, { ...point! });
  else next[index] = { ...point! };
  return next;
}
export function moveWaypoint(
  points: PathPoint[],
  index: number,
  direction: -1 | 1,
): PathPoint[] {
  const next = points.map((p) => ({ ...p })),
    target = index + direction;
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    index >= points.length ||
    target < 0 ||
    target >= points.length
  )
    throw new Error("Waypoint is at the route boundary.");
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}
export function readPathDraft(text: string | null | undefined): PathDraft {
  const empty: PathDraft = {
    version: 1,
    units: "preview",
    points: [],
    speedPercent: 25,
    startOrientation: 0,
  };
  if (!text) return empty;
  const value = JSON.parse(text);
  if (Array.isArray(value)) {
    previewPath(value, 25, 0);
    return { ...empty, points: value };
  }
  return parsePathDraft(text);
}
export function previewPosition(
  points: PathPoint[],
  progress: number,
  orientation: number,
) {
  if (!points.length) return undefined;
  let segments: ReturnType<typeof previewPath>;
  try {
    segments = previewPath(points, 25, orientation);
  } catch {
    return undefined;
  }
  const total = segments.reduce((sum, s) => sum + s.length, 0);
  let distance = Math.min(1, Math.max(0, progress)) * total,
    segment = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i],
      length = Math.hypot(b.x - a.x, b.y - a.y);
    if (!length) continue;
    const heading =
      (((Math.round((Math.atan2(b.x - a.x, -(b.y - a.y)) * 180) / Math.PI) +
        orientation) %
        360) +
        360) %
      360;
    if (distance <= length || i === points.length - 1) {
      const fraction = length ? Math.min(1, distance / length) : 0;
      return {
        x: a.x + (b.x - a.x) * fraction,
        y: a.y + (b.y - a.y) * fraction,
        heading,
        segment,
      };
    }
    distance -= length;
    segment++;
  }
  return { ...points[0], heading: orientation, segment: 0 };
}
export type TraversalSnapshot = {
  status: "idle" | "running" | "paused" | "completed";
  progress: number;
};
/** Local geometry clock only. This class has no droid/session/transport access. */
export class PathTraversal {
  snapshot: TraversalSnapshot = { status: "idle", progress: 0 };
  private duration = 1;
  private last = 0;
  start(points: PathPoint[], speed: number, orientation: number, now: number) {
    const total = previewPath(points, speed, orientation).reduce(
      (sum, part) => sum + part.length,
      0,
    );
    if (!total) throw new Error("Add at least two distinct waypoints.");
    if (speed <= 0) throw new Error("Preview speed must be positive.");
    this.duration = (total / speed) * 1000;
    this.last = now;
    this.snapshot = { status: "running", progress: 0 };
    return this.snapshot;
  }
  tick(now: number) {
    if (this.snapshot.status !== "running") return this.snapshot;
    const progress = Math.min(
      1,
      this.snapshot.progress + Math.max(0, now - this.last) / this.duration,
    );
    this.last = now;
    this.snapshot = {
      status: progress >= 1 ? "completed" : "running",
      progress,
    };
    return this.snapshot;
  }
  pause(now: number) {
    this.tick(now);
    if (this.snapshot.status === "running")
      this.snapshot = { ...this.snapshot, status: "paused" };
    return this.snapshot;
  }
  resume(now: number) {
    if (this.snapshot.status === "paused") {
      this.last = now;
      this.snapshot = { ...this.snapshot, status: "running" };
    }
    return this.snapshot;
  }
  stop() {
    this.snapshot = { status: "idle", progress: 0 };
    return this.snapshot;
  }
}
/** Sampling resolution affects only new drawing points, never existing waypoints. */
export function sampleWaypoint(
  points: PathPoint[],
  point: PathPoint,
  spacing: number,
): PathPoint[] {
  if (!Number.isFinite(spacing) || spacing < 0.25 || spacing > 100)
    throw new Error("Drawing spacing must be 0.25–100 preview units.");
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y))
    throw new Error("Enter finite coordinates.");
  const last = points[points.length - 1];
  return points.length < 256 &&
    (!last || Math.hypot(last.x - point.x, last.y - point.y) >= spacing)
    ? [...points, { ...point }]
    : points;
}

/** Convert pointer coordinates using the actual rendered canvas, including short landscape cards. */
export function canvasPoint(x:number,y:number,width:number,height:number,bounds:{minX:number;minY:number;maxX:number;maxY:number}):PathPoint{
 const unit=(n:number,size:number)=>Math.max(0,Math.min(1,n/Math.max(1,size)));
 return {x:Math.round(bounds.minX+unit(x,width)*(bounds.maxX-bounds.minX)),y:Math.round(bounds.minY+unit(y,height)*(bounds.maxY-bounds.minY))};
}
