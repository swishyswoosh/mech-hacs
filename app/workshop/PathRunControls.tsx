import { useColors, useThemedStyles } from "../theme/useColors.ts";
import type { Palette } from "../theme/appearance.ts";
import React from "react";
import { View } from "react-native";
import { HudButton, HudPanel } from "../components/Hud.tsx";
import { HudText } from "../theme/Theme.tsx";
import { planDroidPath } from "../../core/pathRunner.ts";
import type { PathEditor } from "./usePathEditor.ts";
import type { useDroidPath } from "./useDroidPath.ts";
import { makePathStyles } from "./pathStyles.ts";
export function PathRunControls({
  editor,
  live,
  ready,
  compact = false,
}: {
  editor: PathEditor;
  live: ReturnType<typeof useDroidPath>;
  ready: boolean;
  compact?: boolean;
}) {
  const colors = useColors();
  const s = useThemedStyles(makePathStyles);

  let duration = 0,
    error = "";
  try {
    duration = planDroidPath(editor.draft()).durationMs;
  } catch (e) {
    error = String(e);
  }
  const active = ["preparing", "running"].includes(live.state.status);
  return (
    <HudPanel style={{ padding: compact ? 6 : 8, gap: compact ? 4 : 6 }}>
      <HudText kind="heading" style={{ fontSize: compact ? 16 : 20 }}>
        Drive this path
      </HudText>
      <View style={[s.row, { gap: 6, alignItems: "stretch" }]}>
        <HudButton
          style={{
            flex: 1,
            minHeight: compact ? 32 : 36,
            paddingVertical: compact ? 3 : 6,
            paddingHorizontal: 6,
          }}
          primary
          label={live.state.status === "paused" ? "Resume path on droid" : "Run path on droid"}
          disabled={!ready || !!error || active || live.starting}
          onPress={() => {
            editor.traversal.stop();
            void live.start(editor.draft());
          }}
        />
        <HudButton
          style={{
            flex: 1,
            minHeight: compact ? 32 : 36,
            paddingVertical: compact ? 3 : 6,
            paddingHorizontal: 6,
          }}
          label="Pause droid path"
          disabled={!active}
          onPress={() => void live.pause()}
        />
        <HudButton
          style={{
            flex: 1,
            minHeight: compact ? 32 : 36,
            paddingVertical: compact ? 3 : 6,
            paddingHorizontal: 6,
          }}
          label="Stop droid path"
          disabled={!active && live.state.status !== "paused"}
          onPress={() => void live.stop()}
        />
      </View>
      <HudText accessibilityLiveRegion="polite" kind="mono" style={{ fontSize: 12 }}>
        {live.state.status.toUpperCase()} · {Math.round(live.state.progress * 100)}%
        {duration ? ` · ${(duration / 1000).toFixed(1)} s route` : ""}
      </HudText>
      {(!compact || error) && (
        <HudText muted style={{ fontSize: 11, lineHeight: 15 }}>
          {error ||
            "Three-leg driving. 0° is the droid’s forward direction at Start. Drawing units describe the shape; floor distance varies with speed and surface."}
        </HudText>
      )}
      {!!live.state.error && <HudText style={{ fontSize: 12 }}>{live.state.error}</HudText>}
    </HudPanel>
  );
}
