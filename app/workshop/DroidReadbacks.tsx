import { Platform } from "react-native";
import { useColors, useThemedStyles } from "../theme/useColors.ts";
import type { Palette } from "../theme/appearance.ts";
import React, { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet } from "react-native";
import { View, Text } from "./primitives.tsx";
import { commands } from "../../core/index.ts";
import type { Command } from "../../core/index.ts";
import type { AppSnapshot } from "../session/types.ts";
import { identityQueries, readbackBytes } from "../../core/droidReadbacks.ts";
type Reading = {
  label: string;
  hex: string;
  at: number;
  epoch: number;
  connectionEpoch?: number;
};
export function DroidReadbacks({
  snapshot,
  execute,
  onSleep,
  registerBack,
}: {
  snapshot: AppSnapshot;
  execute: (command: Command) => Promise<unknown>;
  onSleep: () => Promise<unknown>;
  registerBack?: (handler: () => boolean) => () => void;
}) {
  const colors = useColors();
  const s = useThemedStyles(make_s);

  const [selected, setSelected] = useState(0),
    [readings, setReadings] = useState<Record<string, Reading>>({}),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [confirmSleep, setConfirmSleep] = useState(false),
    [epoch, setEpoch] = useState(0);
  const currentEpoch = useRef(epoch);
  currentEpoch.current = epoch;
  useEffect(() => {
    if (snapshot.state !== "ready") {
      setEpoch((value) => value + 1);
      setConfirmSleep(false);
    }
  }, [snapshot.state]);
  useEffect(
    () =>
      registerBack?.(() => {
        if (!confirmSleep) return false;
        setConfirmSleep(false);
        return true;
      }),
    [registerBack, confirmSleep],
  );
  const ready = snapshot.state === "ready";
  const read = (label: string, command: Command) => {
    const sourceEpoch = currentEpoch.current;
    void (async () => {
      setBusy(true);
      try {
        const response = await execute(command);
        setReadings((old) => ({
          ...old,
          [label]: {
            label,
            hex: readbackBytes(response),
            at: Date.now(),
            epoch: sourceEpoch,
            connectionEpoch: snapshot.connectionEpoch,
          },
        }));
        setMessage("Response received.");
      } catch (error) {
        setMessage(String(error));
      } finally {
        setBusy(false);
      }
    })();
  };
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
  return (
    <View style={s.card}>
      <Text style={s.title}>Identity readback</Text>
      <Text>
        Identity readings show the raw bytes returned by the droid.
      </Text>
      <View style={{flexDirection:"row",flexWrap:"wrap",gap:6}}>
      {identityQueries.map((query) =>
        button(
          `${query.label}${!query.available ? " · unavailable" : selected === query.cid ? " · selected" : ""}`,
          () => setSelected(query.cid),
          !query.available,
        ),
      )}
      </View>
      {button(
        "Read selected identity field",
        () => {
          const query = identityQueries.find((item) => item.cid === selected)!;
          read(query.label, query.command());
        },
        !ready || busy,
      )}
      <Text style={s.title}>Power</Text>
      <View style={{flexDirection:"row",flexWrap:"wrap",gap:6}}>
      {button(
        "Read battery voltage bytes",
        () => read("Battery voltage", commands.battery()),
        !ready || busy,
      )}
      {button(
        "Read battery state bytes",
        () => read("Battery state", commands.batteryState()),
        !ready || busy,
      )}
      {button(
        "Send wake on current ready link",
        () => read("Wake acknowledgement", commands.wake()),
        !ready || busy,
      )}
      </View>
      <Text>
        Wake on this link is an explicit request. A sleeping or powered-off
        droid may require reconnecting or its physical controls.
      </Text>
      {button(
        "Request droid sleep",
        () => setConfirmSleep(true),
        !ready || busy,
      )}
      {confirmSleep && (
        <View>
          <Text>
            Stop current sources and request sleep? This closes the Bluetooth
            session. Nothing resumes after reconnect.
          </Text>
          {button(
            "Stop current sources and sleep droid",
            () => {
              setBusy(true);
              void onSleep()
                .then(
                  () =>
                    setMessage(
                      "Normal sleep completion received; Bluetooth closed.",
                    ),
                  (error) =>
                    setMessage(`Sleep delivery unconfirmed: ${String(error)}`),
                )
                .finally(() => {
                  setBusy(false);
                  setConfirmSleep(false);
                });
            },
            !ready || busy,
          )}
          {button("Keep droid awake", () => setConfirmSleep(false))}
        </View>
      )}
      {(busy || !!message) && <Text accessibilityLiveRegion="polite">
        {busy ? "Waiting for droid response…" : message}
      </Text>}
      {Object.values(readings).map((reading) => (
        <View key={reading.label}>
          <Text style={s.title}>{reading.label}</Text>
          <Text selectable>{reading.hex}</Text>
          <Text>
            {new Date(reading.at).toLocaleString()} ·{" "}
            {ready && reading.epoch === epoch && reading.connectionEpoch === snapshot.connectionEpoch
              ? "timestamped snapshot"
              : "STALE · earlier connection/session"}
          </Text>
        </View>
      ))}
      <Text>
        Rename, deep sleep, pending-update queries and firmware installation
        are unavailable here.
      </Text>
    </View>
  );
}
const make_s = (colors: Palette) => {
  return StyleSheet.create({
  card: {
    backgroundColor: colors.panel,
    padding: 10,
    gap: 8,
    borderWidth: 1,
    borderColor: colors.line2,
    borderRadius: 10,
  },
  title: { fontSize: 17, fontWeight: "600" },
  button: {
    minHeight: Platform.OS === "web" ? 32 : 44,
    backgroundColor: colors.panelRaised,
    padding: 8,
    borderRadius: 7,
    justifyContent: "center",
  },
});
};
