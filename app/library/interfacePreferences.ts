import { loadSettings } from "./settings.ts";
import type { InterfacePreferences } from "../preferences.ts";
export type { InterfacePreferences } from "../preferences.ts";
export function loadInterface(session: {
  loadPreference(key: string): string | null;
}): InterfacePreferences {
  return loadSettings(session).interface;
}
