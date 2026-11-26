import {useAppActive} from "../platform/useAppActive.ts";
import { useColors } from "./useColors.ts";
import React, { createContext, useContext, useEffect, useState } from "react";
import { AccessibilityInfo, Text, StyleSheet } from "react-native";
import type { TextProps } from "react-native";
import { fonts } from "./tokens.ts";
export const HudTheme = createContext({ largeLabels: false, intensity: true });
export function HudText({
  kind = "body",
  muted = false,
  style,
  ...props
}: TextProps & { kind?: "body" | "heading" | "mono"; muted?: boolean }) {
  const colors = useColors();

  const { largeLabels } = useContext(HudTheme);
  const base = kind === "heading" ? 24 : kind === "mono" ? 12 : 15;
  return (
    <Text
      {...props}
      style={[
        {
          fontFamily: fonts[kind],
          fontSize: base,
          color: muted ? colors.textMuted : colors.text,
        },
        kind === "heading" && {
          letterSpacing: 1.8,
          textTransform: "uppercase",
        },
        style,
        largeLabels && {
          fontSize:
            ((StyleSheet.flatten(style)?.fontSize as number) || base) * 1.2,
        },
      ]}
    />
  );
}
export function useMotion() {
  const active = useAppActive();
  const { intensity } = useContext(HudTheme);
  const [reduced, setReduced] = useState(true);
  useEffect(() => {
    let current = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((v) => {
      if (current) setReduced(v);
    });
    const sub = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setReduced,
    );
    return () => {
      current = false;
      sub.remove();
    };
  }, []);
  return active && intensity && !reduced;
}
