import { AboutPanel } from "../components/AboutPanel.tsx";
import { HudPage } from "../components/HudPage.tsx";
import React, { useRef, useState } from "react";
import { View, StyleSheet, Platform, useWindowDimensions } from "react-native";
import type { ControllerSession } from "../session/ControllerSession.ts";
import { HudPanel, HudButton } from "../components/Hud.tsx";
import { HudText } from "../theme/Theme.tsx";
import { Field } from "../library/Fields.tsx";
import { InputMapping } from "../library/InputMapping.tsx";
import {
  INPUT_ACTIONS,
  loadHudPreferences,
  defaultsHudPreferences,
  validateHudPreferences,
} from "../library/preferences.ts";
import type { HudPreferences, InputAction } from "../library/preferences.ts";
import { loadInterface } from "../library/interfacePreferences.ts";
import { loadSettings, saveSettings } from "../library/settings.ts";
import type { InterfacePreferences } from "../library/interfacePreferences.ts";
export type { InterfacePreferences } from "../library/interfacePreferences.ts";
function SettingsButton(props: React.ComponentProps<typeof HudButton>) {
  return (
    <HudButton
      {...props}
      style={[{ minHeight: 34, paddingVertical: 5, paddingHorizontal: 10 }, props.style]}
    />
  );
}
export function Settings({
  session,
  ready,
  notify,
  applied,
  onApplied,
  onAppearance,
  onHudChanged,
  onRecheckWheels,
  onSafety,
  onHome,
  intensity,
  onIntensity,
  depot,
  onDepot,
  children,
}: {
  session: ControllerSession;
  ready: boolean;
  notify: (text: string) => void;
  applied?: InterfacePreferences;
  onApplied?: (prefs: InterfacePreferences) => void;
  onAppearance?: (theme: "light" | "dark") => void;
  onHudChanged?: (prefs: HudPreferences) => void;
  onRecheckWheels: () => void;
  onSafety?: () => void;
  onHome?: () => void;
  intensity?: boolean;
  onIntensity?: (value: boolean) => void;
  depot?: boolean;
  onDepot?: (value: boolean) => void;
  children?: React.ReactNode;
}) {
  const { width } = useWindowDimensions();
  const [about, setAbout] = useState(false);
  const [draft, setDraft] = useState(() => loadHudPreferences(session)),
    [interfaceDraft, setInterface] = useState(() => applied || loadInterface(session)),
    [speeds, setSpeeds] = useState(() => loadHudPreferences(session).gearSpeeds.map(String)),
    [speed, setSpeed] = useState(String((applied || loadInterface(session)).defaultSpeed)),
    [reset, setReset] = useState(false),
    [saving, setSaving] = useState(false),
    [message, setMessage] = useState(() => loadSettings(session).error ?? "");
  const [gamepad, setGamepad] = useState(
    () =>
      Object.fromEntries(
        INPUT_ACTIONS.map((action) => [action, String(draft.input.gamepad[action])]),
      ) as Record<InputAction, string>,
  );
  const latestDraft = useRef({ draft, interfaceDraft, speeds, speed, gamepad });
  latestDraft.current = { draft, interfaceDraft, speeds, speed, gamepad };
  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      if (
        speeds.some((v) => !v.trim()) ||
        !speed.trim() ||
        INPUT_ACTIONS.some((a) => !gamepad[a].trim())
      )
        throw new Error("Complete the speed and input fields before saving.");
      const next = validateHudPreferences({
        ...draft,
        gearSpeeds: speeds.map(Number) as [number, number, number],
        input: {
          ...draft.input,
          gamepad: Object.fromEntries(INPUT_ACTIONS.map((a) => [a, Number(gamepad[a])])) as Record<
            InputAction,
            number
          >,
        },
      });
      const defaultSpeed = Number(speed);
      if (!Number.isInteger(defaultSpeed) || defaultSpeed < 0 || defaultSpeed > 100)
        throw new Error("Default speed must be a whole percentage from 0 to 100.");
      const prefs = {
        ...interfaceDraft,
        theme: applied?.theme ?? interfaceDraft.theme,
        defaultSpeed,
      };
      // Held driving is released before a saved speed change can affect its tick.
      await session.release();
      await saveSettings(session, { hud: next, interface: prefs });
      const current = latestDraft.current;
      const newerEdits =
        current.draft !== draft ||
        current.interfaceDraft !== interfaceDraft ||
        current.speeds !== speeds ||
        current.speed !== speed ||
        current.gamepad !== gamepad;
      setDraft((current) => (current === draft ? next : current));
      setInterface((current) => (current === interfaceDraft ? prefs : current));
      onApplied?.(prefs);
      onHudChanged?.(next);
      const result = newerEdits
        ? "Submitted preferences saved. Newer edits remain in the draft."
        : "Preferences saved.";
      setMessage(result);
      notify(result);
      setReset(false);
    } catch (error) {
      setMessage(String(error));
      notify(String(error));
    } finally {
      setSaving(false);
    }
  };
  const restore = () => {
    const next = loadHudPreferences(session),
      prefs = applied || loadInterface(session);
    setDraft(next);
    setInterface(prefs);
    setSpeeds(next.gearSpeeds.map(String));
    setSpeed(String(prefs.defaultSpeed));
    setGamepad(
      Object.fromEntries(INPUT_ACTIONS.map((a) => [a, String(next.input.gamepad[a])])) as Record<
        InputAction,
        string
      >,
    );
    setMessage(loadSettings(session).error ?? "Saved preferences restored.");
    setReset(false);
  };
  const defaults = () => {
    const next = defaultsHudPreferences();
    setDraft({ ...next, soundboard: draft.soundboard });
    setSpeeds(next.gearSpeeds.map(String));
    setSpeed("25");
    setInterface({ theme: "dark", defaultSpeed: 25, largeLabels: false });
    setGamepad(
      Object.fromEntries(INPUT_ACTIONS.map((a) => [a, String(next.input.gamepad[a])])) as Record<
        InputAction,
        string
      >,
    );
    setReset(false);
    setMessage("Defaults loaded into draft. Save preferences to apply.");
  };
  return (
    <HudPage contentContainerStyle={{ padding: 8, paddingBottom: 8, gap: 4 }}>
      <View style={[s.row, { paddingBottom: 6 }]}>
        {onHome && <SettingsButton label="Home" onPress={onHome} />}
        <SettingsButton
          label="Save preferences"
          primary
          disabled={saving}
          onPress={() => void save()}
        />
        <SettingsButton label="Discard unsaved preference edits" onPress={restore} />
        <SettingsButton label="Reset input preferences" onPress={() => setReset(true)} />
      </View>
      <HudPanel style={s.panel}>
        <View style={[s.row, { justifyContent: "space-between" }]}>
          <HudText kind="heading" style={{ fontSize: 20 }}>
            Gears
          </HudText>
          <SettingsButton
            label="Wheel calibration (optional)"
            disabled={!ready}
            onPress={onRecheckWheels}
          />
        </View>
        <View style={{ gap: 8 }}>
          {(width < 600
            ? [
                [0, 1],
                [2, 3],
              ]
            : [[0, 1, 2, 3]]
          ).map((row, rowIndex) => (
            <View key={rowIndex} style={{ flexDirection: "row", gap: 8, alignItems: "flex-start" }}>
              {row.map((index) => (
                <View key={index} style={{ flex: 1, minWidth: 0 }}>
                  <Field
                    compact
                    id={index === 3 ? "hud-default-speed" : `hud-gear-speed-${index}`}
                    label={
                      index === 3
                        ? "Default drive speed percent"
                        : `Gear ${index + 1} speed percent`
                    }
                    value={index === 3 ? speed : speeds[index]}
                    onChangeText={(value) =>
                      index === 3
                        ? setSpeed(value)
                        : setSpeeds((old) => old.map((n, i) => (i === index ? value : n)))
                    }
                    keyboardType="number-pad"
                  />
                </View>
              ))}
            </View>
          ))}
        </View>
        <HudText muted style={{ fontSize: 12 }}>
          Speeds are command percentages from 0–100. Saving releases held driving.
        </HudText>
      </HudPanel>
      <View style={{ flexDirection: width < 900 ? "column" : "row", gap: 8 }}>
        <HudPanel style={[s.panel, width >= 900 ? { flex: 1 } : {}]}>
          <HudText kind="heading" style={{ fontSize: 20 }}>
            Accessibility
          </HudText>
          <View style={s.row}>
            <SettingsButton
              label={`Haptics ${draft.haptics ? "on" : "off"}`}
              primary={draft.haptics}
              onPress={() => setDraft({ ...draft, haptics: !draft.haptics })}
            />
            <SettingsButton
              label={`Large labels ${interfaceDraft.largeLabels ? "on" : "off"}`}
              primary={interfaceDraft.largeLabels}
              onPress={() =>
                setInterface({
                  ...interfaceDraft,
                  largeLabels: !interfaceDraft.largeLabels,
                })
              }
            />
            <SettingsButton
              label={`Nudge arrows ${draft.showNudges ? "on" : "off"}`}
              primary={draft.showNudges}
              onPress={() => setDraft({ ...draft, showNudges: !draft.showNudges })}
            />
          </View>
        </HudPanel>
        <HudPanel style={[s.panel, width >= 900 ? { flex: 1 } : {}]}>
          <HudText kind="heading" style={{ fontSize: 20 }}>
            Droid console
          </HudText>
          <View style={s.row}>
            {onIntensity && (
              <SettingsButton
                label={`Theme effects ${intensity ? "on" : "off"}`}
                onPress={() => onIntensity(!intensity)}
              />
            )}
            {onDepot && (
              <SettingsButton
                label={`Depot ${depot ? "on" : "off"}`}
                caution
                onPress={() => onDepot(!depot)}
              />
            )}
            <SettingsButton label="About" onPress={() => setAbout(true)} />
            {onSafety && <SettingsButton label="About safety" onPress={onSafety} />}
          </View>
          <HudText muted style={{ fontSize: 12, lineHeight: 17 }}>
            {session.mode === "remote"
              ? "Controllers connected to the same service share preferences and drafts."
              : "Your preferences and drafts are saved on this device."}
          </HudText>
        </HudPanel>
      </View>
      <InputMapping
        keys={draft.input.keys}
        gamepad={gamepad}
        onKey={(action, value) =>
          setDraft((old) => ({
            ...old,
            input: {
              ...old.input,
              keys: { ...old.input.keys, [action]: value },
            },
          }))
        }
        onGamepad={(action, value) => setGamepad((old) => ({ ...old, [action]: value }))}
      />
      {reset && (
        <HudPanel style={s.panel}>
          <HudText>
            Load default label size, speeds, haptics and input mapping into this draft? Favorites,
            soundboard, recordings and files stay intact.
          </HudText>
          <SettingsButton label="Load defaults into draft" onPress={defaults} />
          <SettingsButton label="Keep current preferences" onPress={() => setReset(false)} />
        </HudPanel>
      )}
      {!!message && (
        <HudText accessibilityLiveRegion="polite" style={{ fontSize: 12 }}>
          {message}
        </HudText>
      )}
      {about && <AboutPanel onClose={() => setAbout(false)} />}
      {children}
    </HudPage>
  );
}
const s = StyleSheet.create({
  panel: { padding: 8, gap: 4 },
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    alignItems: "center",
  },
});
