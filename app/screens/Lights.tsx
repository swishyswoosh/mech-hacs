import { useColors, useThemedStyles } from "../theme/useColors.ts";
import type { Palette } from "../theme/appearance.ts";
import React, { useEffect, useRef, useState } from "react";
import {
  View,
  Pressable,
  Platform,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
} from "react-native";
import type { ControllerSession } from "../session/ControllerSession.ts";
import { usePreferenceRevision } from "../session/hooks.ts";
import type { Command } from "../../core/index.ts";
import { HudButton } from "../components/Hud.tsx";
import { R2Figure } from "../components/R2Figure.tsx";
import { ColorWheel, BrightnessSlider } from "../components/ColorWheel.tsx";
import { HudText } from "../theme/Theme.tsx";
import { Field } from "../library/Fields.tsx";
import {
  lightPreset,
  colorToChannels,
  selectedLightCommand,
} from "../library/lights.ts";
import {
  readLightPresets,
  saveLightPreset,
  deleteLightPreset,
  LIGHT_PRESETS_KEY,
} from "../library/lightPresets.ts";
import type { SavedLightPreset } from "../library/lightPresets.ts";
import type { LightPreset } from "../library/lights.ts";
const rgb = (values: number[], offset: number) =>
  "#" +
  values
    .slice(offset, offset + 3)
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
export function Lights({
  session,
  ready,
  execute,
  notify,
  onHome,
}: {
  session: ControllerSession;
  ready: boolean;
  execute: (command: Command) => Promise<unknown>;
  notify: (text: string) => void;
  onHome?: () => void;
}) {
  const colors = useColors();
  const s = useThemedStyles(make_s);

  const [values, setValues] = useState(() => lightPreset("Idle")),
    [selected, setSelected] = useState(() => Array(8).fill(true) as boolean[]),
    [busy, setBusy] = useState(false),
    [tab, setTab] = useState("front"),
    [name, setName] = useState("");
  const [savedLibrary, setSavedLibrary] = useState(() =>
    readLightPresets((key) => session.loadPreference(key)),
  );
  const preferenceRevision = usePreferenceRevision(session);
  useEffect(() => {
    setSavedLibrary(readLightPresets((key) => session.loadPreference(key)));
  }, [session, preferenceRevision]);
  const [editingId, setEditingId] = useState<string>();
  const [deleteTarget, setDeleteTarget] = useState<SavedLightPreset>();
  const [presetPage, setPresetPage] = useState(0);
  const [presetError, setPresetError] = useState("");
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const editorGeneration = useRef(0);
  const latestDraft = useRef({ name, values, selected, editingId });
  latestDraft.current = { name, values, selected, editingId };
  const saved = savedLibrary.presets;
  const editing = saved.find((item) => item.id === editingId);
  const pageCount = Math.ceil(saved.length / 4);
  const page = Math.min(presetPage, Math.max(0, pageCount - 1));
  const dirty =
    !!editing &&
    (name !== editing.name ||
      values.some((v, i) => v !== editing.values[i]) ||
      selected.some((v, i) => v !== editing.selected[i]));
  const { width, height } = useWindowDimensions();
  const [chooserSize, setChooserSize] = useState({ width: 480, height: 180 });
  const low = width > height && height < 600;
  const update = (index: number, value: number) =>
    setValues((old) => old.map((v, i) => (i === index ? value : v)));
  const apply = async (channels: boolean[]) => {
    if (!ready || busy) return;
    setBusy(true);
    try {
      const command = selectedLightCommand(values, channels);
      session.assertManualSource(command);
      await execute(command);
    } catch (error) {
      notify(String(error));
    } finally {
      setBusy(false);
    }
  };
  const persist = async (presets: SavedLightPreset[]) => {
    if (savedLibrary.error) throw new Error(savedLibrary.error);
    await session.savePreference(
      LIGHT_PRESETS_KEY,
      JSON.stringify({ version: 1, presets }),
    );
    setSavedLibrary(readLightPresets((key) => session.loadPreference(key)));
    setPresetError("");
  };
  const save = async () => {
    if (pending.current) return;
    pending.current = true;
    setSaving(true);
    const generation = editorGeneration.current;
    try {
      const next = saveLightPreset(
        saved,
        { name, values, selected },
        editing?.id,
      );
      await persist(next.presets);
      if (editorGeneration.current === generation) {
        setEditingId(next.saved.id);
        if (latestDraft.current.name === name) setName(next.saved.name);
        setPresetPage(
          Math.floor(
            next.presets.findIndex((item) => item.id === next.saved.id) / 4,
          ),
        );
      }
      notify(`${next.saved.name} saved.`);
    } catch (error) {
      setPresetError(String(error));
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };
  const load = (preset: SavedLightPreset) => {
    editorGeneration.current++;
    setValues([...preset.values]);
    setSelected([...preset.selected]);
    setName(preset.name);
    setEditingId(preset.id);
    setDeleteTarget(undefined);
    setPresetError("");
  };
  const fresh = () => {
    editorGeneration.current++;
    setEditingId(undefined);
    setName("");
    setDeleteTarget(undefined);
    setPresetError("");
  };
  const remove = async () => {
    if (!deleteTarget || pending.current) return;
    pending.current = true;
    setSaving(true);
    const generation = editorGeneration.current;
    try {
      await persist(deleteLightPreset(saved, deleteTarget.id));
      if (
        editorGeneration.current === generation &&
        latestDraft.current.editingId === deleteTarget.id
      ) {
        const current = latestDraft.current;
        if (
          current.name === name &&
          current.values === values &&
          current.selected === selected
        )
          fresh();
        else setEditingId(undefined);
      }
      setDeleteTarget((current) =>
        current?.id === deleteTarget.id ? undefined : current,
      );
      notify(`${deleteTarget.name} deleted from saved presets.`);
    } catch (error) {
      setPresetError(String(error));
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };
  const tabs = [
    { id: "front", label: "Front dome", channels: [0, 1, 2] },
    { id: "front-readout", label: "Front readout", channels: [6] },
    { id: "projector", label: "Projector", channels: [7] },
    { id: "rear", label: "Rear dome", channels: [3, 4, 5] },
    { id: "rear-readout", label: "Rear readout", channels: [6] },
    { id: "presets", label: "Presets", channels: [0, 1, 2, 3, 4, 5, 6, 7] },
  ];
  const active = tabs.find((item) => item.id === tab)!;
  const dome = tab === "front" || tab === "rear";
  const offset = tab === "rear" ? 3 : 0;
  const narrow = width < 600;
  const readout = tab === "front-readout" || tab === "rear-readout";
  const fixedIndex = readout ? 6 : 7;
  const channelNames = [
    "Front red",
    "Front green",
    "Front blue",
    "Rear red",
    "Rear green",
    "Rear blue",
    "Readouts",
    "Projector",
  ];
  const mask = selected.map(
    (yes, index) => yes && active.channels.includes(index),
  );
  const tabKey = (event: React.KeyboardEvent<HTMLElement>) => {
    const index = tabs.findIndex((item) => item.id === tab);
    const next =
      event.key === "ArrowRight"
        ? (index + 1) % tabs.length
        : event.key === "ArrowLeft"
          ? (index + tabs.length - 1) % tabs.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? tabs.length - 1
              : -1;
    if (next < 0) return;
    event.preventDefault();
    setTab(tabs[next].id);
    (
      event.currentTarget
        .closest('[role="tablist"]')
        ?.querySelectorAll('[role="tab"]')[next] as HTMLElement
    )?.focus();
  };
  return (
    <View
      nativeID="light-controls-card"
      style={[s.card, low && { padding: 6, gap: 4 }]}
    >
      <View
        accessibilityRole={"tablist" as never}
        accessibilityLabel="Choose a light"
        style={s.tabs}
      >
        {[
          { label: "Front", ids: ["front", "front-readout", "projector"] },
          { label: "Rear", ids: ["rear", "rear-readout"] },
          { label: "", ids: ["presets"] },
        ].map((group) => (
          <View
            key={group.ids[0]}
            nativeID={`light-group-${group.label.toLowerCase() || "all"}`}
            style={{
              borderWidth: 1,
              borderColor: colors.line,
              borderRadius: 8,
              padding: 2,
              backgroundColor: colors.panel,
              flexGrow: group.ids.length,
              flexBasis: narrow
                ? group.label === "Front"
                  ? "100%"
                  : group.label === "Rear"
                    ? "64%"
                    : "30%"
                : 0,
              minWidth: 0,
            }}
          >
            <HudText
              style={{
                fontSize: 11,
                fontWeight: "600",
                letterSpacing: 1,
                color: colors.text,
                textAlign: "center",
                minHeight: 16,
              }}
            >
              {group.label || "All lights"}
            </HudText>
            <View style={{ flexDirection: "row" }}>
              {group.ids
                .map((id) => tabs.find((item) => item.id === id)!)
                .map((item) => (
                  <Pressable
                    key={item.id}
                    nativeID={`light-tab-${item.id}`}
                    accessibilityRole="tab"
                    accessibilityLabel={item.label}
                    accessibilityState={{ selected: tab === item.id }}
                    aria-selected={tab === item.id}
                    onPress={() => setTab(item.id)}
                    {...(Platform.OS === "web"
                      ? {
                          onKeyDown: tabKey as unknown as NonNullable<
                            React.ComponentProps<typeof Pressable>["onKeyDown"]
                          >,
                          tabIndex: tab === item.id ? 0 : -1,
                          "aria-controls": "selected-light-controls",
                        }
                      : {})}
                    style={[
                      s.tab,
                      low && { paddingVertical: 4, minHeight: 32 },
                      tab === item.id && {
                        borderBottomColor: colors.primary,
                        backgroundColor: colors.panel,
                      },
                    ]}
                  >
                    <HudText
                      style={{
                        fontSize: low || narrow ? 12 : 14,
                        color:
                          tab === item.id ? colors.primaryHi : colors.textMuted,
                      }}
                    >
                      {item.label
                        .replace(/^(Front|Rear) /, "")
                        .replace(/^./, (letter) => letter.toUpperCase())}
                    </HudText>
                  </Pressable>
                ))}
            </View>
          </View>
        ))}
      </View>
      <View style={s.workbench}>
        <View
          accessibilityLabel="Built-in light presets"
          style={[
            s.presetRail,
            {
              width: low ? 188 : narrow ? 72 : 144,
              gap: low || narrow ? 4 : 8,
              flexDirection: low ? "row" : "column",
            },
          ]}
        >
          <View
            nativeID="light-droid-preview"
            accessibilityLabel="Droid light preview"
            style={{ alignItems: "center", gap: 4 }}
          >
            {low && (
              <HudText muted style={{ fontSize: 11 }}>
                Presets
              </HudText>
            )}
            <R2Figure
              size={low || narrow ? 52 : 112}
              lights={[
                ...values.slice(0, 3),
                values[6],
                ...values.slice(3, 6),
                values[7],
              ]}
            />
          </View>
          <View style={{ width: low ? 116 : "100%", gap: 4 }}>
            {!low && (
              <HudText muted style={{ fontSize: 12 }}>
                Presets
              </HudText>
            )}
            <View
              style={{
                flexDirection: low ? "row" : "column",
                flexWrap: low ? "wrap" : "nowrap",
                gap: 4,
              }}
            >
              {(["Idle", "Alert", "Party", "Off"] as LightPreset[]).map(
                (preset) => (
                  <HudButton
                    key={preset}
                    label={preset}
                    style={[
                      s.smallButton,
                      { width: low ? "48%" : "100%", paddingHorizontal: 4 },
                    ]}
                    onPress={() => {
                      setValues(lightPreset(preset));
                      setSelected(Array(8).fill(true));
                      fresh();
                      setTab("presets");
                    }}
                  />
                ),
              )}
            </View>
          </View>
        </View>
        <View
          nativeID="selected-light-controls"
          accessibilityRole={
            Platform.OS === "web" ? ("tabpanel" as never) : undefined
          }
          accessibilityLabel={`${active.label} controls`}
          style={s.body}
          onLayout={(event) => setChooserSize(event.nativeEvent.layout)}
        >
          {tab === "presets" ? (
            <ScrollView
              style={{ flex: 1, minHeight: 0 }}
              contentContainerStyle={{ gap: 8, paddingVertical: 4 }}
              keyboardShouldPersistTaps="handled"
            >
              <View
                style={{
                  flexDirection: width < 900 ? "column" : "row",
                  gap: 14,
                }}
              >
                <View style={{ width: width < 900 ? "100%" : 210, gap: 6 }}>
                  <View style={[s.row, { justifyContent: "space-between" }]}>
                    <HudText kind="heading" style={{ fontSize: 14 }}>
                      Saved presets
                    </HudText>
                    <HudText muted style={{ fontSize: 11 }}>
                      {saved.length}
                    </HudText>
                  </View>
                  {saved.slice(page * 4, page * 4 + 4).map((preset) => (
                    <Pressable
                      key={preset.id}
                      accessibilityRole="button"
                      accessibilityLabel={`Select light preset ${preset.name}`}
                      accessibilityState={{ selected: editingId === preset.id }}
                      onPress={() => load(preset)}
                      style={{
                        minHeight: 34,
                        padding: 8,
                        borderRadius: 6,
                        borderWidth: 1,
                        borderColor:
                          editingId === preset.id
                            ? colors.primary
                            : colors.line,
                        backgroundColor:
                          editingId === preset.id
                            ? colors.panelRaised
                            : colors.panel,
                      }}
                    >
                      <HudText
                        numberOfLines={1}
                        style={{
                          fontSize: 13,
                          color:
                            editingId === preset.id
                              ? colors.primary
                              : colors.text,
                        }}
                      >
                        {preset.name}
                      </HudText>
                    </Pressable>
                  ))}
                  {!saved.length && (
                    <HudText muted style={{ fontSize: 12 }}>
                      No saved presets yet.
                    </HudText>
                  )}
                  {pageCount > 1 && (
                    <View style={[s.row, { justifyContent: "space-between" }]}>
                      <HudButton
                        label="Previous"
                        style={{
                          minHeight: 32,
                          paddingVertical: 4,
                          paddingHorizontal: 6,
                        }}
                        disabled={page === 0}
                        onPress={() => setPresetPage(page - 1)}
                      />
                      <HudText muted style={{ fontSize: 11 }}>
                        {page + 1} / {pageCount}
                      </HudText>
                      <HudButton
                        label="Next"
                        style={{
                          minHeight: 32,
                          paddingVertical: 4,
                          paddingHorizontal: 6,
                        }}
                        disabled={page === pageCount - 1}
                        onPress={() => setPresetPage(page + 1)}
                      />
                    </View>
                  )}
                  <HudButton
                    label="New preset"
                    style={s.smallButton}
                    onPress={fresh}
                  />
                </View>
                <View
                  style={{
                    flex: width < 900 ? undefined : 1,
                    minWidth: 0,
                    gap: 8,
                  }}
                >
                  <HudText muted style={{ fontSize: 12 }}>
                    {editing
                      ? dirty
                        ? "Unsaved changes · preview only"
                        : "Selected preset · preview only"
                      : "Save the current preview as a new preset"}
                  </HudText>
                  <Field
                    id="hud-light-preset-name"
                    label="Light preset name"
                    value={name}
                    onChangeText={setName}
                    placeholder="e.g. Evening"
                    style={{
                      minHeight: 36,
                      height: 36,
                      padding: 6,
                      fontSize: 14,
                    }}
                  />
                  <View style={s.row}>
                    <HudButton
                      label={editing ? "Save changes" : "Save preset"}
                      style={[s.smallButton, { flex: 1, paddingHorizontal: 6 }]}
                      disabled={saving || !!savedLibrary.error}
                      onPress={save}
                    />
                    {editing && (
                      <HudButton
                        label="Delete preset"
                        style={[s.smallButton, { paddingHorizontal: 6 }]}
                        onPress={() => setDeleteTarget(editing)}
                      />
                    )}
                  </View>
                  {!!(presetError || savedLibrary.error) && (
                    <HudText
                      accessibilityRole="alert"
                      style={{ fontSize: 12, color: colors.danger }}
                    >
                      {presetError || savedLibrary.error}
                    </HudText>
                  )}
                  {deleteTarget && (
                    <View
                      style={{
                        gap: 6,
                        padding: 8,
                        borderWidth: 1,
                        borderColor: colors.line2,
                        borderRadius: 6,
                      }}
                    >
                      <HudText style={{ fontSize: 12 }}>
                        Delete “{deleteTarget.name}”? This removes the saved
                        preset only; the droid’s lights stay as they are.
                      </HudText>
                      <View style={s.row}>
                        <HudButton
                          label="Confirm delete preset"
                          disabled={saving}
                          style={s.smallButton}
                          onPress={remove}
                        />
                        <HudButton
                          label="Cancel delete"
                          style={s.smallButton}
                          onPress={() => setDeleteTarget(undefined)}
                        />
                      </View>
                    </View>
                  )}
                  <HudText muted style={{ fontSize: 12 }}>
                    Channels to apply
                  </HudText>
                  <View style={s.row}>
                    {channelNames.map((label, index) => (
                      <Pressable
                        key={label}
                        accessibilityRole="checkbox"
                        accessibilityLabel={`Include ${label}`}
                        accessibilityState={{ checked: selected[index] }}
                        aria-checked={selected[index]}
                        onPress={() =>
                          setSelected((old) =>
                            old.map((yes, i) => (i === index ? !yes : yes)),
                          )
                        }
                        style={{
                          flexBasis: "30%",
                          flexGrow: 1,
                          paddingVertical: 4,
                          minHeight: 28,
                          flexDirection: "row",
                          gap: 4,
                        }}
                      >
                        <HudText
                          style={{ color: colors.primary, fontSize: 12 }}
                        >
                          {selected[index] ? "✓" : "□"}
                        </HudText>
                        <HudText style={{ fontSize: 11 }}>{label}</HudText>
                      </Pressable>
                    ))}
                  </View>
                </View>
              </View>
            </ScrollView>
          ) : dome ? (
            <View
              style={[
                s.chooser,
                { flexDirection: "row", gap: low || narrow ? 8 : 32 },
              ]}
            >
              <ColorWheel
                label={`${active.label} color`}
                value={rgb(values, offset)}
                size={
                  low
                    ? Math.max(
                        96,
                        Math.min(
                          144,
                          chooserSize.height,
                          chooserSize.width * 0.4,
                        ),
                      )
                    : narrow
                      ? 112
                      : 220
                }
                onChange={(color) =>
                  setValues((old) =>
                    colorToChannels(
                      old,
                      tab === "front" ? "front" : "rear",
                      color,
                    ),
                  )
                }
              />
              <View
                style={{
                  flexDirection: "column",
                  gap: low ? 4 : narrow ? 8 : 14,
                  flex: 1,
                  minWidth: 0,
                  maxWidth: 240,
                }}
              >
                {[0, 1, 2].map((channel) => (
                  <View key={`${tab}-${channel}`} style={{ minWidth: 0 }}>
                    <BrightnessSlider
                      compact
                      dense={low}
                      id={`hud-light-${offset + channel}`}
                      label={["Red", "Green", "Blue"][channel]}
                      value={values[offset + channel]}
                      onChange={(next) => update(offset + channel, next)}
                    />
                  </View>
                ))}
              </View>
            </View>
          ) : low ? (
            <View style={{ gap: 4, width: "100%" }}>
              <View
                style={{ flexDirection: "row", alignItems: "center", gap: 12 }}
              >
                <View
                  style={{
                    width: 56,
                    height: 36,
                    borderRadius: 6,
                    borderWidth: 1,
                    borderColor: colors.line2,
                    backgroundColor:
                      tab === "front-readout" ? "#3388FF" : "#FFFFFF",
                    opacity: 0.15 + (0.85 * values[fixedIndex]) / 255,
                  }}
                />
                <View style={{ flex: 1 }}>
                  <BrightnessSlider
                    compact
                    id={`hud-light-${fixedIndex}`}
                    label={`${active.label} brightness`}
                    value={values[fixedIndex]}
                    onChange={(next) => update(fixedIndex, next)}
                  />
                </View>
              </View>
              <HudText muted style={{ fontSize: 10 }}>
                {readout
                  ? "Front and rear readouts share brightness. Front blue; rear white."
                  : "White projector · brightness only."}
              </HudText>
            </View>
          ) : (
            <View style={s.fixed}>
              <View
                style={{
                  width: 112,
                  height: 64,
                  borderRadius: 12,
                  borderWidth: 1,
                  borderColor: colors.line2,
                  backgroundColor:
                    tab === "front-readout" ? "#3388FF" : "#FFFFFF",
                  opacity: 0.15 + (0.85 * values[fixedIndex]) / 255,
                }}
              />
              <HudText kind="heading">{active.label}</HudText>
              <View style={{ width: "100%", maxWidth: 360 }}>
                <BrightnessSlider
                  compact
                  id={`hud-light-${fixedIndex}`}
                  label={`${active.label} brightness`}
                  value={values[fixedIndex]}
                  onChange={(next) => update(fixedIndex, next)}
                />
              </View>
              <HudText muted style={{ textAlign: "center" }}>
                {readout
                  ? "Front and rear readouts share brightness. Front is blue; rear is white."
                  : "White light · brightness control only."}
              </HudText>
            </View>
          )}
        </View>
      </View>
      <View style={[s.footer, low && { paddingTop: 4, gap: 8 }]}>
        <HudText muted style={{ flex: 1, fontSize: 12 }}>
          {tab === "presets"
            ? "Applies all included channels."
            : readout
              ? "Applies to both readouts."
              : "Changes take effect when you press Apply."}
        </HudText>
        <HudButton
          label={
            tab === "presets"
              ? "Apply preset"
              : `Apply ${active.label.toLowerCase()}`
          }
          primary
          style={s.smallButton}
          disabled={!ready || busy || !mask.some(Boolean)}
          onPress={() => void apply(mask)}
        />
      </View>
    </View>
  );
}
const make_s = (colors: Palette) => {
  return StyleSheet.create({
    card: { flex: 1, minHeight: 0, padding: 12, gap: 8 },
    tabs: {
      flexShrink: 0,
      zIndex: 1,
      backgroundColor: colors.panel,
      flexDirection: "row",
      flexWrap: "wrap",
      borderBottomWidth: 1,
      borderBottomColor: colors.line,
      gap: 6,
    },
    tab: {
      flexGrow: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 8,
      paddingVertical: 6,
      borderBottomWidth: 2,
      borderBottomColor: "transparent",
      borderTopLeftRadius: 6,
      borderTopRightRadius: 6,
    },
    workbench: { flex: 1, minHeight: 0, flexDirection: "row", gap: 12 },
    presetRail: {
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      paddingRight: 8,
      borderRightWidth: 1,
      borderRightColor: colors.line,
    },
    body: { flex: 1, minHeight: 0, minWidth: 0, justifyContent: "center" },
    chooser: { alignItems: "center", justifyContent: "center", width: "100%" },
    fixed: {
      alignItems: "center",
      justifyContent: "center",
      gap: 16,
      paddingHorizontal: 12,
    },
    row: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
      alignItems: "center",
    },
    footer: {
      flexShrink: 0,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      borderTopWidth: 1,
      borderTopColor: colors.line,
      paddingTop: 8,
    },
    smallButton: { minHeight: 36, paddingVertical: 6, paddingHorizontal: 12 },
  });
};
