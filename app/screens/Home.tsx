import { DroidName } from "../home/DroidName.tsx";
import type {ControllerSession} from "../session/ControllerSession.ts";
import type { FigureSnapshot } from "../components/FigureState.ts";
import React, { useState } from "react";
import { View, useWindowDimensions, Platform } from "react-native";
import type { SessionSnapshot } from "../session/types.ts";
import type { Route } from "../navigation/Navigator.ts";
import { useColors } from "../theme/useColors.ts";
import { HudButton, Tile, StopButton } from "../components/Hud.tsx";
import { R2Figure } from "../components/R2Figure.tsx";
export function Home({
  availableHeight,
  session,
  snapshot,
  figure,
  depot,
  onNavigate,
  onDome,
  onStance,
  onStop,
}: {
  availableHeight?: number;
  session: ControllerSession;
  snapshot: SessionSnapshot;
  figure: FigureSnapshot;
  depot: boolean;
  onNavigate: (route: Route) => void;
  onDome: () => void;
  onStance: () => void;
  onStop: () => void;
}) {
  const { width, height } = useWindowDimensions(),
    nativeLandscape = Platform.OS === "android" && width > height,
    narrow = width < 900 && !nativeLandscape,
    short = !narrow && height < 600;
  const colors = useColors();
  const driveAvailable = snapshot.state === "ready";
  const [hologramWidth, setHologramWidth] = useState(280);
  const [nameHeight, setNameHeight] = useState(0);
  const hasName = !!snapshot.connection.droidId && !["disconnected", "sleeping", "awaiting-restart"].includes(snapshot.state);
  const figureSize = nativeLandscape
    ? Math.max(107, Math.min(140, hologramWidth - 96, ((availableHeight ?? height - 120) - (hasName ? nameHeight : 0) - 56) / 1.24))
    : Math.max(100, Math.min(short ? 140 : 210, hologramWidth - 96));
  const tile = (
    title: string,
    subtitle: string,
    icon: React.ComponentProps<typeof Tile>["icon"],
    route: Route,
    caution = false,
  ) => (
    <Tile
      title={title}
      subtitle={subtitle}
      icon={icon}
      onPress={() => onNavigate(route)}
      caution={caution}
      badge={route === "experiences" ? snapshot.activity.label : undefined}
    />
  );
  const hologram = (
    <View
      nativeID="home-hologram"
      onLayout={(event) => setHologramWidth(event.nativeEvent.layout.width)}
      style={{
        alignItems: "center",
        justifyContent: "center",
        gap: nativeLandscape ? 4 : 8,
        width: nativeLandscape ? 240 : narrow ? "100%" : 320,
        flexShrink: 0,
      }}
    >
      {hasName && snapshot.connection.droidId && <View style={{width:"100%"}} onLayout={(event) => setNameHeight(event.nativeEvent.layout.height)}><DroidName
        key={snapshot.connection.droidId} session={session} identity={snapshot.connection.droidId}
        defaultName={snapshot.connection.droidName || "R2-D2"}/></View> }
      <R2Figure
        size={figureSize}
        compact={nativeLandscape}
        observedAngle={snapshot.telemetry.observedDomeAngle}
        lights={figure.lights}
        stance={figure.stance}
        onDome={onDome}
        onLights={() => onNavigate("lights")}
        onStance={onStance}
      />
      <View style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
        <HudButton
          label="Drive"
          icon="drive"
          primary
          disabled={!driveAvailable}
          style={{ ...(!driveAvailable && {backgroundColor: colors.textMuted, borderColor: colors.textMuted}), minWidth: nativeLandscape ? 110 : narrow ? 120 : short ? 130 : 150, minHeight: nativeLandscape ? 44 : 64 }}
          onPress={() => onNavigate("cockpit")}
        />
        <StopButton
          prominent={snapshot.safety.motionArmed}
          compact={short || narrow}
          onPress={onStop}
          stopping={snapshot.safety.state === "stopping"}
        />
      </View>
    </View>
  );
  return (
    <View
      nativeID="home-screen"
      style={{
        paddingVertical: short ? 0 : 12,
        gap: 16,
        width: "100%",
        maxWidth: 1100,
        alignSelf: "center",
      }}
    >
      {narrow && hologram}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: nativeLandscape ? 8 : short ? 16 : 28,
        }}
      >
        <View style={{ flex: 1, gap: short ? 8 : 14 }}>
          {tile("Cockpit", "Drive · dome · soundboard", "drive", "cockpit")}
          {tile("Sounds", "Chirps · favorites · soundboard", "sound", "sounds")}
          {tile(
            "Animations",
            "Emote · Patrol · Movie",
            "animation",
            "animations",
          )}
        </View>
        {!narrow && hologram}
        <View style={{ flex: 1, gap: short ? 8 : 14 }}>
          {tile("Lights", "Panels · color · presets", "lights", "lights")}
          {tile(
            "Experiences",
            "Patrol & sequences",
            "route",
            "experiences",
          )}
          {tile("Paths", "Draw & run a route", "route", "paths")}
        </View>
      </View>
    </View>
  );
}
