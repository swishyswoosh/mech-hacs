export type InterfacePreferences = {
  theme: "system" | "light" | "dark";
  defaultSpeed: number;
  largeLabels: boolean;
};
export const defaultPreferences: InterfacePreferences = {
  theme: "system",
  defaultSpeed: 25,
  largeLabels: false,
};
export function parsePreferences(value: unknown): InterfacePreferences {
  const prefs = value as InterfacePreferences;
  if (!prefs || !["system", "light", "dark"].includes(prefs.theme))
    throw new Error("Choose System, Light or Dark appearance.");
  if (!Number.isInteger(prefs.defaultSpeed) || prefs.defaultSpeed < 0 || prefs.defaultSpeed > 100)
    throw new Error("Default speed must be an integer from 0 to 100 percent.");
  if (typeof prefs.largeLabels !== "boolean") throw new Error("Choose the label size.");
  return { theme: prefs.theme, defaultSpeed: prefs.defaultSpeed, largeLabels: prefs.largeLabels };
}
export function loadPreferences(text: string | null) {
  try {
    return parsePreferences(JSON.parse(text || ""));
  } catch {
    return { ...defaultPreferences };
  }
}
export function themeColor(
  theme: "light" | "dark",
  color: unknown,
  kind: "background" | "text" | "border",
): unknown {
  if (theme !== "dark") return color;
  if (kind === "background") {
    if (color === "#fff" || color === "#ffffff" || color === "white") return "#172233";
    if (color === "#f5f7fb") return "#0d1420";
  }
  if (kind === "text") {
    if (color === "#182235") return "#edf3fc";
    if (color === "#46566b") return "#bcc8d7";
  }
  if (kind === "border" && (color === "#718096" || color === "#c8d0dc")) return "#95a5ba";
  return color;
}
