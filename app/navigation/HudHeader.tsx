import { useColors } from "../theme/useColors.ts";
import {readOptionalPreference} from '../library/optionalPreference.ts';
import { Tooltip } from "../components/Tooltip.tsx";
import { BatteryStatus } from "../components/BatteryStatus.tsx";
import type { ControllerSession } from "../session/ControllerSession.ts";
import React from "react";
import {
  View,
  Pressable,
  ScrollView,
  useWindowDimensions,
  Platform,
} from "react-native";
import type { Route } from "./Navigator.ts";
import type { SessionSnapshot } from "../session/types.ts";
import { HudText } from "../theme/Theme.tsx";
import { Icon } from "../components/Icon.tsx";
import { HudButton, StatusPill, StopButton } from "../components/Hud.tsx";
export const titles: Record<Route, string> = {
  launch: "Launch",
  home: "Home",
  cockpit: "Cockpit",
  sounds: "Sounds",
  animations: "Animations",
  lights: "Lights",
  experiences: "Experiences",
  paths: "Paths",
  settings: "Settings",
  depot: "Depot",
};
export function HudHeader({
  route,
  session,
  snapshot,
  paused,
  depot,
  notes,
  navigate,
  onStop,
  onNotes,
  appearance,
  onToggleAppearance,
}: {
  route: Route;
  session: ControllerSession;
  snapshot: SessionSnapshot;
  paused: boolean;
  depot: boolean;
  notes: number;
  navigate: (route: Route) => void;
  onStop: () => void;
  onNotes: () => void;
  appearance: "light" | "dark";
  onToggleAppearance: () => void;
}) {
  const colors = useColors();

  const { width, height } = useWindowDimensions();
  const low = height < 600;
  const iconStyle = low ? {minHeight:44, minWidth:44, height:44, width:44, paddingHorizontal:0} : undefined;
  const identity = snapshot.connection.droidId;
  const nameRead = identity ? readOptionalPreference(session, `droidName.v1.${encodeURIComponent(identity)}`, 'droid name') : {value: null};
  const droidLabel = nameRead.value
    || snapshot.connection.droidName || "R2 CONTROL";
  const connected = !["disconnected", "sleeping", "awaiting-restart"].includes(
    snapshot.state,
  );
  const status = paused && snapshot.safety.state !== "failed"
    ? "paused"
    : snapshot.safety.state;
  const navItems: Route[] = [
    "cockpit",
    "sounds",
    "animations",
    "lights",
    "experiences",
    "paths",
    ...(depot ? ["depot" as Route] : []),
  ];
  return (
    <>
      {!!nameRead.error && <HudText accessibilityRole="alert" style={{fontSize: 12}}>{nameRead.error}</HudText>}
      <View
        style={{
          zIndex: 10,
          paddingHorizontal: low ? 6 : width < 600 ? 8 : 20,
          paddingVertical: low ? 0 : 4,
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          gap: low ? 4 : width < 600 ? 4 : 10,
          borderBottomWidth: 1,
          borderColor: colors.line2,
          backgroundColor: colors.panel,
        }}
      >
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            alignItems: "center",
            gap: width < 600 ? 4 : 10,
            flex: width < 600 && Platform.OS === "web" ? undefined : 1,
            width: width < 600 && Platform.OS === "web" ? "100%" : undefined,
            minHeight: 44,
          }}
        >
          {(route !== "launch" || connected) && (
            <HudButton
              label="Go Home"
              icon="home"
              compact
              style={iconStyle}
              onPress={() => navigate("home")}
            />
          )}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <HudButton
              label="Droid connections"
              icon="bluetooth"
              compact
              style={iconStyle}
              onPress={() => navigate("launch")}
            />
            {(
              <HudText
                kind="mono"
                numberOfLines={1}
                style={{
                  fontSize: 11,
                  maxWidth: low ? 96 : width < 600 ? 72 : 170,
                  flexShrink: 1,
                  letterSpacing: 1,
                }}
              >
                {droidLabel}
              </HudText>
            )}
          </View>
          <StatusPill
            state={status}
            activity={snapshot.activity.label}
            onPress={status === "disconnected" ? () => navigate("launch") : undefined}
          />
          <View style={{ flex: 1 }} />
          {(["ready", "paused", "stopping"].includes(snapshot.state) ||
            (snapshot.state === "failed" && !!snapshot.battery)) && (
            <BatteryStatus
              session={session}
              snapshot={snapshot}
              onStop={onStop}
            />
          )}
        </View>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 4,
            width: width < 600 && Platform.OS === "web" ? "100%" : undefined,
          }}
        >
          {notes > 0 && (
            <Tooltip label={`Comlink messages (${notes})`}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Notes (${notes})`}
              onPress={onNotes}
              style={({ pressed }) => ({
                minWidth: 56,
                minHeight: low ? 44 : 56,
                paddingHorizontal: 6,
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                gap: 2,
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <Icon name="notes" size={24} />
              <View
                style={{
                  minWidth: 22,
                  height: 18,
                  paddingHorizontal: 6,
                  borderRadius: 9,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: colors.primary,
                }}
              >
                <HudText
                  kind="mono"
                  style={{ fontSize: 11, lineHeight: 16, color: colors.onPrimary }}
                >
                  {notes}
                </HudText>
              </View>
            </Pressable>
            </Tooltip>
          )}
          {(
            <HudButton
              label={
                appearance === "dark"
                  ? "Switch to light mode"
                  : "Switch to dark mode"
              }
              icon={appearance === "dark" ? "sun" : "moon"}
              compact
              style={iconStyle}
              onPress={onToggleAppearance}
            />
          )}
          <HudButton
            label="Open Settings"
            icon="settings"
            compact
            style={iconStyle}
            onPress={() => navigate("settings")}
          />
          {(connected || route !== "launch") && (
            <StopButton
              onPress={onStop}
              disabled={!connected}
              compact
              prominent={connected && (["cockpit", "animations", "paths"].includes(route) || snapshot.safety.motionArmed || !!snapshot.activity.sources.automation || !!snapshot.activity.sources.experience || ["failed", "stopping"].includes(snapshot.safety.state))}
              stopping={snapshot.safety.state === "stopping"}
            />
          )}
        </View>
      </View>
      {route !== "launch" && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          accessibilityRole="tablist"
          accessibilityLabel="Droid screens"
          style={{
            flexGrow: 0,
            backgroundColor: colors.bg,
          }}
          contentContainerStyle={{
            flexDirection: "row",
            gap: low ? 4 : width < 600 ? 0 : 4,
            paddingHorizontal: low ? 4 : width < 600 ? 8 : 14,
            paddingVertical: low ? 1 : 0,
            backgroundColor: colors.bg,
          }}
        >
          {navItems.map((item) => (
            <Pressable
              key={item}
              accessibilityRole="tab"
              accessibilityLabel={titles[item]}
              accessibilityState={{ selected: route === item }}
              aria-selected={route === item}
              onPress={() => navigate(item)}
              style={{
                minHeight: low ? 32 : 56,
                paddingHorizontal: low ? 7 : 12,
                minWidth: low ? 44 : 56,
                alignItems: "center",
                justifyContent: "center",
                borderBottomWidth: 2,
                ...(Platform.OS === "android" ? {
                  borderWidth: 1,
                  borderRadius: 6,
                  backgroundColor: route === item ? colors.tint : colors.panel,
                } : {}),
                borderColor: route === item ? colors.primary : Platform.OS === "android" ? colors.line2 : "transparent",
              }}
            >
              <HudText
                kind="heading"
                style={{
                  fontSize: low ? 12 : width < 600 ? 13 : 15,
                  ...(low ? {letterSpacing: 0.8} : {}),
                  color:
                    route === item
                      ? colors.primary
                      : item === "depot"
                        ? colors.caution
                        : colors.textMuted,
                }}
              >
                {titles[item]}
              </HudText>
            </Pressable>
          ))}
        </ScrollView>
      )}
    </>
  );
}
