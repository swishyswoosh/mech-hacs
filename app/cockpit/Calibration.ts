import type { PulseDirection } from "../../core/accessiblePulse.ts";
const calibrations = new WeakMap<
  object,
  { epoch: number; x: number; y: number }
>();
export function setCalibration(
  session: object,
  epoch: number,
  x: number,
  y: number,
) {
  if (![x, y].every((n) => n === 1 || n === -1))
    throw Error("Invalid wheel direction");
  calibrations.set(session, { epoch, x, y });
}
export function mappedPoint(
  session: object,
  epoch: number,
  point: [number, number],
): [number, number] {
  const c = calibrations.get(session);
  return c?.epoch === epoch ? [point[0] * c.x, point[1] * c.y] : point;
}
export function mappedPulse(
  session: object,
  epoch: number,
  direction: PulseDirection,
): PulseDirection {
  const c = calibrations.get(session);
  if (c?.epoch !== epoch) return direction;
  return direction === "Forward"
    ? c.y === 1
      ? "Forward"
      : "Reverse"
    : direction === "Reverse"
      ? c.y === 1
        ? "Reverse"
        : "Forward"
      : direction === "Turn Left"
        ? c.x === 1
          ? "Turn Left"
          : "Turn Right"
        : c.x === 1
          ? "Turn Right"
          : "Turn Left";
}
