import { libraryItem } from "./catalog.ts";
import { loadSettings, updateSettings } from "./settings.ts";
import type { PreferenceStore } from "./settings.ts";
export const INPUT_ACTIONS = [
  "driveUp",
  "driveDown",
  "driveLeft",
  "driveRight",
  "domeLeft",
  "domeRight",
  "domeCenter",
  "slot1",
  "slot2",
  "slot3",
  "slot4",
  "slot5",
  "slot6",
  "slot7",
  "slot8",
  "slot9",
  "gearDown",
  "gearUp",
  "stance",
  "stop",
  "home",
] as const;
export type InputAction = (typeof INPUT_ACTIONS)[number];
export type HudPreferences = {
  gearSpeeds: [number, number, number];
  gear: 0 | 1 | 2;
  soundboard: (string | null)[];
  haptics: boolean;
  showNudges: boolean;
  input: {
    keys: Record<InputAction, string>;
    gamepad: Record<InputAction, number>;
  };
};
export const DEFAULT_SOUNDBOARD = [
  "sound:184",
  "sound:207",
  "sound:42",
  "sound:232",
  "sound:139",
  "sound:151",
  "animation:21",
  "animation:16",
  "animation:13",
];
export const HUD_PREFERENCE_KEY = "cockpitPreferences";
const keys = [
  "KeyW",
  "KeyS",
  "KeyA",
  "KeyD",
  "KeyQ",
  "KeyE",
  "KeyC",
  "Digit1",
  "Digit2",
  "Digit3",
  "Digit4",
  "Digit5",
  "Digit6",
  "Digit7",
  "Digit8",
  "Digit9",
  "BracketLeft",
  "BracketRight",
  "KeyT",
  "Space",
  "KeyH",
];
// Negative values mean this action has no standard gamepad button. Axes remain standard.
const buttons = [
  -1, -1, -1, -1, -1, -1, -1, 0, 1, 2, 3, 12, 15, 13, 14, -1, 4, 5, 10, 9, 8,
];
export function defaultsHudPreferences(): HudPreferences {
  return {
    gearSpeeds: [25, 50, 100],
    gear: 0,
    soundboard: [...DEFAULT_SOUNDBOARD],
    haptics: true,
    showNudges: false,
    input: {
      keys: Object.fromEntries(
        INPUT_ACTIONS.map((a, i) => [a, keys[i]]),
      ) as Record<InputAction, string>,
      gamepad: Object.fromEntries(
        INPUT_ACTIONS.map((a, i) => [a, buttons[i]]),
      ) as Record<InputAction, number>,
    },
  };
}
export function validateHudPreferences(value: HudPreferences): HudPreferences {
  if (
    !Array.isArray(value.gearSpeeds) ||
    value.gearSpeeds.length !== 3 ||
    value.gearSpeeds.some((n) => !Number.isInteger(n) || n < 0 || n > 100)
  )
    throw new Error(
      "Each gear speed must be a whole percentage from 0 to 100.",
    );
  if (![0, 1, 2].includes(value.gear))
    throw new Error("Choose gear 1, 2 or 3.");
  if (
    value.soundboard.length !== 9 ||
    value.soundboard.some((key) => key !== null && (!libraryItem(key) || !!libraryItem(key)?.lightEffect))
  )
    throw new Error("Choose nine known library slots.");
  if (
    typeof value.haptics !== "boolean" ||
    typeof value.showNudges !== "boolean"
  )
    throw new Error("Choose accessibility preferences.");
  const mapped = INPUT_ACTIONS.map((a) => value.input.keys[a]);
  if (
    mapped.some(
      (key) =>
        typeof key !== "string" ||
        !/^Key[A-Z]$|^Digit[0-9]$|^(Space|BracketLeft|BracketRight|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Enter|Comma|Period|Slash|Minus|Equal)$/.test(
          key,
        ),
    ) ||
    new Set(mapped).size !== mapped.length
  )
    throw new Error(
      "Use unique keyboard codes, such as KeyW, Digit1 or Space. Escape is always STOP.",
    );
  if (
    INPUT_ACTIONS.some(
      (a) =>
        !Number.isInteger(value.input.gamepad[a]) ||
        value.input.gamepad[a] < -1 ||
        value.input.gamepad[a] > 31,
    )
  )
    throw new Error("Gamepad buttons must be -1 (unassigned) or 0–31.");
  const assigned = INPUT_ACTIONS.map((a) => value.input.gamepad[a]).filter(
    (n) => n >= 0,
  );
  if (
    new Set(assigned).size !== assigned.length ||
    value.input.gamepad.stop < 0 ||
    INPUT_ACTIONS.some((a) => a !== "stop" && value.input.gamepad[a] === 9)
  )
    throw new Error(
      "Use unique assigned gamepad buttons. Start (9) is reserved for STOP.",
    );
  return value;
}
export function decodeHudPreferences(text: string): HudPreferences {
  const defaults = defaultsHudPreferences();
  const raw = JSON.parse(text);
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw Error("Saved HUD preferences must be an object.");
  // Eight-slot libraries gain a ninth slot while retaining custom mappings.
  if (Array.isArray(raw.soundboard) && raw.soundboard.length === 8) {
    raw.soundboard = [...raw.soundboard, DEFAULT_SOUNDBOARD[8]];
  }
  if (!raw.input?.keys?.slot9) {
    const used = new Set(Object.values({...defaults.input.keys, ...raw.input?.keys}));
    used.delete(defaults.input.keys.slot9);
    for (const [action,key] of Object.entries(raw.input?.keys ?? {})) {
      if (action !== 'slot9') used.add(key);
    }
    const key = ['Digit9','Digit0',...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(c=>`Key${c}`)].find(key=>!used.has(key));
    raw.input = {...raw.input, keys:{...raw.input?.keys,slot9:key}};
  }
  const next = {
    ...defaults,
    ...raw,
    input: {
      keys: { ...defaults.input.keys, ...raw.input?.keys },
      gamepad: { ...defaults.input.gamepad, ...raw.input?.gamepad },
    },
  } as HudPreferences;
  return validateHudPreferences(next);
}
export function parseHudPreferences(text: string | null): HudPreferences {
  try {
    return text === null ? defaultsHudPreferences() : decodeHudPreferences(text);
  } catch {
    return defaultsHudPreferences();
  }
}
export const loadHudPreferences = (session: Pick<PreferenceStore, "loadPreference">) =>
  loadSettings(session).hud;
export function saveHudPreferences(
  session: PreferenceStore,
  prefs: HudPreferences,
) {
  const hud = validateHudPreferences(JSON.parse(JSON.stringify(prefs)));
  return updateSettings(session, current => ({...current, hud}));
}
export function pinSoundboard(
  prefs: HudPreferences,
  slot: number,
  key: string | null,
): HudPreferences {
  if (
    !Number.isInteger(slot) ||
    slot < 0 ||
    slot > 8 ||
    (key !== null && (!libraryItem(key) || !!libraryItem(key)?.lightEffect))
  )
    throw new Error("Choose a valid soundboard slot and catalog item.");
  return {
    ...prefs,
    soundboard: prefs.soundboard.map((old, index) =>
      index === slot ? key : old,
    ),
  };
}
