import { useColors, useThemedStyles } from "../theme/useColors.ts";
import type { Palette } from "../theme/appearance.ts";
import React, { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Platform, AppState } from "react-native";
import { View, Text } from "../workshop/primitives.tsx";
import { ExternalDriveSession } from "../../core/externalInput.ts";
import type {
  ExternalInputMode,
  ExternalInputSample,
} from "../../core/externalInput.ts";
import { startExternalInput } from "../platform/externalInputPlatform";
type Props = {
  enabled: boolean;
  connectionEpoch: number;
  speed: number;
  allowed: () => boolean;
  onSelect: () => void;
  onBegin: () => boolean;
  onPoint: (point: [number, number]) => void;
  onRelease: () => void;
  registerCancel: (handler: () => void) => () => void;
  registerManualRevoke: (handler: () => void) => () => void;
};
export function ExternalSteering(props: Props) {
  const colors = useColors();
  const s = useThemedStyles(make_s);

  const [session] = useState(() => new ExternalDriveSession()),
    [active, setActive] = useState(false),
    [busy, setBusy] = useState(false),
    [status, setStatus] = useState(
      "Inactive; external input never restores after reconnect.",
    );
  const latest = useRef(props);
  latest.current = props;
  const generation = useRef(0),
    stopSampling = useRef<(() => void) | undefined>(undefined),
    driving = useRef(false),
    mounted = useRef(true);
  const cleanupSampling = () => {
    const stop = stopSampling.current;
    stopSampling.current = undefined;
    try {
      stop?.();
      return "";
    } catch (error) {
      return ` Input cleanup error: ${String(error)}`;
    }
  };
  const revoke = (reason: string, notify = true) => {
    generation.current++;
    session.revoke(reason);
    const wasDriving = driving.current;
    driving.current = false;
    const cleanup = cleanupSampling();
    if (wasDriving && notify) latest.current.onRelease();
    if (mounted.current) {
      setActive(false);
      setBusy(false);
      setStatus(reason + cleanup);
    }
  };
  const output = () => {
    const current = latest.current;
    session.observeSession(
      current.connectionEpoch,
      current.enabled && current.allowed(),
    );
    const demand = session.demand(Date.now(), current.speed);
    if (!demand.active) {
      cleanupSampling();
      if (driving.current) current.onRelease();
      driving.current = false;
      setActive(false);
      setStatus(demand.reason);
      return;
    }
    if (demand.driving) {
      if (!driving.current) {
        if (!current.onBegin()) {
          revoke(
            "Controls unavailable; activate again after validating this connection.",
          );
          return;
        }
        driving.current = true;
      }
      current.onPoint(demand.point);
    } else if (driving.current) {
      current.onRelease();
      driving.current = false;
    }
    setActive(true);
    setStatus(
      `${demand.reason} · ${demand.driving ? "deadman held" : "not driving"} · wheel demand ${demand.wheels.map((value) => value.toFixed(2)).join(", ")}`,
    );
  };
  const activate = (mode: ExternalInputMode) => {
    if (busy) return;
    revoke("Preparing external input…");
    if (!latest.current.enabled || !latest.current.allowed()) {
      setStatus("Connect and validate wheel mapping before activation.");
      return;
    }
    latest.current.onSelect();
    const intent = ++generation.current;
    let activated = false;
    const pending: ExternalInputSample[] = [];
    setBusy(true);
    void (async () => {
      try {
        const stop = await startExternalInput(
          mode,
          (sample) => {
            if (intent !== generation.current) return;
            if (!activated) {
              pending.push(sample);
              return;
            }
            session.accept(sample);
            output();
          },
          (reason) => {
            if (intent === generation.current) revoke(reason);
          },
        );
        if (
          intent !== generation.current ||
          !latest.current.enabled ||
          !latest.current.allowed()
        ) {
          stop();
          return;
        }
        stopSampling.current = stop;
        session.activate(mode, latest.current.connectionEpoch, Date.now());
        activated = true;
        for (const sample of pending) session.accept(sample);
        setActive(true);
        setStatus(
          mode === "tilt"
            ? "Waiting for neutral phone orientation…"
            : "Release left shoulder, then hold it while steering.",
        );
        output();
      } catch (error) {
        if (intent === generation.current)
          revoke(error instanceof Error ? error.message : String(error));
      } finally {
        if (intent === generation.current) setBusy(false);
      }
    })();
  };
  useEffect(
    () =>
      props.registerCancel(() =>
        revoke("Input revoked by STOP or source replacement", false),
      ),
    [props.registerCancel],
  );
  useEffect(
    () =>
      props.registerManualRevoke(() =>
        revoke("Another manual input was selected"),
      ),
    [props.registerManualRevoke],
  );
  useEffect(() => {
    if (!props.enabled)
      revoke(
        "Input revoked; a new ready, validated session is required.",
        false,
      );
  }, [props.enabled, props.connectionEpoch]);
  useEffect(() => {
    mounted.current = true;
    const timer = setInterval(() => {
      if (session.mode) output();
    }, 50);
    const app = AppState.addEventListener("change", (state) => {
      if (state !== "active")
        revoke("Input revoked because the app lost foreground.");
    });
    return () => {
      mounted.current = false;
      clearInterval(timer);
      app.remove();
      revoke("External input panel closed.");
    };
  }, [session]);
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const blur = () => revoke("External input revoked on window focus loss.");
    const visibility = () => {
      if (document.hidden) blur();
    };
    const outside = (event: Event) => {
      const target = event.target;
      if (
        target instanceof Element &&
        (target.closest("#external-drive-controls") ||
          target.closest('[data-drive-speed-control="true"]'))
      )
        return;
      if (session.mode)
        revoke(
          "External input revoked because focus or pointer moved to another control.",
        );
    };
    window.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", visibility);
    document.addEventListener("focusin", outside, true);
    document.addEventListener("pointerdown", outside, true);
    return () => {
      window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", visibility);
      document.removeEventListener("focusin", outside, true);
      document.removeEventListener("pointerdown", outside, true);
    };
  }, [session]);
  const button = (title: string, run: () => void) => (
    <Pressable
      accessibilityRole="button"
      disabled={!props.enabled || busy}
      accessibilityState={{ disabled: !props.enabled || busy }}
      onPress={run}
      style={[s.button, (!props.enabled || busy) && { opacity: 0.55 }]}
    >
      <Text style={{ color: colors.text }}>{title}</Text>
    </Pressable>
  );
  const hold = (held: boolean) => {
    session.setTiltDeadman(held);
    output();
  };
  return (
    <View nativeID="external-drive-controls" style={s.card}>
      <Text style={s.title}>
        External steering · explicit session activation
      </Text>
      <Text>
        Gamepad: standard left stick, left shoulder button as held deadman.
        Release the shoulder once after activation, then hold it to drive.
        Unmapped controllers are rejected in Chrome.
      </Text>
      {button("Activate gamepad for this session", () => activate("gamepad"))}
      <Text>
        Phone tilt: activation captures neutral orientation; ±30° deflection
        maps to the same normalized arcade mixer and speed cap. Hold the deadman
        below while tilting. Phone motion is not droid telemetry.
      </Text>
      {button("Request phone motion and activate tilt", () => activate("tilt"))}
      {session.mode === "tilt" && (
        <Pressable
          accessibilityRole="button"
          disabled={!active}
          onPressIn={() => hold(true)}
          onPressOut={() => hold(false)}
          onBlur={() => hold(false)}
          style={s.deadman}
        >
          <Text style={{ color: colors.text }}>
            Hold phone tilt deadman to drive
          </Text>
        </Pressable>
      )}
      <Pressable
        accessibilityRole="button"
        onPress={() => revoke("External input deactivated.")}
        style={s.button}
      >
        <Text style={{ color: colors.text }}>Deactivate external input</Text>
      </Pressable>
      <Text accessibilityLiveRegion="polite">
        {busy ? "Checking input capability / permission…" : status}
      </Text>
      <Text>
        Deadman release, stale input, disconnection, another manual control,
        panel/menu changes, STOP, backgrounding and focus loss revoke drive
        demand. Reactivation is always explicit. Both clients require fresh
        hardware gamepad reports. Chrome rejects missing or frozen hardware
        timestamps. Controllers that update only when controls change may stop
        during a stationary hold and require explicit reactivation; cached state
        is never repeated as fresh input.
      </Text>
    </View>
  );
}
const make_s = (colors: Palette) => {
  return StyleSheet.create({
  card: { gap: 10, marginVertical: 12 },
  title: { fontSize: 18, fontWeight: "600" },
  button: {
    minHeight: 48,
    padding: 12,
    backgroundColor: colors.panelRaised,
    borderRadius: 6,
    justifyContent: "center",
  },
  deadman: {
    minHeight: 64,
    padding: 12,
    backgroundColor: colors.panelRaised,
    borderRadius: 6,
    justifyContent: "center",
  },
});
};
