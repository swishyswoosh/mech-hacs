import { darkPalette } from "./palettes.ts";
// CSS variables update every web control, including static StyleSheet entries,
// without remounting fields, routes, or the live DroidSession.
export const colors: typeof darkPalette = Object.fromEntries(
  Object.entries(darkPalette).map(([key, value]) => [
    key,
    typeof document === "undefined" ? value : `var(--r2-${key}, ${value})`,
  ]),
) as typeof darkPalette;
export const fonts = {
  heading: "Rajdhani-SemiBold",
  body: "Inter",
  mono: "JetBrainsMono",
};
export const tokens = {
  colors,
  fonts,
  touchMin: 56,
  radius: { chip: 4, panel: 10, pill: 999 },
} as const;
