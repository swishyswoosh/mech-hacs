import { useColors, useThemedStyles } from "../theme/useColors.ts";
import type { Palette } from "../theme/appearance.ts";
import React, { useState } from "react";
import { Pressable, StyleSheet } from "react-native";
import { View, Text } from "./primitives.tsx";
import { projectTrace } from "./poseTrace.ts";
import type { PoseTrace } from "./poseTrace.ts";
export function PoseTracePanel({
  trace,
  onReset,
}: {
  trace: PoseTrace;
  onReset: () => void;
}) {
  const colors = useColors();
  const s = useThemedStyles(make_s);

  const [width, setWidth] = useState(300);
  const points = projectTrace(trace.visible().slice(-200), width, 220);
  return (
    <View style={s.card}>
      <Text style={s.title}>Estimated relative locator trace</Text>
      <Text>
        Current segment {trace.segment + 1} · {points.length} visible samples ·
        last {trace.points.length} retained samples. Raw wire locator units;
        auto-scaled display with one shared scale on both axes. Drift and wheel
        slip are possible. This is not a room map or obstacle detector.
      </Text>
      <View
        accessibilityLabel={`Relative locator trace with ${points.length} samples in the current connection and schema segment`}
        style={s.plot}
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      >
        {points.slice(1).map((point, index) => {
          const previous = points[index],
            length = Math.hypot(point.x - previous.x, point.y - previous.y);
          return (
            <View
              key={`line-${point.id}`}
              style={{
                position: "absolute",
                left: (point.x + previous.x) / 2 - length / 2,
                top: (point.y + previous.y) / 2 - 1,
                width: length,
                height: 2,
                backgroundColor: colors.primary,
                transform: [
                  {
                    rotate: `${Math.atan2(point.y - previous.y, point.x - previous.x)}rad`,
                  },
                ],
              }}
            />
          );
        })}
        {points.map((point, index) => (
          <View
            key={point.id}
            style={{
              position: "absolute",
              left: point.x - 3,
              top: point.y - 3,
              width: 6,
              height: 6,
              borderRadius: 3,
              backgroundColor:
                index === points.length - 1 ? colors.primaryHi : colors.primary,
            }}
          />
        ))}
      </View>
      <Pressable accessibilityRole="button" onPress={onReset} style={s.button}>
        <Text style={{ color: colors.text }}>Reset local trace origin</Text>
      </Pressable>
      <Text>
        Resets only the displayed reference frame. It sends no droid command and
        does not rewrite recorded raw values. Connections and schema changes
        begin another trace segment.
      </Text>
      {trace.markers.slice(-8).map((marker, index) => (
        <Text key={`${marker.at}-${index}`}>
          {new Date(marker.at).toLocaleTimeString()} · {marker.kind} · segment{" "}
          {marker.segment + 1}
        </Text>
      ))}
    </View>
  );
}
const make_s = (colors: Palette) => {
  return StyleSheet.create({
  card: { gap: 8, marginVertical: 10 },
  title: { fontSize: 18, fontWeight: "600" },
  plot: {
    width: "100%",
    height: 220,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.line2,
    overflow: "hidden",
  },
  button: {
    minHeight: 56,
    padding: 12,
    backgroundColor: colors.panelRaised,
    borderRadius: 6,
    justifyContent: "center",
  },
});
};
