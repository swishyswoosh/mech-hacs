import type { TelemetryEvent } from "../../core/telemetryEvents.ts";
export type FigureSnapshot = {
  lights: Array<number | undefined>;
  stance?: "two" | "three" | "waddle";
};
export const emptyFigure = (): FigureSnapshot => ({
  lights: Array(8).fill(undefined),
});
/** Command previews are not physical readbacks; failed/requested writes never change them. */
export function figureState(
  previous: FigureSnapshot,
  event: TelemetryEvent,
): FigureSnapshot {
  if (
    event.type === "connection" &&
    ["disconnected", "scanning", "sleeping"].includes(event.state)
  )
    return emptyFigure();
  if (event.type !== "command" || event.phase !== "acknowledged")
    return previous;
  if (event.did === 0x17 && event.cid === 13) {
    const stance = ({ 1: "three", 2: "two", 3: "waddle" } as const)[
      event.data[0] as 1 | 2 | 3
    ];
    return { ...previous, stance };
  }
  if (event.did !== 0x1a || event.cid !== 14 || event.data.length < 2)
    return previous;
  const mask = (event.data[0] << 8) | event.data[1],
    lights = [...previous.lights];
  let index = 2;
  for (let bit = 0; bit < 16; bit++)
    if (mask & (1 << bit)) {
      if (bit < 8) lights[bit] = event.data[index];
      index++;
    }
  return { ...previous, lights };
}
