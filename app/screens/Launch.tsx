import { useColors } from "../theme/useColors.ts";
import { Icon } from "../components/Icon.tsx";
import { R2Figure } from "../components/R2Figure.tsx";
import React, { useEffect, useState } from "react";
import { View, Pressable, useWindowDimensions, Platform } from "react-native";
import type { ControllerSession } from "../session/ControllerSession.ts";
import type { SessionSnapshot } from "../session/types.ts";
import { HudText } from "../theme/Theme.tsx";
import { HudButton } from "../components/Hud.tsx";
import { Radar, HyperspaceStreaks } from "../components/Space.tsx";
import {readOptionalPreference} from '../library/optionalPreference.ts';
export function Launch({
  session,
  snapshot,
  onExplore,
  notify,
}: {
  session: ControllerSession;
  snapshot: SessionSnapshot;
  onExplore: () => void;
  notify: (message: string) => void;
}) {
  const colors = useColors();

  const [droids, setDroids] = useState<Array<{ id: string; name: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [sleeping, setSleeping] = useState(false);
  const { width, height } = useWindowDimensions();
  const low = Platform.OS === "android" && height < 600;
  const stacked = width < 700 && !low;
  const radarSize = low ? Math.max(160, Math.min(210, height - 150)) : 250;
  const connected = ["ready", "paused", "stopping", "failed", "sleep-requested"].includes(snapshot.state) && !!snapshot.connection.droidId;
  const waitingForSleep = sleeping || snapshot.state === "sleep-requested";
  const connecting = snapshot.safety.state === "connecting" || busy || waitingForSleep;
  const returnLabel = connected ? "Return to controls" : "Explore controls";
  const connectedId = connected ? snapshot.connection.droidId : undefined;
  const visibleDroids = connectedId && !droids.some(droid => droid.id === connectedId)
    ? [{id: connectedId, name: snapshot.connection.droidName || "Connected droid"}, ...droids]
    : droids;
  // The display name is shared with Home; the advertised BLE identity is unchanged.
  const nameReads = new Map(
    visibleDroids.map(({id}) => [id, readOptionalPreference(session, `droidName.v1.${encodeURIComponent(id)}`, 'droid name')])
  );
  const nameError = [...nameReads.values()].find(read => read.error)?.error;
  const friendlyName = (id: string | undefined, fallback: string) =>
    (id && nameReads.get(id)?.value) || fallback;
  const disconnect = async () => {
    if (connecting || !connected || !snapshot.safety.canControl) return;
    setSleeping(true);
    try { await session.sleep(); }
    catch (error) { notify(`Disconnect incomplete: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setSleeping(false); }
  };
  useEffect(() => {
    let current = true;
    void session.authorizedDroids().then(
      (value) => {
        if (current) setDroids(value);
      },
      (error) => {
        if (current) notify(String(error));
      },
    );
    return () => {
      current = false;
    };
  }, [session, snapshot.state]);
  const connect = async (id?: string) => {
    if (connecting || (connected && id === snapshot.connection.droidId)) return;
    setBusy(true);
    try {
      const services = (
        session.loadPreference("services") ||
        "00010001-574f-4f20-5370-6865726f2121,00020001-574f-4f20-5370-6865726f2121"
      )
        .split(/[\s,]+/)
        .filter(Boolean);
      if (id) await session.reconnectDroid(id, services);
      else await session.connect(services);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <View
      nativeID="launch-screen"
      style={{
        width: "100%",
        maxWidth: 1000,
        alignSelf: "center",
        paddingVertical: low ? 4 : 24,
        gap: low ? 8 : 24,
      }}
    >
      {!!nameError && <HudText accessibilityRole="alert">{nameError}</HudText>}
      <HyperspaceStreaks />
      <View
        style={{
          flexDirection: stacked ? "column" : "row",
          gap: low ? 16 : 40,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <View
          style={{
            flex: stacked ? undefined : 1,
            alignItems: "center",
            gap: low ? 6 : 16,
          }}
        >
          <View
            style={{
              width: low ? radarSize : 280,
              height: low ? radarSize : 280,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Radar size={radarSize} />
            <View style={{ position: "absolute", alignSelf: "center" }}>
              <HudButton
                label={waitingForSleep ? "Sleeping…" : connecting ? "Please wait…" : connected ? "Switch droid" : session.mode === "remote" ? "Connect" : "Find"}
                icon="bluetooth"
                primary
                disabled={connecting}
                onPress={() => void connect()}
              />
            </View>
          </View>
          <HudText kind="mono" muted style={{ fontSize: 11, letterSpacing: 2 }}>
            {waitingForSleep ? "COMLINK · SLEEP REQUESTED" : connecting
              ? "COMLINK · SCANNING FOR DROIDS"
              : connected ? "COMLINK · CONNECTED" : "COMLINK · READY TO CONNECT"}
          </HudText>
        </View>
        <View
          style={{
            flex: stacked ? undefined : 1,
            width: stacked ? "100%" : undefined,
            gap: low ? 6 : 14,
            maxWidth: 460,
          }}
        >
          <HudText
            kind="heading"
            accessibilityRole="header"
            style={{ fontSize: 17, color: colors.textMuted }}
          >
            Saved droids
          </HudText>
          {visibleDroids.map((droid) => {
            const hardwareName = droid.name.replace(/ \(Desktop Bluetooth\)$/, "");
            const name = friendlyName(droid.id, hardwareName);
            const isConnected = connected && droid.id === connectedId;
            return (
              <View
                key={droid.id}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  borderWidth: 1,
                  borderColor: colors.line2,
                  borderRadius: 10,
                  backgroundColor: colors.panel,
                  paddingRight: isConnected ? 6 : 0,
                  opacity: connecting ? 0.5 : 1,
                }}
              >
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={isConnected ? `Connected to ${name}` : `${connected ? "Switch to" : "Connect"} ${name}`}
                  accessibilityState={{ disabled: connecting || isConnected }}
                  disabled={connecting || isConnected}
                  onPress={() => void connect(droid.id)}
                  style={({ pressed }) => ({
                    flex: 1,
                    minHeight: low ? 60 : 80,
                    padding: 12,
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 12,
                    borderRadius: 10,
                    opacity: pressed ? 0.7 : 1,
                  })}
                >
                  <R2Figure size={50} />
                  <View style={{ flex: 1, gap: 6 }}>
                    <HudText kind="heading" style={{ fontSize: 21 }}>
                      {name}
                    </HudText>
                    <HudText kind="mono" muted style={{ fontSize: 10 }}>
                      {name !== hardwareName ? `${hardwareName} · ` : ""}
                      {session.mode === "remote" ? "LOCAL SERVICE" : droid.id.startsWith("desktop:")
                        ? "DESKTOP BLUETOOTH"
                        : Platform.OS === "android" ? "SAVED COMLINK · ANDROID" : "SAVED COMLINK · CHROME"}
                    </HudText>
                  </View>
                  {!isConnected && <Icon name="chevron" size={18} />}
                </Pressable>
                {isConnected && (
                  <HudButton
                    label={`Disconnect ${name}`}
                    icon="power"
                    compact
                    disabled={connecting || !snapshot.safety.canControl}
                    onPress={() => void disconnect()}
                    style={{width: 44, minHeight: 44, flexShrink: 0}}
                  />
                )}
              </View>
            );
          })}
          {!visibleDroids.length && (
            <HudText muted>{session.mode === "remote" ? "No enrolled droids available." : "No saved droids yet. Use Find to add one."}</HudText>
          )}
          {low && <View style={{alignSelf:"flex-start"}}><HudButton label={returnLabel} icon="home" onPress={onExplore} /></View>}
          {snapshot.state === "failed" && (
            <HudText
              accessibilityLiveRegion="polite"
              style={{ color: colors.danger, lineHeight: 22 }}
            >
              {snapshot.detail}
            </HudText>
          )}
        </View>
      </View>
      {!low && <View style={{ alignSelf: "center" }}>
        <HudButton label={returnLabel} icon="home" onPress={onExplore} />
      </View>}
    </View>
  );
}
