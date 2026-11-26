import React from "react";
import { ScrollView, View } from "react-native";
import { HudPanel } from "../components/Hud.tsx";
import { HudText } from "../theme/Theme.tsx";
import { Field, CompactButton } from "./Controls.tsx";
import type { PathEditor } from "./usePathEditor.ts";

export function PathSettings({ editor }: { editor: PathEditor }) {
  const {
    speed,
    setSpeed,
    orientation,
    setOrientation,
    spacing,
    setSpacing,
    segments,
    stop,
    save,
    saving,
    saveBlocked,
    attempt,
  } = editor;
  const totalLength = segments.reduce((sum, part) => sum + part.length, 0);
  let segmentEnd = 0;
  return (
    <HudPanel style={{ padding: 8, gap: 6 }}>
      <HudText kind="heading" style={{ fontSize: 16 }}>
        Route settings & geometry
      </HudText>
      <View style={{ flexDirection: "row", gap: 6 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Field
            compact
            label="Path speed cap percent"
            value={speed}
            onChange={(value) => {
              stop();
              setSpeed(value);
            }}
          />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Field
            compact
            label="Start orientation degrees"
            value={orientation}
            onChange={(value) => {
              stop();
              setOrientation(value);
            }}
          />
        </View>
      </View>
      <Field
        compact
        label="Drawing point spacing preview units"
        value={spacing}
        onChange={setSpacing}
      />
      <HudText muted style={{ fontSize: 11, lineHeight: 15 }}>
        Speed 0–100%; orientation 0–359°. Drawing spacing 0.25–100 preview units; 2 keeps fine
        details. Sampling stops at 256 waypoints. Changing speed or orientation stops path driving;
        spacing affects new drawing points.
      </HudText>
      <CompactButton
        fullWidth
        label="Save path draft"
        primary
        disabled={saving || saveBlocked}
        text={saving ? "Saving path draft…" : "Save path draft"}
        onPress={() => attempt(save)}
      />
      <ScrollView style={{ maxHeight: 144 }} nestedScrollEnabled>
        <ScrollView horizontal accessibilityLabel="Route segment geometry and progress table">
          <View style={{ gap: 4 }}>
            <HudText kind="mono" style={{ fontSize: 11, lineHeight: 15 }}>
              SEGMENT LENGTH ORIENTATION HEADING SPEED ROUTE PROGRESS
            </HudText>
            {segments.map((part, i) => {
              const segmentStart = segmentEnd;
              segmentEnd += part.length;
              return (
                <HudText kind="mono" style={{ fontSize: 11, lineHeight: 15 }} key={i}>
                  {String(i + 1).padEnd(10)}
                  {part.length.toFixed(1).padEnd(13)}
                  {`${orientation}°`.padEnd(14)}
                  {`${part.heading}°`.padEnd(11)}
                  {`${speed}% (${part.speed})`.padEnd(13)}
                  {((segmentStart / totalLength) * 100).toFixed(1)}–
                  {((segmentEnd / totalLength) * 100).toFixed(1)}%
                </HudText>
              );
            })}
          </View>
        </ScrollView>
      </ScrollView>
    </HudPanel>
  );
}
