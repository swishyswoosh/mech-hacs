import { useColors, useThemedStyles } from "../theme/useColors.ts";
import type { Palette } from "../theme/appearance.ts";
import React from "react";
import { Tooltip } from "./Tooltip.tsx";
import { View, Pressable, StyleSheet, useWindowDimensions, Platform } from "react-native";
import type { ViewProps } from "react-native";
import { HudText } from "../theme/Theme.tsx";
import { Icon } from "./Icon.tsx";
import type { IconName } from "./Icon.tsx";
import type { SafetyState } from "../session/types.ts";
import { statusLabel } from "../navigation/Navigator.ts";
export function HudPanel({
  style,
  children,
  active = false,
  ...props
}: ViewProps & { active?: boolean }) {
  const colors = useColors();
  const s = useThemedStyles(make_s);

  return (
    <View {...props} style={[s.panel, style]}>
      {children}
      {active && (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: -1,
            top: -1,
            width: 16,
            height: 16,
            borderTopWidth: 2,
            borderLeftWidth: 2,
            borderColor: colors.primary,
            borderTopLeftRadius: 10,
          }}
        />
      )}
      {active && (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            right: -1,
            bottom: -1,
            width: 16,
            height: 16,
            borderBottomWidth: 2,
            borderRightWidth: 2,
            borderColor: colors.primary,
            borderBottomRightRadius: 10,
          }}
        />
      )}
    </View>
  );
}
export function HudButton({
  label,
  onPress,
  icon,
  disabled = false,
  primary = false,
  selected,
  caution = false,
  compact = false,
  style,
}: {
  label: string;
  onPress: () => void;
  icon?: IconName;
  disabled?: boolean;
  primary?: boolean;
  selected?: boolean;
  caution?: boolean;
  compact?: boolean;
  style?: ViewProps["style"];
}) {
  const colors = useColors();
  const s = useThemedStyles(make_s);

  const {width, height} = useWindowDimensions();
  const low = Platform.OS === "android" && width > height && height < 600;
  const buttonStyle = StyleSheet.flatten(style);
  const small = low && !compact && typeof buttonStyle?.minHeight === "number" && buttonStyle.minHeight <= 40;
  const color = primary
    ? colors.onPrimary
    : caution
      ? colors.caution
      : colors.primary;
  return (
    <Tooltip label={compact ? label : undefined}>
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, selected }}
      {...(Platform.OS === "web" && selected !== undefined ? {"aria-pressed": selected} : {})}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        s.button,
        low && {minHeight:44, paddingVertical:6, paddingHorizontal:12},
        compact && {
          width: 56,
          paddingHorizontal: 0,
          paddingVertical: 0,
          backgroundColor: "transparent",
          borderColor: "transparent",
        },
        primary && {
          backgroundColor: colors.primary,
          borderColor: colors.primary,
        },
        caution && { borderColor: colors.caution },
        disabled && { opacity: 0.45 },
        pressed && { opacity: 0.7 },
        style,
        low && {minHeight: small ? 36 : 44, paddingVertical: compact ? 0 : 6},
      ]}
    >
      {icon && <Icon name={icon} color={color} />}
      {!compact && (
        <HudText
          kind="heading"
          style={{ fontSize: small ? 12 : low ? 13 : 16, color, textAlign: "center" }}
        >
          {label}
        </HudText>
      )}
    </Pressable>
    </Tooltip>
  );
}
export function Tile({
  title,
  subtitle,
  icon,
  onPress,
  badge,
  caution = false,
}: {
  title: string;
  subtitle: string;
  icon: IconName;
  onPress: () => void;
  badge?: string;
  caution?: boolean;
}) {
  const colors = useColors();
  const s = useThemedStyles(make_s);

  const { width, height } = useWindowDimensions();
  const compact = width < 600;
  const dense = width > height && height < 600;
  const nativeDense = dense && Platform.OS === "android";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={onPress}
      style={({ pressed }) => [
        s.tile,
        dense && { minHeight: 72, padding: 8, gap: 10 },
        nativeDense && {minHeight:52, padding:6, gap:6},
        compact && {
          flexDirection: "column",
          alignItems: "flex-start",
          padding: 12,
          minHeight: 96,
          gap: 6,
        },
        pressed && {
          backgroundColor: colors.panelRaised,
          borderColor: colors.primary,
        },
        caution && { borderColor: colors.line2 },
      ]}
    >
      <View style={[s.tileIcon, nativeDense && {width:32,height:32}]}>
        <Icon
          name={icon}
          color={caution ? colors.caution : colors.primary}
          size={24}
        />
      </View>
      <View style={{ flex: 1, gap: dense ? 3 : 5 }}>
        <HudText
          kind="heading"
          style={{
            fontSize: nativeDense ? 14 : dense ? 18 : compact ? 18 : 20,
            ...(nativeDense ? {letterSpacing:0.8} : {}),
            color: caution ? colors.caution : colors.text,
          }}
        >
          {title}
        </HudText>
        {!nativeDense && <HudText
          muted
          style={{ fontSize: dense ? 11 : 12, lineHeight: dense ? 14 : 18 }}
        >
          {subtitle}
        </HudText>}
        {!!badge && (
          <HudText kind="mono" style={{ color: colors.primary }}>
            {badge}
          </HudText>
        )}
      </View>
      {!compact && <Icon name="chevron" size={17} color={colors.textMuted} />}
    </Pressable>
  );
}
export function StatusPill({
  state,
  activity = "",
  onPress,
}: {
  state: SafetyState;
  activity?: string;
  onPress?: () => void;
}) {
  const colors = useColors();
  const s = useThemedStyles(make_s);

  const {width,height} = useWindowDimensions();
  const low = Platform.OS === "android" && width > height && height < 600;
  const color =
    state === "ready-disarmed"
      ? colors.ok
      : state === "failed" || state === "stopping"
        ? colors.danger
        : state === "paused"
          ? colors.caution
          : state === "armed" || state === "busy"
            ? colors.primary
            : colors.textMuted;
  const content = (
    <>
      <View style={[s.dot, { backgroundColor: color }]} />
      <HudText kind="heading" style={{ fontSize: low ? 12 : 15, color, letterSpacing: 1 }}>
        {statusLabel(state, activity)}
      </HudText>
    </>
  );
  if (onPress) return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="OFFLINE: Find a droid"
      accessibilityLiveRegion="polite"
      onPress={onPress}
      style={[s.pill, { borderColor: color, minHeight: 44 }]}
    >
      {content}
    </Pressable>
  );
  return (
    <View
      accessibilityLiveRegion="polite"
      style={[s.pill, { borderColor: color }]}
    >
      {content}
    </View>
  );
}
export function StopButton({
  onPress,
  stopping = false,
  disabled = false,
  compact = false,
  prominent = false,
}: {
  onPress: () => void;
  stopping?: boolean;
  disabled?: boolean;
  compact?: boolean;
  prominent?: boolean;
}) {
  const {height} = useWindowDimensions();
  const low = Platform.OS === "android" && height < 600;
  const colors = useColors();
  const s = useThemedStyles(make_s);

  return (
    <Tooltip label={stopping ? "Stopping motion" : "Stop motion"}>
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="STOP"
      accessibilityState={{ busy: stopping, disabled }}
      disabled={disabled}
      aria-busy={stopping}
      onPress={onPress}
      style={({ pressed }) => [
        s.stop,
        !prominent && { backgroundColor: colors.panel, borderColor: colors.line2, minHeight: 44, minWidth: 64, paddingHorizontal: 12, paddingVertical: 6 },
        compact && {
          minHeight: 44,
          minWidth: 44,
          paddingHorizontal: 8,
          paddingVertical: 6,
        },
        disabled && { opacity: 0.45 },
        pressed && { opacity: 0.8 },
      ]}
    >
      <Icon name="stop" color={prominent ? "#FFFFFF" : colors.textMuted} size={compact ? 24 : prominent ? 32 : 26} />
      {stopping && <HudText accessibilityLiveRegion="polite" kind="heading" style={{ color: prominent ? "#FFFFFF" : colors.textMuted, fontSize: prominent ? 23 : 16 }}>
        STOPPING
      </HudText>}
    </Pressable>
    </Tooltip>
  );
}
const make_s = (colors: Palette) => {
  return StyleSheet.create({
  panel: {
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 10,
    padding: 16,
    gap: 12,
  },
  button: {
    minHeight: 56,
    minWidth: 56,
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: colors.line2,
    borderRadius: 10,
    flexDirection: "row",
    gap: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.panel,
  },
  tile: {
    minHeight: 80,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    backgroundColor: colors.panel,
  },
  tileIcon: {
    width: 44,
    height: 44,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.line2,
    backgroundColor: colors.panelRaised,
    alignItems: "center",
    justifyContent: "center",
  },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
    maxWidth: 290,
  },
  dot: { width: 6, height: 6, borderRadius: 6 },
  stop: {
    minHeight: 64,
    minWidth: 136,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingHorizontal: 24,
    paddingVertical: 12,
    backgroundColor: "#B82222",
    borderColor: "#FF8686",
    borderWidth: 1,
    borderRadius: 12,
  },
});
};
