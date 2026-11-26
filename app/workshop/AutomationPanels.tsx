import { useColors, useThemedStyles } from "../theme/useColors.ts";
import type { Palette } from "../theme/appearance.ts";
import { inputTheme } from "../theme/appearance.ts";
import type { AutomationOwnerPanel } from "../session/runningSources.ts";
import React, { useEffect, useRef, useState } from "react";
import {
  TextInput,
  Pressable,
  Platform,
  StyleSheet,
  AppState,
} from "react-native";
import { View, Text } from "./primitives.tsx";
import type { AppPort, AppSnapshot } from "../session/types.ts";
import {
  AutomationRunner,
  parseRecipe,
  serializeRecipe,
  recipeTimeline,
  moveRecipeStep,
} from "../../core/automation.ts";
import type {
  Recipe,
  RecipeAction,
  RunSnapshot,
} from "../../core/automation.ts";
import {
  reviewRecipeFile,
  chooseRecipeFile,
  saveReviewedRecipeFile,
} from "../../core/automationFiles.ts";
import type { RecipeFileReview } from "../../core/automationFiles.ts";
import {readSavedRecipes, saveSavedRecipe} from "./savedRecipes.ts";
const initial: Recipe = {
  version: 1,
  name: "Greeting",
  steps: [
    {
      id: "step-1",
      atMs: 0,
      durationMs: 1000,
      action: { type: "head", degrees: 0 },
    },
  ],
};
const defaults: RecipeAction[] = [
  { type: "head", degrees: 0 },
  { type: "drive", speed: 32, heading: 0 },
  { type: "stance", action: 0 },
  { type: "lights", values: [0, 0, 0, 0, 0, 0, 0, 0] },
  { type: "audio", sector: 1609 },
  { type: "animation", id: 7 },
  { type: "wait" },
  {
    type: "wait-event",
    event: {
      type: "sample",
      field: "attitude.yaw",
      operator: "above",
      value: 0,
    },
    onTimeout: "stop-run",
  },
];
function Button({
  title,
  onPress,
  disabled = false,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const colors = useColors();
  const s = useThemedStyles(make_s);

  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      accessibilityState={{ disabled }}
      onPress={onPress}
      style={[s.button, disabled && { opacity: 0.5 }]}
    >
      <Text style={{ color: colors.text, fontWeight: "600" }}>{title}</Text>
    </Pressable>
  );
}
function Field({
  label,
  value,
  onChange,
  multiline = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  multiline?: boolean;
}) {
  const colors = useColors();
  const s = useThemedStyles(make_s);
  const {inputPalette, inputSurface} = inputTheme(colors);

  const id = "automation-" + label.replace(/\W/g, "");
  return (
    <View style={{ gap: 4, marginVertical: 2, flexGrow:1, minWidth:140 }}>
      {Platform.OS === "web" ? (
        React.createElement("label", { htmlFor: id }, label)
      ) : (
        <Text>{label}</Text>
      )}
      <TextInput
        cursorColor={inputPalette.caret}
        selectionColor={inputPalette.selection}
        placeholderTextColor={inputPalette.placeholder}
        nativeID={id}
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        multiline={multiline}
        style={[
          s.input,
          multiline && { minHeight: 150, textAlignVertical: "top" },
        ]}
      />
    </View>
  );
}
export function AutomationPanels({
  kind,
  port,
  snapshot,
  stopToken,
  onRunning,
  onMessage,
  registerCancel,
  beforeStart,
}: {
  kind: "sequences" | "patrol";
  port: AppPort;
  snapshot: AppSnapshot;
  stopToken: number;
  onRunning: (s: string, owner?: AutomationOwnerPanel) => void;
  onMessage: (s: string) => void;
  registerCancel?: (cancel: () => void) => () => void;
  beforeStart?: (owner?: AutomationOwnerPanel) => Promise<void>;
}) {
  const colors = useColors();
  const s = useThemedStyles(make_s);

  const mounted = useRef(true),
    startEpoch = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      startEpoch.current++;
    };
  }, []);
  const [savedRecipes, setSavedRecipes] = useState(() => readSavedRecipes(port)),
    [recipe, setRecipe] = useState<Recipe>(initial),
    [selected, setSelected] = useState(0);
  useEffect(() => {
    setSavedRecipes(readSavedRecipes(port));
  }, [port, snapshot.preferencesRevision]);
  const [stepText, setStepText] = useState(
      JSON.stringify(initial.steps[0], null, 2),
    ),
    [transfer, setTransfer] = useState(""),
    [preview, setPreview] = useState(false);
  const [fileReview, setFileReview] = useState<{
      direction: "import" | "export";
      value: RecipeFileReview;
    }>(),
    [fileBusy, setFileBusy] = useState(false);
  const sensorSnapshot = useRef(snapshot.sensors);
  sensorSnapshot.current = snapshot.sensors;
  const runOwner = useRef<AutomationOwnerPanel>("Sequences");
  const [run, setRun] = useState<RunSnapshot>();
  const callbacks = useRef({ onRunning, onMessage });
  callbacks.current = { onRunning, onMessage };
  const [runner] = useState(
    () =>
      new AutomationRunner(
        {
          acquireSourceLease: port.acquireSourceLease
            ? (sourceId) => port.acquireSourceLease!(sourceId)
            : undefined,
          renewSourceLease: port.renewSourceLease
            ? (sourceId) => port.renewSourceLease!(sourceId)
            : undefined,
          releaseSourceLease: port.releaseSourceLease
            ? (sourceId) => port.releaseSourceLease!(sourceId)
            : undefined,
          execute: (command) => port.execute(command),
          armMotion: () => port.armMotion(),
          replaceSources: port.replaceSources
            ? () => port.replaceSources!()
            : undefined,
          stop: () => port.stop(),
          subscribeEvents: port.subscribeEvents
            ? (listener) => port.subscribeEvents!(listener)
            : undefined,
          sensorState: () => sensorSnapshot.current,
        },
        (state) => {
          setRun(state);
          callbacks.current.onRunning(
            ["preparing", "running"].includes(state.status)
              ? `${state.name} · ${state.step || state.status}`
              : "",
            runOwner.current,
          );
          if (state.error || state.status === "completed")
            callbacks.current.onMessage(
              state.error
                ? `Run ${state.status}: ${state.error}`
                : `Run ${state.status}.`,
            );
        },
      ),
  );
  useEffect(
    () =>
      registerCancel?.(() => {
        startEpoch.current++;
        void runner.cancel(false);
      }),
    [registerCancel, runner],
  );
  const seenStop = useRef(stopToken);
  useEffect(() => {
    if (seenStop.current !== stopToken) {
      seenStop.current = stopToken;
      startEpoch.current++;
      void runner.cancel(false);
    }
  }, [stopToken, runner]);
  useEffect(() => {
    if (snapshot.state !== "ready") {
      startEpoch.current++;
      void runner.cancel(false);
    }
  }, [snapshot.state, runner]);
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const cancel = () => {
      startEpoch.current++;
      void runner.cancel().catch(() => {});
    };
    const visibility = () => {
      if (document.hidden) cancel();
    };
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [runner]);
  useEffect(() => {
    const listener = AppState.addEventListener("change", (state) => {
      if (state !== "active") {
        startEpoch.current++;
        void runner.cancel().catch(() => {});
      }
    });
    return () => {
      listener.remove();
      void runner.cancel().catch(() => {});
    };
  }, [runner]);
  const [patrolDuration, setPatrolDuration] = useState("3000"),
    [patrolRepeats, setPatrolRepeats] = useState("1"),
    [patrolId, setPatrolId] = useState(30);
  const busy = run?.status === "preparing" || run?.status === "running";
  const attempt = async (fn: () => void | Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      onMessage(e instanceof Error ? e.message : String(e));
    }
  };
  const select = (next: Recipe, index = 0) => {
    setRecipe(next);
    setSelected(index);
    setStepText(JSON.stringify(next.steps[index] || {}, null, 2));
    setPreview(false);
  };
  const save = () =>
    attempt(async () => {
      try {
        await saveSavedRecipe(port, recipe);
      } finally {
        setSavedRecipes(readSavedRecipes(port));
      }
      onMessage("Protocol saved.");
    });
  const play = (value: Recipe) => {
    const owner: AutomationOwnerPanel =
        kind === "patrol" ? "Paths & Patrol" : "Sequences",
      intent = ++startEpoch.current;
    void runner
      .play(value, async () => {
        await beforeStart?.(owner);
        if (!mounted.current || intent !== startEpoch.current)
          throw new Error("Start canceled; use a fresh action.");
        runOwner.current = owner;
      })
      .catch((e) => onMessage(String(e)));
  };
  const reviewImport = (text: string) => {
    const value = reviewRecipeFile(text);
    setTransfer(value.text);
    setFileReview({ direction: "import", value });
    onMessage(
      "Protocol validated for review. Your current draft is unchanged.",
    );
  };
  const chooseImport = () => {
    if (!port.importLocalJson) return;
    setFileBusy(true);
    void chooseRecipeFile(() => port.importLocalJson!())
      .then((value) => {
        setTransfer(value.text);
        setFileReview({ direction: "import", value });
        onMessage(
          "Protocol validated for review. Use it as a draft, then save explicitly.",
        );
      })
      .catch((e) => onMessage(String(e)))
      .finally(() => setFileBusy(false));
  };
  const reviewExport = () =>
    attempt(() => {
      const value = reviewRecipeFile(serializeRecipe(recipe));
      setTransfer(value.text);
      setFileReview({ direction: "export", value });
      onMessage(
        "Review the protocol, then choose Save JSON file.",
      );
    });
  const saveExport = () => {
    if (fileReview?.direction !== "export") return;
    const review = fileReview.value;
    setFileBusy(true);
    void saveReviewedRecipeFile(review, async (name, text) => {
      if (port.exportLocalJson) await port.exportLocalJson(name, text);
      else if (Platform.OS === "web") {
        const url = URL.createObjectURL(
          new Blob([text], { type: "application/json" }),
        );
        const link = document.createElement("a");
        link.href = url;
        link.download = name;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } else throw new Error("Local file export is unavailable.");
    })
      .then(() => {
        setFileReview(undefined);
        onMessage(
          Platform.OS === "web" && !port.exportLocalJson
            ? "Protocol download requested."
            : "Protocol JSON file saved.",
        );
      })
      .catch((e) => onMessage(String(e)))
      .finally(() => setFileBusy(false));
  };
  return (
    <View style={s.card}>
      {run && (
        <Text accessibilityLiveRegion="polite">
          {run.name} · {run.status} {run.step || ""} {run.error || ""}
        </Text>
      )}
      {kind === "sequences" ? (
        <>
          <Text style={s.title}>Protocol</Text>
          <Text>
            Run protocol stops current sources and may move the droid. Editing
            changes only the draft. All durations are requested bounds; droid
            responses and Bluetooth latency affect timing.
          </Text>
          <View style={s.row}>
            <Button
              title="New protocol"
              onPress={() =>
                select({ ...initial, name: "Untitled", steps: [] })
              }
            />
            <Button
              title="Duplicate"
              onPress={() => select({ ...recipe, name: recipe.name + " copy" })}
            />
          </View>
          {savedRecipes.error && (
            <Text accessibilityRole="alert">{savedRecipes.error}</Text>
          )}
          {savedRecipes.recipes.map((item, index) => (
            <Button
              key={index}
              title={`Open ${item.name}`}
              onPress={() => select(parseRecipe(serializeRecipe(item)))}
            />
          ))}
          <Field
            label="Name"
            value={recipe.name}
            onChange={(name) => {
              setRecipe({ ...recipe, name });
              setPreview(false);
            }}
          />
          <Text style={s.title}>Timeline and selected step</Text>
          <Text>
            Move earlier/later arranges the listed actions sequentially from 0
            ms and updates their start times. Use the step inspector for
            parallel timing.
          </Text>
          {recipe.steps.map((step, index) => (
            <Button
              key={step.id}
              title={`${index + 1}. ${step.action.type} · ${step.atMs} ms · ${step.durationMs} ms × ${step.repeat || 1}`}
              onPress={() => {
                setSelected(index);
                setStepText(JSON.stringify(step, null, 2));
              }}
            />
          ))}
          <View style={s.row}>
            {defaults.map((action) => (
              <Button
                key={action.type}
                title={`Add ${action.type}`}
                onPress={() => {
                  const step = {
                    id: `step-${Date.now()}-${recipe.steps.length}`,
                    atMs: recipe.steps.reduce(
                      (end, item) =>
                        Math.max(
                          end,
                          item.atMs + item.durationMs * (item.repeat || 1),
                        ),
                      0,
                    ),
                    durationMs: 1000,
                    action: JSON.parse(JSON.stringify(action)),
                  };
                  select(
                    { ...recipe, steps: [...recipe.steps, step] },
                    recipe.steps.length,
                  );
                }}
              />
            ))}
          </View>
          {!!recipe.steps.length && (
            <>
              <Text>
                Selected step {selected + 1}. Inspector uses milliseconds; drive
                byte 0–255, heading 0–359°, head -160–180°, stance 0–3, eight
                LED bytes, sound sector and animation 0–55. Independent
                resources may overlap.
              </Text>
              <Field
                label="Selected step JSON"
                value={stepText}
                onChange={setStepText}
                multiline
              />
              <Button
                title="Apply step to draft"
                onPress={() =>
                  attempt(() => {
                    const steps = [...recipe.steps];
                    steps[selected] = JSON.parse(stepText);
                    const next = { ...recipe, steps };
                    serializeRecipe(next);
                    setRecipe(next);
                    setPreview(false);
                    onMessage("Step applied to draft; save to retain it.");
                  })
                }
              />
              <View style={s.row}>
                <Button
                  title="Move step earlier"
                  disabled={selected === 0}
                  onPress={() => {
                    attempt(() =>
                      select(
                        moveRecipeStep(recipe, selected, -1),
                        selected - 1,
                      ),
                    );
                  }}
                />
                <Button
                  title="Move step later"
                  disabled={selected >= recipe.steps.length - 1}
                  onPress={() => {
                    attempt(() =>
                      select(moveRecipeStep(recipe, selected, 1), selected + 1),
                    );
                  }}
                />
                <Button
                  title="Remove selected step from draft"
                  onPress={() =>
                    select({
                      ...recipe,
                      steps: recipe.steps.filter((_, i) => i !== selected),
                    })
                  }
                />
              </View>
            </>
          )}
          <View style={s.row}>
            <Button title="Save protocol" onPress={save} disabled={!!savedRecipes.error} />
            <Button
              title="Preview timeline (no movement)"
              onPress={() =>
                attempt(() => {
                  recipeTimeline(recipe);
                  setPreview(true);
                })
              }
            />
            <Button
              title="Run protocol"
              disabled={snapshot.state !== "ready" || busy}
              onPress={() => play(recipe)}
            />
            <Button
              title="Abort run"
              disabled={!busy}
              onPress={() => {
                void runner.cancel().catch((e) => onMessage(String(e)));
              }}
            />
          </View>
          {preview &&
            recipeTimeline(recipe).map((step, index) => (
              <Text key={index}>
                {step.atMs}–{step.endMs} ms · {step.id} · {step.action.type} ·
                repetition {step.iteration + 1}
              </Text>
            ))}
          <Text>
            Event waits consume live decoded samples or command
            acknowledgements. Set durationMs to the bounded wait window and
            onTimeout to stop-run or fail-run; both stop the droid and discard
            future cues on timeout. An early match retains the declared timeline
            boundary. Same-time actions may run in parallel; place dependent
            actions at the window end. Threshold values use raw wire units;
            acknowledgements do not prove physical completion. Droid-RAM light frames
            use the separate on-droid light actions panel. Mixed actions run locally. Wait steps are finite
            delays.
          </Text>
          <Button
            title="Review JSON export"
            onPress={reviewExport}
            disabled={fileBusy}
          />
          <Field
            label="Import or export JSON"
            value={transfer}
            onChange={setTransfer}
            multiline
          />
          <Text>
            File import opens a review first. Using it as a draft does not save
            locally or run it. Export writes only the reviewed snapshot after
            Save JSON file.
          </Text>
          {port.importLocalJson && (
            <Button
              title="Choose JSON file"
              onPress={chooseImport}
              disabled={fileBusy}
            />
          )}
          {Platform.OS === "web" &&
            React.createElement("input", {
              type: "file",
              accept: ".json,application/json",
              "aria-label": "Import protocol file",
              disabled: fileBusy,
              onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
                const file = event.target.files?.[0];
                if (!file) return;
                if (file.size > 200000) {
                  onMessage("Protocol file too large; maximum 200000 bytes.");
                  return;
                }
                setFileBusy(true);
                void file
                  .text()
                  .then((text) => attempt(() => reviewImport(text)))
                  .catch((e) => onMessage(String(e)))
                  .finally(() => setFileBusy(false));
              },
            })}
          <Button
            title="Review import JSON"
            disabled={fileBusy}
            onPress={() => attempt(() => reviewImport(transfer))}
          />
          {fileReview && (
            <View style={s.card}>
              <Text style={s.title}>Review protocol {fileReview.direction}</Text>
              <Text>
                {fileReview.value.recipe.name} · version 1 ·{" "}
                {fileReview.value.steps} steps. Import and export do not send
                droid commands.
              </Text>
              <Text selectable>{fileReview.value.text}</Text>
              {fileReview.direction === "import" ? (
                <Button
                  title="Use reviewed actions as draft"
                  disabled={fileBusy}
                  onPress={() => {
                    select(parseRecipe(fileReview.value.text));
                    setFileReview(undefined);
                    onMessage(
                      "Reviewed actions copied to draft. Use Save draft to retain them locally.",
                    );
                  }}
                />
              ) : (
                <Button
                  title="Save JSON file"
                  disabled={fileBusy}
                  onPress={saveExport}
                />
              )}
              <Button
                title="Cancel file review"
                disabled={fileBusy}
                onPress={() => setFileReview(undefined)}
              />
            </View>
          )}
        </>
      ) : (
        <>
          <Text style={s.title}>Supervised local patrol</Text>
          <Text>
            Finite built-in patrol requests; movement content unknown. This
            routine does not follow the drawing or avoid obstacles.
          </Text>
          <View style={s.row}>
            {[
              [30, "Patrolling"],
              [28, "Alarm"],
              [29, "Hit"],
            ].map(([id, name]) => (
              <Button
                key={id}
                title={`${patrolId === id ? "Selected: " : ""}${name} (${id})`}
                onPress={() => setPatrolId(Number(id))}
              />
            ))}
          </View>
          <View style={s.row}>
          <Field
            label="Patrol action duration ms"
            value={patrolDuration}
            onChange={setPatrolDuration}
          />
          <Field
            label="Patrol repetitions"
            value={patrolRepeats}
            onChange={setPatrolRepeats}
          />
          </View>
          <Button
            title="Start supervised patrol and replace sources"
            disabled={snapshot.state !== "ready" || busy}
            onPress={() =>
              play({
                version: 1,
                name: "Supervised patrol",
                steps: [
                  {
                    id: "patrol",
                    atMs: 0,
                    durationMs: Number(patrolDuration),
                    repeat: Number(patrolRepeats),
                    action: { type: "animation", id: patrolId },
                  },
                ],
              })
            }
          />
          <Button
            title="Abort patrol"
            disabled={!busy}
            onPress={() => {
              void runner.cancel().catch((e) => onMessage(String(e)));
            }}
          />
        </>
      )}
    </View>
  );
}
const make_s = (colors: Palette) => {
  const {inputSurface} = inputTheme(colors);
  return StyleSheet.create({
  card: {
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.line2,
    borderRadius: 10,
    padding: 10,
    marginVertical: 2,
    gap: 8,
  },
  title: { fontSize: 17, fontWeight: "600", color: colors.text },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  button: {
    minHeight: Platform.OS === "web" ? 32 : 44,
    padding: 8,
    justifyContent: "center",
    backgroundColor: colors.panelRaised,
    borderRadius: 7,
    marginVertical: 2,
  },
  input: {
    ...inputSurface,
    minHeight: Platform.OS === "web" ? 32 : 44,
    borderWidth: 1,
    borderColor: colors.line2,
    borderRadius: 5,
    padding: 8,
    fontSize: 14,
  },
  canvas: {
    height: 260,
    width: "100%",
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.line2,
    overflow: "hidden",
  },
});
};
