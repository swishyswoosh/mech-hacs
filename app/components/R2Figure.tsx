import { useColors, useThemedStyles } from "../theme/useColors.ts";
import type { Palette } from "../theme/appearance.ts";
import React from "react";
import { View, Pressable, StyleSheet } from "react-native";
import Svg, { G, Path, Circle, Rect, Ellipse, Line } from "react-native-svg";
import { HudText } from "../theme/Theme.tsx";
export function R2Figure({
  size = 300,
  compact = false,
  onDome,
  onLights,
  onStance,
  observedAngle,
  lights = [],
  stance,
}: {
  size?: number;
  compact?: boolean;
  onDome?: () => void;
  onLights?: () => void;
  onStance?: () => void;
  observedAngle?: number;
  lights?: Array<number | undefined>;
  stance?: "two" | "three" | "waddle";
}) {
  const colors = useColors();
  const s = useThemedStyles(make_s);

  const front =
    lights.slice(0, 3).length === 3 &&
    lights.slice(0, 3).every((v) => v !== undefined)
      ? `rgb(${lights.slice(0, 3).join(",")})`
      : colors.primary;
  const logic = lights[3] === undefined ? 0.6 : lights[3] / 255;
  const holo = lights[7] === undefined ? 0.6 : lights[7] / 255;
  const interactive = !!(onDome || onLights || onStance);
  return (
    <View
      style={{
        width: size + (interactive ? 96 : 0),
        height: size * 1.24,
        alignSelf: "center",
      }}
    >
      <Svg
        width={size}
        height="100%"
        viewBox="150 90 390 485"
        aria-hidden={true}
      >
        <Ellipse
          cx={340}
          cy={548}
          rx={155}
          ry={21}
          fill={colors.tint}
          stroke={colors.line2}
        />
        <Path d="M185 543L260 210H420L495 543" fill={colors.tintSoft} />

        <G
          fill={colors.tint}
          stroke={colors.primary}
          strokeWidth="4"
          strokeLinejoin="round"
          strokeLinecap="round"
        >
          <Path d="M184 230 h48 v54 h-48 z" />
          <Path d="M194 284 h32 v148 h-32 z" />
          <Path d="M186 432 h52 l16 70 l-20 28 h-40 l-22 -28 z" />
          <Path d="M496 230 h-48 v54 h48 z" />
          <Path d="M486 284 h-32 v148 h32 z" />
          <Path d="M494 432 h-52 l-16 70 l20 28 h40 l22 -28 z" />

          <Path d="M232 228 h216 v204 h-216 z" />
          <Path d="M236 432 h208 l-8 24 h-192 z" />

          <Path
            d="M322 456 h36 l4 14 l14 46 l-12 18 h-44 l-12 -18 l14 -46 z"
            opacity={stance === "two" ? 0.12 : 1}
          />

          <Path d="M230 228 q0 -122 110 -122 q110 0 110 122 z" />
        </G>
        <G
          fill="none"
          stroke={colors.primary}
          strokeWidth="3"
          strokeLinejoin="round"
          strokeOpacity=".9"
        >
          <G
            transform={`translate(${observedAngle === undefined ? 0 : Math.sin((observedAngle * Math.PI) / 180) * 45},0)`}
          >
            <Path d="M304 128 h56 l8 46 h-72 z" />
            <Circle cx="332" cy="150" r="14" />
            <Rect x="242" y="190" width="13" height="28" rx="1.5" />
            <Rect x="268" y="190" width="13" height="28" rx="1.5" />
            <Rect x="300" y="183" width="62" height="35" rx="2" />
            <Circle cx="331" cy="201" r="9" />
            <G id="dome-lights" stroke="none">
              <Rect x="244" y="192" width="9" height="24" fill="#3388FF" fillOpacity={logic} />
              <Circle cx="331" cy="201" r="7" fill={front} />
              <Circle cx="385" cy="201" r="5" fill="#FFFFFF" fillOpacity={holo} />
            </G>
            <Circle cx="385" cy="201" r="14" />
            <Circle cx="385" cy="201" r="6" />
            <Rect x="418" y="190" width="13" height="28" rx="1.5" />
          </G>

          <Path d="M210 290 v138 M470 290 v138" strokeOpacity=".6" />
          <Path
            d="M212 440 q-6 30 0 60 M468 440 q6 30 0 60"
            strokeOpacity=".6"
          />

          <Rect x="241" y="250" width="22" height="170" rx="2" />
          <Path d="M243 322 h18 M243 330 h18" strokeWidth="2" />
          <Rect x="417" y="250" width="22" height="170" rx="2" />

          <Path d="M282 434 v18 M340 434 v20 M398 434 v18" strokeWidth="2.5" />
        </G>
        <Circle cx="279" cy="460" r="5" fill="none" stroke={colors.primary} />
        <Circle cx="399" cy="460" r="5" fill="none" stroke={colors.primary} />
        <Circle cx="332" cy="150" r="5" fill="none" stroke={colors.primary} />

        <G stroke={colors.primaryHi} strokeWidth="2.5">
          <Rect
            x="297"
            y="240"
            width="78"
            height="9"
            rx="2"
            fill="none"
          />
          <Rect
            x="297"
            y="260"
            width="78"
            height="9"
            rx="2"
            fill="none"
          />
          <Rect
            x="297"
            y="280"
            width="78"
            height="9"
            rx="2"
            fill="none"
          />
        </G>
        <G fill="none" stroke={colors.primaryHi} strokeWidth="3">
          <Rect
            x="306"
            y="355"
            width="68"
            height="66"
            rx="4"
            fill="none"
          />
          <Circle cx="340" cy="388" r="24" />
          <Path d="M316 388 h48 M340 364 v48" />
          <Circle cx="340" cy="388" r="6" />
        </G>
      </Svg>
      {interactive && (
        <Svg
          pointerEvents="none"
          width={size + 96}
          height={size * 1.24}
          style={{ position: "absolute", top: 0, left: 0 }}
          aria-hidden={true}
        >
          {[0, 1, 2].map((i) => (
            <G key={i} stroke={colors.primary} fill={colors.panel}>
              <Line
                x1={size * (i === 1 ? 0.6 : 0.77)}
                x2={size + 8}
                y1={i === 1 ? size * 1.24 * (111 / 485) : (size * 1.24 * (i + 0.5)) / 3}
                y2={(size * 1.24 * (i + 0.5)) / 3}
              />
              <Circle
                cx={size * (i === 1 ? 0.6 : 0.77)}
                cy={i === 1 ? size * 1.24 * (111 / 485) : (size * 1.24 * (i + 0.5)) / 3}
                r={3}
              />
            </G>
          ))}
        </Svg>
      )}
      {[
        {
          label: "DOME",
          name: "Dome controls",
          run: onDome,
          top: "0%",
          value:
            observedAngle === undefined ? "" : `${Math.round(observedAngle)}°`,
        },
        {
          label: "LIGHTS",
          name: "Dome lights",
          run: onLights,
          top: "33.333%",
          value: "",
        },
        {
          label: "STANCE",
          name: "Stance controls",
          run: onStance,
          top: "66.666%",
          value: "",
        },
      ].map(
        (item) =>
          item.run && (
            <Pressable
              key={item.label}
              accessibilityRole="button"
              accessibilityLabel={item.name}
              onPress={item.run}
              style={[
                s.hit,
                compact && {minHeight:44},
                {
                  top: item.top as `${number}%`,
                  height: "33.333%",
                  left: item.label === "LIGHTS" ? size + 8 : 0,
                  width: item.label === "LIGHTS" ? 88 : "100%",
                },
              ]}
            >
              <View style={[s.callout, compact && {minHeight:44,padding:4}]}>
                <HudText kind="heading" style={[s.marker, compact && {fontSize:11}]}>
                  {item.label}
                </HudText>
                {!!item.value && (
                  <HudText kind="mono" style={{ fontSize: 12 }}>
                    {item.value}
                  </HudText>
                )}
              </View>
            </Pressable>
          ),
      )}
    </View>
  );
}
const make_s = (colors: Palette) => {
  return StyleSheet.create({
  hit: {
    position: "absolute",
    minHeight: 56,
    justifyContent: "center",
    alignItems: "flex-end",
    borderRadius: 8,
  },
  callout: {
    width: 88,
    minHeight: 56,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.panel,
    borderColor: colors.line2,
    borderWidth: 1,
    borderRadius: 8,
    padding: 8,
    gap: 2,
  },
  marker: { color: colors.primaryHi, fontSize: 14, letterSpacing: 1 },
});
};
