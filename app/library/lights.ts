import { commands } from "../../core/index.ts";
export const LIGHT_CHANNELS = [
  "Front dome red",
  "Front dome green",
  "Front dome blue",
  "Rear dome red",
  "Rear dome green",
  "Rear dome blue",
  "Readouts (front blue, rear white)",
  "White projector",
];
export type LightPreset = "Idle" | "Alert" | "Party" | "Off";
export function lightPreset(name: LightPreset): number[] {
  return {
    Idle: [0, 40, 140, 20, 80, 0, 100, 100],
    Alert: [255, 0, 0, 255, 0, 0, 200, 255],
    Party: [150, 0, 255, 0, 220, 100, 255, 220],
    Off: [0, 0, 0, 0, 0, 0, 0, 0],
  }[name].slice();
}
export function colorToChannels(
  values: number[],
  panel: "front" | "rear",
  color: string,
): number[] {
  if (!/^#[0-9a-f]{6}$/i.test(color))
    throw new Error("Choose a six-digit RGB color.");
  const offset = panel === "front" ? 0 : 3;
  return values.map((value, index) =>
    index >= offset && index < offset + 3
      ? parseInt(
          color.slice(1 + (index - offset) * 2, 3 + (index - offset) * 2),
          16,
        )
      : value,
  );
}
export function selectedLightCommand(values: number[], selected: boolean[]) {
  if (
    values.length !== 8 ||
    selected.length !== 8 ||
    values.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
  )
    throw new Error("Each channel brightness must be a byte from 0 to 255.");
  // Wire order puts readouts at bit 3 and rear RGB at bits 4–6.
  const order = [0, 1, 2, 6, 3, 4, 5, 7];
  const mask = order.reduce((mask, index, bit) => mask + (selected[index] ? 2 ** bit : 0), 0);
  if (!mask) throw new Error("Select at least one light channel.");
  return commands.leds(mask, order.filter(index => selected[index]).map(index => values[index]));
}
