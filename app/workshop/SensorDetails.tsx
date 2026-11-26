import {DepotDetails} from "./CompactLayout.tsx";
import { useColors, useThemedStyles } from "../theme/useColors.ts";
import type { Palette } from "../theme/appearance.ts";
import { inputTheme } from "../theme/appearance.ts";
import React, { useEffect, useRef, useState } from "react";
import { TextInput, Pressable, StyleSheet, Platform } from "react-native";
import { View, Text } from "./primitives.tsx";
import {
  commands,
  decodeSensorReading,
} from "../../core/index.ts";
import type { Command, Packet, SensorReading } from "../../core/index.ts";
import type { AppPort, AppSnapshot } from "../session/types.ts";
import {
  collisionDraftBytes,
  collisionFieldLabel,
  sensorReadingText,
} from "./sensorDetails.ts";
type CapturedReading = {
  reading: SensorReading;
  hex: string;
  at: number;
  epoch: number;
};
const subscriptions = [
  {
    key: "leg",
    label: "Leg-action completion",
    build: commands.legNotifications,
    decoder:
      "Typed leg-complete events are decoded from the audited registration.",
  },
  {
    key: "head",
    label: "Reset-path notification gate (17/39)",
    build: commands.headResetNotifications,
    decoder:
      "Firmware reset-time producer emits zero-payload 17/3a when enabled. Managed SDK name pairing remains unverified; incoming packets stay raw.",
  },
  {
    key: "battery",
    label: "Battery state changes",
    build: commands.batteryNotifications,
    decoder:
      "Typed battery-state events are decoded from the audited registration.",
  },
];
export function SensorDetails({
  page,
  snapshot,
  port,
  clock,
  onOpenService,
}: {
  page: string;
  snapshot: AppSnapshot;
  port: AppPort;
  clock: number;
  onOpenService?: () => void;
}) {
  const colors = useColors();
  const s = useThemedStyles(make_s);
  const {inputPalette, inputSurface} = inputTheme(colors);

  const [readings, setReadings] = useState<Record<string, CapturedReading>>({}),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [collision, setCollision] = useState(Array(6).fill("0") as string[]),
    [configured, setConfigured] = useState("Not configured in this session"),
    [collisionEpoch, setCollisionEpoch] = useState<number>(),
    [epoch, setEpoch] = useState(0),
    [requested, setRequested] = useState<
      Record<string, { enabled: boolean; at: number; epoch: number }>
    >({});
  const currentEpoch = useRef(epoch);
  currentEpoch.current = epoch;
  useEffect(() => {
    if (snapshot.state !== "ready") setEpoch((value) => value + 1);
  }, [snapshot.state]);
  const ready = snapshot.state === "ready";
  if (!["Articulation", "Power & Health", "Events"].includes(page)) return null;
  const button = (title: string, run: () => void, disabled = false) => (
    <Pressable
      key={title}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={run}
      style={[s.button, disabled && { opacity: 0.55 }]}
    >
      <Text style={{ color: colors.text }}>{title}</Text>
    </Pressable>
  );
  const run = (operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setMessage("Waiting for droid response…");
    void operation()
      .then(
        () =>
          setMessage(
            "Matching response received. Hardware behavior requires live validation.",
          ),
        (error) =>
          setMessage(error instanceof Error ? error.message : String(error)),
      )
      .finally(() => setBusy(false));
  };
  const query = (kind: SensorReading["kind"], command: Command) => {
    const session = currentEpoch.current;
    run(async () => {
      const response = (await port.execute(command)) as Packet;
      const reading = decodeSensorReading(kind, response);
      setReadings((old) => ({
        ...old,
        [kind]: {
          reading,
          hex: Array.from(response.data, (byte) =>
            byte.toString(16).padStart(2, "0"),
          ).join(" "),
          at: Date.now(),
          epoch: session,
        },
      }));
    });
  };
  const reading = (kind: SensorReading["kind"]) => {
    const captured = readings[kind];
    return captured ? (
      <View style={s.reading}>
        <Text>{sensorReadingText(captured.reading)}</Text>
        <Text selectable>Wire bytes: {captured.hex}</Text>
        <Text>
          {new Date(captured.at).toLocaleTimeString()} · age{" "}
          {Math.max(0, clock - captured.at)} ms ·{" "}
          {ready && captured.epoch === epoch && clock - captured.at <= 3000
            ? "timestamped snapshot"
            : "STALE"}
        </Text>
      </View>
    ) : (
      <Text>No {kind} query has returned a valid reading.</Text>
    );
  };
  return (
    <View style={s.section}>
      {page === "Articulation" && (
        <>
          <Text style={s.title}>Queried articulation inputs</Text>
          {button(
            "Read shoulder and head ADC counts",
            () => query("adc", commands.adc()),
            !ready || busy,
          )}
          {reading("adc")}
          {button(
            "Read left and right encoders",
            () => query("encoders", commands.encoderCounts()),
            !ready || busy,
          )}
          {reading("encoders")}
          {button(
            "Read shoulder stall-recovery hold",
            () => query("stall", commands.stallRecovery()),
            !ready || busy,
          )}
          {reading("stall")}
          <Text>
            ADC order is shoulder first, head second. Encoder order is left first, right second, from the droid’s perspective.
            Raw counters wrap at signed 16-bit limits; no distance is inferred. Hold is firmware
            mechanism state, not force or current measurement. Queries run only
            when you press Read.
          </Text>
        </>
      )}
      {page === "Power & Health" && (
        <>
          <Text style={s.title}>Queried processor health</Text>
          {button(
            "Read ST processor temperature estimate",
            () => query("temperature", commands.temperature()),
            !ready || busy,
          )}
          {reading("temperature")}
          <Text>
            Temperature is an internal processor estimate, not room temperature.
            The restricted latched I2C health query (18/06) requires service
            access; use Diagnostics to review its requirements.
          </Text>
          {onOpenService &&
            button(
              "Review restricted health access in Diagnostics",
              onOpenService,
            )}
          <Text>
            Battery voltage and battery-state raw queries remain in Droid. The
            latest event packets remain in Events.
          </Text>
        </>
      )}
      {page === "Events" && (
        <>
          <Text style={s.title}>Event subscription requests</Text>
          {subscriptions.map((subscription) => {
            const state = requested[subscription.key];
            return (
              <View style={s.reading} key={subscription.key}>
                <Text style={s.title}>{subscription.label}</Text>
                <Text>
                  {state
                    ? `${state.enabled ? "Enable" : "Disable"} acknowledged at ${new Date(state.at).toLocaleTimeString()} · ${ready && state.epoch === epoch ? "requested setting; delivery unverified" : "STALE · prior session"}`
                    : "No request acknowledged in this session"}
                </Text>
                <Text>{subscription.decoder}</Text>
                <View style={s.row}>
                  {[true, false].map((enabled) =>
                    button(
                      `${enabled ? "Enable" : "Disable"} ${subscription.label}`,
                      () => {
                        const session = currentEpoch.current;
                        run(async () => {
                          await port.execute(subscription.build(enabled));
                          setRequested((old) => ({
                            ...old,
                            [subscription.key]: {
                              enabled,
                              at: Date.now(),
                              epoch: session,
                            },
                          }));
                        });
                      },
                      !ready || busy,
                    ),
                  )}
                </View>
              </View>
            );
          })}
          <Text>
            These settings are not restored automatically after reconnect. Sleep
            notifications require no separately proved enable request. Animation
            completion, play-mode, gyro-maximum and activity event
            registrations/configurations without validated mappings remain
            unavailable; unknown packets stay visible below.
          </Text>
          <Text style={s.title}>Collision configuration · six raw bytes</Text>
          <Text>
            The first byte is a mode selector restricted by firmware to 0–3;
            mode names are not established. Bytes 1–5 retain their unsigned
            0–255 range because SDK field pairing and units remain unverified.
            These values are not obstacle clearance or distance. No automatic
            configuration is sent.
          </Text>
          <View style={s.row}>
          {collision.map((value, index) => (
            <View key={index} style={{flexBasis:140,flexGrow:1,gap:4}}>
              {Platform.OS === "web" ? (
                React.createElement(
                  "label",
                  { htmlFor: `collision-byte-${index}` },
                  collisionFieldLabel(index),
                )
              ) : (
                <Text>{collisionFieldLabel(index)}</Text>
              )}
              <TextInput
                cursorColor={inputPalette.caret}
                selectionColor={inputPalette.selection}
                placeholderTextColor={inputPalette.placeholder}
                nativeID={`collision-byte-${index}`}
                accessibilityLabel={collisionFieldLabel(index)}
                value={value}
                onChangeText={(next) =>
                  setCollision((old) =>
                    old.map((prior, i) => (i === index ? next : prior)),
                  )
                }
                style={s.input}
              />
            </View>
          ))}
          </View>
          {button(
            "Apply six collision configuration bytes",
            () =>
              run(async () => {
                const bytes = collisionDraftBytes(collision),
                  session = currentEpoch.current;
                await port.execute(commands.collisionConfiguration(bytes));
                setCollisionEpoch(session);
                setConfigured(
                  `${bytes.join(", ")} · acknowledged ${new Date().toLocaleTimeString()}; event delivery unverified`,
                );
              }),
            !ready || busy,
          )}
          <Text>
            Last requested collision configuration: {configured}
            {collisionEpoch !== undefined &&
            (!ready || collisionEpoch !== epoch)
              ? " · STALE prior session"
              : ""}
          </Text>
          <DepotDetails title="Collision decoder status">
          <Text>
            Collision notification fields are not decoded without a validated
            registration and schema.
          </Text>
          </DepotDetails>
        </>
      )}
      {["Articulation", "Power & Health", "Events"].includes(page) && (
        <Text accessibilityLiveRegion="polite">{message}</Text>
      )}
    </View>
  );
}
const make_s = (colors: Palette) => {
  const {inputSurface} = inputTheme(colors);
  return StyleSheet.create({
  section: { gap: 6, marginVertical: 6 },
  title: { fontSize: 18, fontWeight: "600" },
  reading: { gap: 5, marginVertical: 8 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
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
    padding: 8,
    backgroundColor: colors.panelRaised,
    borderRadius: 6,
    justifyContent: "center",
  },
});
};
