import React, { useEffect, useRef } from "react";
import { Platform, View } from "react-native";
import { HudPanel } from "../components/Hud.tsx";
import { HudText } from "../theme/Theme.tsx";
import { Field, CompactButton } from "./Controls.tsx";
import { parsePathDraft, serializePathDraft } from "../../core/automation.ts";
import type { PathEditor } from "./usePathEditor.ts";

export function PathTransfer({ editor }: { editor: PathEditor }) {
  const {
    port,
    onMessage,
    transfer,
    setTransfer,
    review,
    setReview,
    setSelected,
    setSpeed,
    setOrientation,
    attempt,
    change,
    draft,
  } = editor;
  const importGeneration = useRef(0);
  useEffect(
    () => () => {
      importGeneration.current++;
    },
    [],
  );
  const changeTransfer = (text: string) => {
    importGeneration.current++;
    setTransfer(text);
    setReview(undefined);
  };
  const chooseFile = async () => {
    const generation = ++importGeneration.current;
    setReview(undefined);
    try {
      const text = await port.importLocalJson!();
      if (generation !== importGeneration.current) return;
      setTransfer(text);
      setReview(parsePathDraft(text));
    } catch (error) {
      if (generation === importGeneration.current)
        onMessage(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <HudPanel style={{ padding: 8, gap: 6 }}>
      <HudText kind="heading" style={{ fontSize: 16 }}>
        Path import & export
      </HudText>
      <Field compact label="Path JSON" value={transfer} onChange={changeTransfer} multiline />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        <CompactButton
          label="Review path import"
          text="Review import"
          onPress={() => {
            importGeneration.current++;
            setReview(undefined);
            attempt(() => setReview(parsePathDraft(transfer)));
          }}
        />
        {port.importLocalJson && (
          <CompactButton
            label="Choose path JSON file"
            text="Choose JSON file"
            onPress={() => {
              void chooseFile();
            }}
          />
        )}
        <CompactButton
          label="Prepare path JSON export"
          text="Prepare export"
          onPress={() =>
            attempt(() => {
              changeTransfer(serializePathDraft(draft()));
              onMessage("Path JSON prepared. Save JSON file explicitly to write it.");
            })
          }
        />
        <CompactButton
          label="Save path JSON file"
          text="Save JSON file"
          disabled={!transfer.trim()}
          onPress={() => {
            attempt(() => {
              const text = serializePathDraft(parsePathDraft(transfer));
              if (port.exportLocalJson)
                void port.exportLocalJson("r2-path.json", text).then(
                  () => onMessage("Path JSON file saved."),
                  (error) => onMessage(String(error)),
                );
              else if (Platform.OS === "web") {
                const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
                const anchor = document.createElement("a");
                anchor.href = url;
                anchor.download = "r2-path.json";
                anchor.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                onMessage("Path JSON download requested.");
              } else throw new Error("Local file export unavailable.");
            });
          }}
        />
      </View>
      {review && (
        <View style={{ gap: 6 }}>
          <HudText style={{ fontSize: 12, lineHeight: 16 }}>
            Review: {review.points.length} waypoints · {review.speedPercent}% · orientation{" "}
            {review.startOrientation}°. Opening changes the draft; save explicitly to retain it.
          </HudText>
          <CompactButton
            fullWidth
            label="Use reviewed path as draft"
            text="Use reviewed draft"
            onPress={() => {
              change(review.points);
              setSpeed(String(review.speedPercent));
              setOrientation(String(review.startOrientation));
              setSelected(-1);
              setReview(undefined);
            }}
          />
          <CompactButton
            fullWidth
            label="Cancel path review"
            text="Cancel review"
            onPress={() => {
              importGeneration.current++;
              setReview(undefined);
            }}
          />
        </View>
      )}
    </HudPanel>
  );
}
