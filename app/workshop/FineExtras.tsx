import { useColors, useThemedStyles } from "../theme/useColors.ts";
import type { Palette } from "../theme/appearance.ts";
import { inputTheme } from "../theme/appearance.ts";
import type {
  ManualMotionLease,
  ManualMotionToken,
} from "../session/ManualMotion.ts";
import React, { useState, useEffect, useRef } from "react";
import { TextInput, Pressable, StyleSheet, Platform } from "react-native";
import { View, Text } from "./primitives.tsx";
import { commands, requiresMotionArm } from "../../core/index.ts";
import type { Command } from "../../core/index.ts";
import type { AppPort, AppSnapshot } from "../session/types.ts";
import {readOptionalPreference} from '../library/optionalPreference.ts';
import {
  boundedDrive,
  nativeBoundedDrive,
  integerValue,
  selectedLightCommand,
  headingCommand,
  readFloatResponse,
} from "../../core/controlValues.ts";
const channelNames = [
  "Front PSI red",
  "Front PSI green",
  "Front PSI blue",
  "Rear PSI red",
  "Rear PSI green",
  "Rear PSI blue",
  "Logic display",
  "Holoprojector",
];
function Entry({
  label,
  value,
  set,
}: {
  label: string;
  value: string;
  set: (v: string) => void;
}) {
  const colors = useColors();
  const s = useThemedStyles(make_s);
  const {inputPalette, inputSurface} = inputTheme(colors);

  const id = `extra-${label.replace(/\W/g, "")}`;
  return (
    <View style={s.field}>
      {Platform.OS === "web" ? (
        React.createElement("label", { htmlFor: id, style: {fontSize: 12} }, label)
      ) : (
        <Text>{label}</Text>
      )}
      <TextInput
        cursorColor={inputPalette.caret}
        selectionColor={inputPalette.selection}
        placeholderTextColor={inputPalette.placeholder}
        nativeID={id}
        accessibilityLabel={label}
        value={value}
        onChangeText={set}
        style={s.input}
      />
    </View>
  );
}
function Action({
  title,
  run,
  text = title,
  disabled = false,
}: {
  title: string;
  text?: string;
  run: () => void;
  disabled?: boolean;
}) {
  const colors = useColors();
  const s = useThemedStyles(make_s);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      disabled={disabled}
      accessibilityState={{ disabled }}
      onPress={run}
      style={[s.button, disabled && { opacity: 0.55 }]}
    >
      <Text style={{ color: colors.text, fontSize: 13 }}>{text}</Text>
    </Pressable>
  );
}
export function FineExtras({
  page,
  port,
  snapshot,
  execute,
  onMessage,
  registerCancel,
  beforeManualInput,
  manualMotion,
  executeNativePulse,
}: {
  page: string;
  port: AppPort;
  snapshot: AppSnapshot;
  execute: (c: Command) => Promise<unknown>;
  onMessage: (m: string) => void;
  registerCancel?: (cancel: () => void) => () => void;
  beforeManualInput?: () => void;
  manualMotion: ManualMotionLease;
  executeNativePulse?: (command: Command) => Promise<void>;
}) {
  const colors = useColors();
  const s = useThemedStyles(make_s);

  const ready = snapshot.state === "ready";
  const activePulse = useRef<AbortController | undefined>(undefined);
  useEffect(
    () =>
      registerCancel?.(() => {
        const pulse = activePulse.current;
        activePulse.current = undefined;
        pulse?.abort("replacement-barrier");
      }),
    [registerCancel],
  );
  useEffect(
    () => () => {
      const pulse = activePulse.current;
      activePulse.current = undefined;
      pulse?.abort();
    },
    [page, port],
  );
  useEffect(() => {
    if (!ready) {
      const pulse = activePulse.current;
      activePulse.current = undefined;
      pulse?.abort("replacement-barrier");
    }
  }, [ready]);
  const [headReading, setHeadReading] = useState("Not queried"),
    [legReading, setLegReading] = useState("Not queried"),
    [leg, setLeg] = useState("0");
  const [values, setValues] = useState(Array(8).fill("0") as string[]),
    [selected, setSelected] = useState(Array(8).fill(true) as boolean[]);
  const [presetRead] = useState(() => readOptionalPreference(port, 'lightPreset', 'light preset'));
  const [presetNameRead] = useState(() => readOptionalPreference(port, 'lightPresetName', 'light preset name'));
  const [preset, setPreset] = useState(
      () => presetRead.value || "",
    ),
    [presetName, setPresetName] = useState(
      () => presetNameRead.value || "My lights",
    );
  const savedPresetName = readOptionalPreference(port, 'lightPresetName', 'light preset name');
  const [heading, setHeading] = useState("0"),
    [driveSpeed, setDriveSpeed] = useState("25"),
    [left, setLeft] = useState("0"),
    [right, setRight] = useState("0");
  const [rawMode0, setRawMode0] = useState("0"),
    [rawMode1, setRawMode1] = useState("0"),
    [raw0, setRaw0] = useState("0"),
    [raw1, setRaw1] = useState("0");
  const [readVolume, setReadVolume] = useState("Not queried");
  const act = async (f: () => Promise<unknown> | unknown) => {
    try {
      await f();
    } catch (e) {
      onMessage(String(e));
    }
  };
  const send = (build: () => Command) =>
    void act(() => {
      const command = build();
      if (manualMotion.active && requiresMotionArm(command))
        throw new Error(
          "Release active manual motion before another motion action.",
        );
      beforeManualInput?.();
      if (requiresMotionArm(command)) port.armMotion();
      return execute(command);
    });
  const pulse = (build: () => Command) => {
    void (async () => {
      let intent: AbortController | undefined,
        lease: ManualMotionToken | undefined;
      try {
        if (Platform.OS === "android" && !executeNativePulse)
          throw new Error(
            "Advanced pulses unavailable: this build lacks the independent native deadline API.",
          );
        const command = build();
        lease = manualMotion.acquire("advanced pulse");
        beforeManualInput?.();
        intent = new AbortController();
        activePulse.current = intent;
        port.armMotion();
        if (Platform.OS === "android")
          await nativeBoundedDrive(
            () => executeNativePulse!(command),
            manualMotion.guard(lease, () => port.releaseDrive()),
            manualMotion.guard(lease, () => port.stop()),
            intent.signal,
          );
        else
          await boundedDrive(
            () => execute(command),
            manualMotion.guard(lease, () => port.releaseDrive()),
            manualMotion.guard(lease, () => port.stop()),
            { signal: intent.signal },
          );
      } catch (error) {
        if (!intent?.signal.aborted) onMessage(String(error));
      } finally {
        if (activePulse.current === intent) activePulse.current = undefined;
        if (lease) manualMotion.release(lease);
      }
    })();
  };
  return (
    <View style={s.card}>
      {!!(presetRead.error || savedPresetName.error) && <Text accessibilityRole="alert">{presetRead.error || savedPresetName.error}</Text>}
      {page === "Dome & Stance" && (
        <>
          <Text style={s.heading}>
            Articulation feedback and advanced stance
          </Text>
          <View style={s.row}>
          <Text style={s.readback}>
            Streamed dome: {snapshot.sensors?.values.headAngle ?? "—"} raw wire
            angle. Queried dome: {headReading}
          </Text>
          <Action
            title="Query dome position"
            disabled={!ready}
            run={() =>
              void act(async () =>
                setHeadReading(
                  `${readFloatResponse(await execute(commands.getHead()))}° · ${new Date().toLocaleTimeString()}`,
                ),
              )
            }
          />
          </View>
          <View style={s.row}>
          <Text style={s.readback}>Queried shoulder cam: {legReading}</Text>
          <Action
            title="Query shoulder cam position"
            disabled={!ready}
            run={() =>
              void act(async () =>
                setLegReading(
                  `${readFloatResponse(await execute(commands.getLeg()))}° · ${new Date().toLocaleTimeString()}`,
                ),
              )
            }
          />
          </View>
          <Text>
            Query values are timestamped snapshots; refresh explicitly.{" "}
            {ready ? "" : "Disconnected readings are stale."}
          </Text>
          <Text>
            Head behavior controls firmware tracking; no camera or person
            detection is implied.
          </Text>
          <View style={s.row}>
          <Action
            title="Non-tracking head behavior"
            disabled={!ready}
            run={() => send(() => commands.headTracking(false))}
          />
          <Action
            title="Tracking head behavior"
            disabled={!ready}
            run={() => send(() => commands.headTracking(true))}
          />
          </View>
          <View style={s.row}>
          <Entry
            label="Advanced shoulder cam target degrees"
            value={leg}
            set={setLeg}
          />
          <Action
            title="Apply shoulder cam target"
            disabled={!ready}
            run={() =>
              send(() => {
                const n = Number(leg);
                if (!leg.trim() || !Number.isFinite(n))
                  throw new Error("Enter a valid cam angle.");
                return commands.leg(n);
              })
            }
          />
          </View>
          <Text>0 to 338.700012°. One shared stance mechanism.</Text>
        </>
      )}
      {page === "Lights" && (
        <>
          <Text style={s.heading}>Individual LED channels</Text>
          <View style={s.row}>
          {Platform.OS === "web" &&
            [0, 3].map((offset) => (
              <View key={offset} style={s.row}>
                <Text>{offset === 0 ? "Front" : "Rear"} PSI color draft</Text>
                {React.createElement("input", {
                  type: "color",
                  "aria-label": `${offset === 0 ? "Front" : "Rear"} PSI color`,
                  value:
                    "#" +
                    values
                      .slice(offset, offset + 3)
                      .map((v) =>
                        Math.round(Math.max(0, Math.min(255, Number(v) || 0)))
                          .toString(16)
                          .padStart(2, "0"),
                      )
                      .join(""),
                  onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
                    const rgb = event.target.value.slice(1).match(/../g)!;
                    setValues(
                      values.map((old, i) =>
                        i >= offset && i < offset + 3
                          ? String(parseInt(rgb[i - offset], 16))
                          : old,
                      ),
                    );
                  },
                  style: { minWidth: 60, minHeight: 32 },
                })}
              </View>
            ))}
          </View>
          <View style={s.grid}>
          {channelNames.map((label, i) => (
            <View key={label} style={s.channel}>
              <Action
                text={selected[i] ? "Included" : "Excluded"}
                title={`${selected[i] ? "Selected" : "Excluded"}: ${label} (mask ${2 ** i})`}
                run={() =>
                  setSelected(selected.map((v, j) => (i === j ? !v : v)))
                }
              />
              <Entry
                label={`${label} byte`}
                value={values[i]}
                set={(v) =>
                  setValues(values.map((old, j) => (i === j ? v : old)))
                }
              />
            </View>
          ))}
          </View>
          <Action
            title="Apply selected LED channels"
            disabled={!ready}
            run={() => send(() => selectedLightCommand(values, selected))}
          />
          <View style={s.row}>
          <Entry
            label="Light preset name"
            value={presetName}
            set={setPresetName}
          />
          <Action
            title="Save light preset locally"
            run={() =>
              void act(async () => {
                const data = JSON.stringify({ values, selected });
                selectedLightCommand(values, selected);
                await port.savePreference("lightPreset", data);
                await port.savePreference("lightPresetName", presetName);
                setPreset(data);
              })
            }
          />
          <Action
            title={`Load saved light preset: ${savedPresetName.value || "none"}`}
            disabled={!preset}
            run={() =>
              void act(async () => {
                const data = JSON.parse(preset);
                selectedLightCommand(data.values, data.selected);
                setValues(data.values);
                setSelected(data.selected);
              })
            }
          />
          </View>
          <Text>
            Loading edits the draft only. Apply explicitly sends selected
            channels. Start idle LED animation restores the firmware light routine.
          </Text>
        </>
      )}
      {page === "Audio" && (
        <>
          <Text style={s.heading}>Audio feedback</Text>
          <View style={s.row}>
          <Action
            title="Read audio volume"
            disabled={!ready}
            run={() =>
              void act(async () => {
                const response = (await execute(commands.getVolume())) as {
                  data: Uint8Array;
                };
                if (response.data.length !== 1)
                  throw new Error("Expected one volume byte");
                setReadVolume(
                  `${response.data[0]} / 255 · ${new Date().toLocaleTimeString()}`,
                );
              })
            }
          />
          <Text>Reported volume: {readVolume}</Text>
          <Action
            title="Stop all audio"
            disabled={!ready}
            run={() => send(commands.stopAudio)}
          />
          </View>
          <Text>
            Search named droid-stored sounds in the Sounds library. Playback uses
            vetted default mode 0; other mode meanings are unverified.
          </Text>
        </>
      )}
      {page === "Drive" && (
        <>
          <Text style={s.heading}>Advanced bounded drive controls</Text>
          <Text>
            {Platform.OS === "android"
              ? executeNativePulse
                ? "Native fixed 200 ms deadline with a mode-matched zero; ACK and physical stop remain unconfirmed."
                : "Advanced pulses are disabled: this build lacks the independent native deadline API. Use the accessible capped tank pulses."
              : "Each command is a supervised 200 ms pulse followed by drive release."}{" "}
            Advanced commands retain the explicit full byte range (0–255),
            separately from the accessible pulse 25% cap. Numeric wheel
            association requires physical validation. Heading is a droid
            reference, not compass north.
          </Text>
          <View style={s.row}>
          <Entry
            label="Advanced drive speed byte"
            value={driveSpeed}
            set={setDriveSpeed}
          />
          <Entry
            label="Advanced heading degrees"
            value={heading}
            set={setHeading}
          />
          <Action
            title="Pulse drive with heading"
            disabled={
              !ready || (Platform.OS === "android" && !executeNativePulse)
            }
            run={() => pulse(() => headingCommand(driveSpeed, heading))}
          />
          <Action
            title="Reset yaw reference"
            disabled={!ready}
            run={() => send(commands.resetYaw)}
          />
          </View>
          <View style={s.row}>
          <Entry
            label="Tank channel 0 signed byte"
            value={left}
            set={setLeft}
          />
          <Entry
            label="Tank channel 1 signed byte"
            value={right}
            set={setRight}
          />
          <Action
            title="Pulse tank demands"
            disabled={
              !ready || (Platform.OS === "android" && !executeNativePulse)
            }
            run={() =>
              pulse(() => {
                const a = integerValue(left, -255, 255),
                  b = integerValue(right, -255, 255);
                return commands.tank(
                  Math.abs(a),
                  Math.abs(b),
                  (a < 0 ? 8 : 0) | (b < 0 ? 16 : 0),
                );
              })
            }
          />
          </View>
          <View style={s.row}>
          <Entry
            label="Raw motor channel 0 mode (0–2)"
            value={rawMode0}
            set={setRawMode0}
          />
          <Entry
            label="Raw motor channel 0 speed byte"
            value={raw0}
            set={setRaw0}
          />
          <Entry
            label="Raw motor channel 1 mode (0–2)"
            value={rawMode1}
            set={setRawMode1}
          />
          <Entry
            label="Raw motor channel 1 speed byte"
            value={raw1}
            set={setRaw1}
          />
          <Action
            title="Pulse raw motors"
            disabled={
              !ready || (Platform.OS === "android" && !executeNativePulse)
            }
            run={() =>
              pulse(() =>
                commands.rawMotors(
                  integerValue(rawMode0, 0, 2),
                  integerValue(raw0, 0, 255),
                  integerValue(rawMode1, 0, 2),
                  integerValue(raw1, 0, 255),
                ),
              )
            }
          />
          </View>
          <Text>
            Mode bytes retain decoded numeric semantics. Stabilization and
            locator flags require vetted capability support.
          </Text>
        </>
      )}
      {page === "Modes" && (
        <Text>
          These switches show requested settings. Mode readbacks and notification registrations are in Events & modes; support depends on the connected firmware.
        </Text>
      )}
    </View>
  );
}
const make_s = (colors: Palette) => {
  const {inputSurface} = inputTheme(colors);
  return StyleSheet.create({
  card: {
    backgroundColor: colors.panel,
    padding: 10,
    gap: 8,
    borderWidth: 1,
    borderColor: colors.line2,
    borderRadius: 10,
  },
  row: {flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center"},
  grid: {flexDirection: "row", flexWrap: "wrap", gap: 8},
  channel: {flexDirection: "row", alignItems: "center", gap: 8, flexBasis: 230, flexGrow: 1},
  readback: {flexBasis: 260, flexGrow: 1},
  field: { gap: 4, flexBasis: 150, flexGrow: 1, minWidth: 120 },
  input: {
    ...inputSurface,
    minHeight: Platform.OS === "web" ? 32 : 44,
    borderWidth: 1,
    borderColor: colors.line2,
    padding: 8,
    fontSize: 14,
  },
  button: {
    minHeight: Platform.OS === "web" ? 32 : 44,
    backgroundColor: colors.panelRaised,
    padding: 8,
    borderRadius: 7,
    justifyContent: "center",
  },
  heading: { fontSize: 17, fontWeight: "600" },
});
};
