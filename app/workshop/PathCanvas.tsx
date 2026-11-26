import { useColors, useThemedStyles } from "../theme/useColors.ts";
import type { Palette } from "../theme/appearance.ts";
import React from "react";
import { Platform, View } from "react-native";
import Svg, { Circle, Line, Polyline } from "react-native-svg";
import { HudButton, HudPanel } from "../components/Hud.tsx";
import { HudText } from "../theme/Theme.tsx";
import { sampleWaypoint, canvasPoint } from "./pathEditor.ts";
import type { PathEditor } from "./usePathEditor.ts";
import { makePathStyles } from "./pathStyles.ts";
export function PathCanvas({
  editor,
  fit = false,
  compact = false,
}: {
  editor: PathEditor;
  fit?: boolean;
  compact?: boolean;
}) {
  const colors = useColors();
  const s = useThemedStyles(makePathStyles);

  const {
    points,
    setPoints,
    selected,
    drawing,
    setDrawing,
    confirmClear,
    setConfirmClear,
    setSelected,
    change,
    width,
    setWidth,
    canvasHeight,
    setCanvasHeight,
    spacing,
    run,
    stop,
    select,
    validation,
    position,
    bounds,
    spanX,
    spanY,
    addFromPointer,
  } = editor;
  return (
    <HudPanel
      style={{
        padding: compact ? 6 : 8,
        gap: compact ? 4 : 8,
        ...(fit ? { flex: 1, minHeight: 0 } : {}),
      }}
    >
      <View style={[s.row, { gap: compact ? 4 : 10 }]}>
        <HudText kind="mono" style={{ flex: 1, fontSize: 11 }}>
          {points.length} / 256 {compact ? "points" : "waypoints · PREVIEW UNITS"}
        </HudText>
        <HudButton
          style={{
            minHeight: compact ? 28 : 34,
            paddingVertical: compact ? 2 : 5,
            paddingHorizontal: compact ? 4 : 8,
          }}
          label={drawing ? "Draw mode active" : "Select mode active"}
          onPress={() => setDrawing(!drawing)}
        />
        <HudButton
          style={{
            minHeight: compact ? 28 : 34,
            paddingVertical: compact ? 2 : 5,
            paddingHorizontal: compact ? 4 : 8,
          }}
          label="Clear path"
          disabled={!points.length}
          onPress={() => setConfirmClear(true)}
        />
      </View>
      <View style={{ position: "relative", ...(fit ? { flex: 1, minHeight: 0 } : {}) }}>
        <View
          accessibilityLabel="Path drawing area; coordinate controls also support keyboard editing"
          onLayout={(event) => {
            setWidth(event.nativeEvent.layout.width);
            setCanvasHeight(event.nativeEvent.layout.height);
          }}
          pointerEvents={confirmClear ? "none" : "auto"}
          style={[s.canvas, fit && { height: undefined, flex: 1, minHeight: 0 }]}
          onStartShouldSetResponder={() => drawing}
          onResponderGrant={addFromPointer}
          onResponderMove={(event) => {
            if (!drawing) return;
            const { locationX, locationY } = event.nativeEvent;
            const next = canvasPoint(locationX, locationY, width, canvasHeight, bounds);
            stop();
            setPoints((previous) => {
              try {
                return sampleWaypoint(previous, next, Number(spacing));
              } catch {
                return previous;
              }
            });
          }}
        >
          <Svg
            width="100%"
            height={canvasHeight}
            viewBox={`${bounds.minX} ${bounds.minY} ${spanX} ${spanY}`}
            preserveAspectRatio="none"
          >
            {Array.from({ length: 11 }, (_, i) => (
              <React.Fragment key={i}>
                <Line
                  x1={bounds.minX + (spanX * i) / 10}
                  x2={bounds.minX + (spanX * i) / 10}
                  y1={bounds.minY}
                  y2={bounds.maxY}
                  stroke={colors.line}
                  strokeWidth="1"
                />
                <Line
                  x1={bounds.minX}
                  x2={bounds.maxX}
                  y1={bounds.minY + (spanY * i) / 10}
                  y2={bounds.minY + (spanY * i) / 10}
                  stroke={colors.line}
                  strokeWidth="1"
                />
              </React.Fragment>
            ))}
            <Polyline
              points={points.map((p) => `${p.x},${p.y}`).join(" ")}
              fill="none"
              stroke={colors.primary}
              strokeWidth="2"
            />
            {points.map((p, i) => {
              const geometry = {
                cx: p.x,
                cy: p.y,
                r: selected === i ? 7 : 4,
                fill: selected === i ? colors.caution : colors.primary,
              };
              const choose = () => {
                if (!drawing) select(i);
              };
              // Browser circles use DOM clicks; native SVG press handlers install
              // responder properties that React DOM cannot handle.
              return Platform.OS === "web" ? (
                <circle key={i} {...geometry} onClick={choose} />
              ) : (
                <Circle key={i} {...geometry} onPress={choose} />
              );
            })}
            {position && run.status !== "idle" && (
              <Circle
                cx={position.x}
                cy={position.y}
                r="9"
                fill={colors.ok}
                stroke={colors.text}
                strokeWidth="2"
              />
            )}
          </Svg>
        </View>
        {confirmClear && (
          <View
            accessibilityLabel="Clear path confirmation"
            accessibilityRole="alert"
            style={{
              position: "absolute",
              top: 0,
              right: 0,
              bottom: 0,
              left: 0,
              justifyContent: "center",
              padding: compact ? 6 : 12,
              backgroundColor: "rgba(0,0,0,0.12)",
              borderRadius: 8,
            }}
          >
            <View
              style={{
                gap: compact ? 4 : 8,
                padding: compact ? 6 : 12,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: colors.line2,
                backgroundColor: colors.panelRaised,
              }}
            >
              <HudText style={{ fontSize: compact ? 11 : 13, lineHeight: compact ? 13 : 18 }}>
                {compact
                  ? "Clear this drawing? Saved routes and exported files stay unchanged."
                  : "Clear this drawing and start a new path? Your saved route and exported files stay unchanged until you save the new draft."}
              </HudText>
              <View style={[s.row, { gap: compact ? 4 : 10 }]}>
                <HudButton
                  style={{
                    minHeight: compact ? 28 : 34,
                    paddingVertical: compact ? 2 : 5,
                    paddingHorizontal: compact ? 4 : 8,
                  }}
                  label="Clear path and draw new"
                  caution
                  onPress={() => {
                    change([]);
                    setSelected(-1);
                    setDrawing(true);
                    setConfirmClear(false);
                  }}
                />
                <HudButton
                  style={{
                    minHeight: compact ? 28 : 34,
                    paddingVertical: compact ? 2 : 5,
                    paddingHorizontal: compact ? 4 : 8,
                  }}
                  label="Keep waypoints"
                  onPress={() => setConfirmClear(false)}
                />
              </View>
            </View>
          </View>
        )}
      </View>
      <HudText
        muted
        numberOfLines={compact ? 2 : undefined}
        style={{ fontSize: compact ? 10 : 12, lineHeight: compact ? 12 : 16 }}
      >
        {validation}. Use Run path on droid to drive this route.
      </HudText>
    </HudPanel>
  );
}
