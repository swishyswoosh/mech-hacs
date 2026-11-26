import { useColors } from "../theme/useColors.ts";
import React from "react";
import { ScrollView, View, useWindowDimensions } from "react-native";
import type { ScrollViewProps } from "react-native";
import { HudText } from "../theme/Theme.tsx";

/** The shared frame for every tab's content, below the persistent HUD/navigation. */
export function HudPage({
  children,
  contentContainerStyle,
  style,
  ...props
}: ScrollViewProps) {
  const { width } = useWindowDimensions();
  return (
    <ScrollView
      {...props}
      style={[{ flex: 1, minWidth: 0 }, style]}
      keyboardShouldPersistTaps={props.keyboardShouldPersistTaps ?? "handled"}
      contentContainerStyle={[
        {
          width: "100%",
          maxWidth: 1200,
          alignSelf: "center",
          padding: width < 600 ? 16 : 24,
          paddingBottom: 48,
          gap: 16,
        },
        contentContainerStyle,
      ]}
    >
      {children}
    </ScrollView>
  );
}

export function HudPageTitle({
  title,
  subtitle,
  children,
  compact = false,
}: {
  compact?: boolean;
  title: string;
  subtitle?: string;
  children?: React.ReactNode;
}) {
  const colors = useColors();

  return (
    <View
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 12,
        paddingBottom: compact ? 8 : 16,
        borderBottomWidth: 1,
        borderColor: colors.line,
      }}
    >
      <View style={{ flex: 1, minWidth: 180, gap: 4 }}>
        <HudText
          kind="heading"
          accessibilityRole="header"
          style={{ fontSize: 24, color: colors.primary }}
        >
          {title}
        </HudText>
        {subtitle && (
          <HudText muted style={{ fontSize: 13, lineHeight: 19 }}>
            {subtitle}
          </HudText>
        )}
      </View>
      {children}
    </View>
  );
}
