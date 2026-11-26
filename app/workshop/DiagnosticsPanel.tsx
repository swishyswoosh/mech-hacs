import {DepotDetails} from "./CompactLayout.tsx";
import { Platform } from "react-native";
import { useColors, useThemedStyles } from "../theme/useColors.ts";
import type { Palette } from "../theme/appearance.ts";
import { inputTheme } from "../theme/appearance.ts";
import React, { useMemo, useState, useEffect } from "react";
import { TextInput, Pressable, ScrollView, StyleSheet } from "react-native";
import { View, Text } from "./primitives.tsx";
import { commandRegistry } from "../../core/index.ts";
import type { ServiceRead } from "../../core/index.ts";
import type { AppPort, AppSnapshot } from "../session/types.ts";

/** Service-session access, audited readbacks and the command capability inventory. */
export function DiagnosticsPanel({
  packets,
  port,
  snapshot,
  beforeService,
  exiting = false,
  registerBack,
}: {
  packets: string[];
  port: AppPort;
  snapshot: AppSnapshot;
  beforeService: () => void;
  exiting?: boolean;
  registerBack?: (handler: () => boolean) => () => void;
}) {
  const colors = useColors();
  const styles = useThemedStyles(make_styles);
  const {inputPalette, inputSurface} = inputTheme(colors);

  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<
    "all" | "recovered" | "unresolved" | "validation-required" | "service"
  >("all");
  const [confirm, setConfirm] = useState<"begin" | "enter" | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [challenge, setChallenge] = useState<{
      challenge: number;
      response: number;
    } | null>(null),
    [index, setIndex] = useState("0");
  const service = snapshot.serviceState ?? "locked";
  useEffect(
    () =>
      registerBack?.(() => {
        if (!confirm) return false;
        setConfirm(null);
        return true;
      }),
    [registerBack, confirm],
  );
  const action = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      const result = await fn();
      setMessage(
        result === undefined ? done : done + " " + JSON.stringify(result),
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const button = (label: string, fn: () => void, disabled = false) => (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || exiting }}
      disabled={disabled || exiting}
      onPress={fn}
      style={[styles.button, disabled && { opacity: 0.5 }]}
    >
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
  const entries = useMemo(
    () =>
      commandRegistry.filter((item) => {
        const matches = (item.key + " " + item.label + " " + item.destination)
          .toLowerCase()
          .includes(query.toLowerCase());
        return (
          matches &&
          (filter === "all" ||
            (filter === "service"
              ? item.serviceSession
              : item.status === filter))
        );
      }),
    [query, filter],
  );
  return (
    <View style={styles.container}>
      <Text accessibilityRole="header" style={styles.heading}>
        Service session
      </Text>
      <Text>
        State: {service}. Opening stops active sources. Motion remains disarmed
        until the session ends. Only audited reads are exposed.
      </Text>
      {button(
        "Review opening service session",
        () => setConfirm("begin"),
        busy ||
          snapshot.state !== "ready" ||
          service !== "locked" ||
          !port.beginServiceSession,
      )}
      {confirm === "begin" && (
        <View style={styles.card}>
          <Text>
            Opening cancels local activities and requests an acknowledged droid
            stop before reading the challenge.
          </Text>
          {button(
            "Stop activities and open service session",
            () => {
              setConfirm(null);
              beforeService();
              void action(async () => {
                const value = await port.beginServiceSession!();
                setChallenge(value);
                return value;
              }, "Challenge and response:");
            },
            busy,
          )}
          {button("Keep current activity", () => setConfirm(null))}
        </View>
      )}
      {service === "readable" && (
        <>
          {challenge && (
            <Text selectable>
              Challenge {challenge.challenge}; calculated response{" "}
              {challenge.response}
            </Text>
          )}
          {button(
            "Review unlocking service session",
            () => setConfirm("enter"),
            busy || !port.enterServiceSession,
          )}
          {confirm === "enter" && (
            <View style={styles.card}>
              <Text>
                Send the recovered challenge response to enter the factory
                service state?
              </Text>
              {button(
                "Enter service state",
                () => {
                  setConfirm(null);
                  void action(
                    () => port.enterServiceSession!(),
                    "Service entry acknowledged.",
                  );
                },
                busy,
              )}
              {button("Cancel", () => setConfirm(null))}
            </View>
          )}
        </>
      )}
      {service !== "locked" && (
        <>
          <Text>
            Read an audited service value. These readbacks do not change
            settings.
          </Text>
          <TextInput
            cursorColor={inputPalette.caret}
            selectionColor={inputPalette.selection}
            placeholderTextColor={inputPalette.placeholder}
            accessibilityLabel="Indexed tuple selector"
            keyboardType="number-pad"
            value={index}
            onChangeText={setIndex}
            style={styles.input}
          />
          <View style={styles.buttons}>
          {(
            [
              "indexed-tuple",
              "test-results",
              "connector-id",
              "motor-id",
            ] as ServiceRead[]
          ).map((kind) =>
            button(
              "Read " + kind,
              () => {
                void action(() => {
                  const n = Number(index);
                  if (
                    kind === "indexed-tuple" &&
                    (!Number.isInteger(n) || n < 0 || n > 1)
                  )
                    throw new Error("Tuple selector must be 0 or 1");
                  return port.readService!(kind, n);
                }, "Service reading:");
              },
              busy || !port.readService,
            ),
          )}
          </View>
          {button(
            "End service session",
            () => {
              void action(async () => {
                await port.endServiceSession!();
                setChallenge(null);
              }, "Session ended; motion remains disarmed.");
            },
            busy || !port.endServiceSession,
          )}
        </>
      )}
      {!!message && (
        <Text accessibilityLiveRegion="polite" selectable>
          {message}
        </Text>
      )}
      <Text accessibilityRole="header" style={styles.heading}>
        Capability inspector
      </Text>
      <Text>
        Recovered command metadata is evidence, not proof of live support.
        Unresolved and restricted operations remain blocked.
      </Text>
      <TextInput
        cursorColor={inputPalette.caret}
        selectionColor={inputPalette.selection}
        placeholderTextColor={inputPalette.placeholder}
        accessibilityLabel="Search capabilities"
        placeholder="Search command, name or panel"
        value={query}
        onChangeText={setQuery}
        style={styles.input}
      />
      <View style={styles.buttons}>
        {(
          [
            "all",
            "recovered",
            "validation-required",
            "unresolved",
            "service",
          ] as const
        ).map((option) => (
          <Pressable
            key={option}
            accessibilityRole="button"
            accessibilityState={{ selected: filter === option }}
            onPress={() => setFilter(option)}
            style={[styles.button, filter === option && styles.active]}
          >
            <Text style={styles.buttonText}>{option}</Text>
          </Pressable>
        ))}
      </View>
      <Text>
        {entries.length} of {commandRegistry.length} recovered commands
      </Text>
      <ScrollView style={styles.registry} nestedScrollEnabled>
        {entries.map((entry) => (
          <View key={entry.key} style={styles.registryRow}>
            <DepotDetails title={`${entry.key} · ${entry.label} · ${entry.status}${entry.restrictedGate ? " · restricted" : ""}${entry.serviceSession ? " · service" : ""}`}>
              <Text selectable>{entry.destination}</Text>
              <Text selectable>Payload: {entry.payloadPolicy} · {entry.status}
                {entry.restrictedGate ? " · restricted" : ""}
                {entry.serviceSession ? " · service session required" : ""}
              </Text>
            </DepotDetails>
          </View>
        ))}
      </ScrollView>
      <DepotDetails title={`Recent protocol packets · ${packets.length}`}>
      <Text>
        Raw packets are local diagnostic data; they are not sent to an online
        service. Select text to copy.
      </Text>
      <ScrollView style={styles.packets} nestedScrollEnabled>
        {packets.length ? (
          packets.map((packet, index) => (
            <Text selectable key={index} style={styles.packet}>
              {packet}
            </Text>
          ))
        ) : (
          <Text>No packets received in this session.</Text>
        )}
      </ScrollView>
      </DepotDetails>
    </View>
  );
}
const make_styles = (colors: Palette) => {
  const {inputSurface} = inputTheme(colors);
  return StyleSheet.create({
  container: { gap: 8 },
  heading: { fontSize: 18, fontWeight: "700", color: colors.text },
  title: { fontWeight: "600", color: colors.text },
  input: {
    ...inputSurface,
    minHeight: Platform.OS === "web" ? 32 : 44,
    borderWidth: 1,
    borderColor: colors.line2,
    padding: 8,
    borderRadius: 5,
    fontSize: 14,
  },
  buttons: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  button: {
    minHeight: Platform.OS === "web" ? 32 : 44,
    padding: 8,
    justifyContent: "center",
    backgroundColor: colors.panelRaised,
    borderRadius: 6,
  },
  active: {
    backgroundColor: colors.tint,
    borderColor: colors.primary,
    borderWidth: 2,
  },
  buttonText: { color: colors.text, fontWeight: "600" },
  card: {
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.line2,
    borderRadius: 8,
    padding: 8,
    gap: 4,
  },
  registry: {maxHeight: 240, borderWidth: 1, borderColor: colors.line2, borderRadius: 6},
  registryRow: {paddingHorizontal: 8, borderBottomWidth: 1, borderBottomColor: colors.line},
  packets: { maxHeight: 220, backgroundColor: colors.panel, padding: 12 },
  packet: {
    fontFamily: "monospace",
    fontSize: 12,
    color: colors.text,
    marginVertical: 3,
  },
});
};
