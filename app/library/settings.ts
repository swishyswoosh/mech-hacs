import { loadPreferences, parsePreferences } from "../preferences.ts";
import type { InterfacePreferences } from "../preferences.ts";
import {
  defaultsHudPreferences,
  decodeHudPreferences,
  HUD_PREFERENCE_KEY,
  validateHudPreferences,
} from "./preferences.ts";
import type { HudPreferences } from "./preferences.ts";

export const SETTINGS_PREFERENCE_KEY = "controllerSettings";
export const INTERFACE_PREFERENCE_KEY = "interfacePreferences";
export type PreferenceStore = {
  loadPreference(key: string): string | null;
  savePreference(key: string, value: string): void | Promise<void>;
};
type Reader = Pick<PreferenceStore, "loadPreference">;
export type ControllerSettings = {
  version: 1;
  hud: HudPreferences;
  interface: InterfacePreferences;
};
type LoadedSettings = ControllerSettings & { error?: string };
type PendingSettings = { pending?: Promise<void>; generation: number };
const pendingSettings = new WeakMap<PreferenceStore, PendingSettings>();

function parseSettings(text: string): ControllerSettings {
  const value = JSON.parse(text);
  if (!value || value.version !== 1) throw Error("Unsupported controller settings version.");
  return {
    version: 1,
    hud: validateHudPreferences(value.hud),
    interface: parsePreferences(value.interface),
  };
}

export function loadSettings(session: Reader): LoadedSettings {
  try {
    const text = session.loadPreference(SETTINGS_PREFERENCE_KEY);
    if (text !== null) return parseSettings(text);
    const hud = session.loadPreference(HUD_PREFERENCE_KEY);
    const appearance = session.loadPreference(INTERFACE_PREFERENCE_KEY);
    return {
      version: 1,
      hud: hud === null ? defaultsHudPreferences() : decodeHudPreferences(hud),
      interface:
        appearance === null ? loadPreferences(null) : parsePreferences(JSON.parse(appearance)),
    };
  } catch (error) {
    // Optional settings must not interrupt STOP or an existing connection.
    return {
      version: 1,
      hud: defaultsHudPreferences(),
      interface: loadPreferences(null),
      error: `Saved controller settings are unreadable, invalid or use an unsupported version. Saving is blocked to preserve them. ${String(error)}`,
    };
  }
}

export function saveSettings(
  session: PreferenceStore,
  settings: Pick<ControllerSettings, "hud" | "interface">,
) {
  const next: ControllerSettings = {
    version: 1,
    hud: validateHudPreferences(JSON.parse(JSON.stringify(settings.hud))),
    interface: parsePreferences(settings.interface),
  };
  return updateSettings(session, () => next);
}

export function updateSettings(
  session: PreferenceStore,
  change: (current: ControllerSettings) => Pick<ControllerSettings, "hud" | "interface">,
): void | Promise<void> {
  let state = pendingSettings.get(session);
  if (!state) {
    state = { generation: 0 };
    pendingSettings.set(session, state);
  }
  const writes = state;
  const generation = writes.generation;
  const apply = () => {
    if (generation !== writes.generation)
      throw Error(
        "An earlier settings save failed. Review your draft and use a fresh save action.",
      );
    const current = loadSettings(session);
    if (current.error) throw Error(current.error);
    const changed = change(current);
    const next: ControllerSettings = {
      version: 1,
      hud: validateHudPreferences(changed.hud),
      interface: parsePreferences(changed.interface),
    };
    return session.savePreference(SETTINGS_PREFERENCE_KEY, JSON.stringify(next));
  };
  const fail = (error: unknown): never => {
    if (generation === writes.generation) writes.generation++;
    throw error;
  };
  let result: void | Promise<void>;
  try {
    // Each partial update reads the record after the preceding write is
    // acknowledged. A rejected write invalidates intents already waiting here.
    result = writes.pending ? writes.pending.then(apply, apply) : apply();
  } catch (error) {
    return fail(error);
  }
  if (!result) return;
  const pending = result.catch(fail);
  writes.pending = pending;
  const clear = () => {
    if (writes.pending === pending) writes.pending = undefined;
  };
  void pending.then(clear, clear);
  return pending;
}

export function saveInterfacePreferences(
  session: PreferenceStore,
  preferences: InterfacePreferences,
) {
  const appearance = parsePreferences(preferences);
  return updateSettings(session, (current) => ({ ...current, interface: appearance }));
}
