import { selectedLightCommand } from "./lights.ts";
export const LIGHT_PRESETS_KEY = "lightPresets.v1";
export type SavedLightPreset = {
  id: string;
  name: string;
  values: number[];
  selected: boolean[];
};
type Draft = Omit<SavedLightPreset, "id">;
function validateDraft(draft: Draft) {
  const name = typeof draft.name === "string" ? draft.name.trim() : "";
  if (!name) throw new Error("Enter a preset name.");
  if (
    !Array.isArray(draft.values) ||
    draft.values.length !== 8 ||
    !Array.isArray(draft.selected) ||
    draft.selected.length !== 8 ||
    draft.selected.some((v) => typeof v !== "boolean")
  )
    throw new Error("Invalid light channels.");
  selectedLightCommand(draft.values, draft.selected);
  return { name, values: [...draft.values], selected: [...draft.selected] };
}
/** An existing v1 library, including an empty one, overrides legacy keys retained for recovery. */
export function readLightPresets(load: (key: string) => string | null): {
  presets: SavedLightPreset[];
  error?: string;
} {
  try {
    const text = load(LIGHT_PRESETS_KEY);
    if (text !== null) {
      const data = JSON.parse(text);
      if (data?.version !== 1 || !Array.isArray(data.presets))
        throw new Error("Unsupported light preset library.");
      const ids = new Set<string>(),
        names = new Set<string>();
      const presets = data.presets.map((item: SavedLightPreset) => {
        if (
          !item ||
          typeof item.id !== "string" ||
          !item.id ||
          ids.has(item.id)
        )
          throw new Error("Invalid preset identity.");
        const draft = validateDraft(item),
          key = draft.name.toLowerCase();
        if (names.has(key)) throw new Error("Duplicate preset name.");
        ids.add(item.id);
        names.add(key);
        return { id: item.id, ...draft };
      });
      return { presets };
    }
    const legacy = load("lightPreset");
    if (legacy === null) return { presets: [] };
    const old = JSON.parse(legacy);
    if (!Array.isArray(old?.values))
      throw new Error("Invalid legacy light preset.");
    return {
      presets: [
        {
          id: "legacy-light-preset",
          ...validateDraft({
            name: load("lightPresetName") || "My lights",
            values: old.values.map(Number),
            selected: old.selected,
          }),
        },
      ],
    };
  } catch (error) {
    return {
      presets: [],
      error: `Saved presets could not be read. Existing data was retained. ${String(error)}`,
    };
  }
}
export function saveLightPreset(
  presets: SavedLightPreset[],
  draft: Draft,
  editingId?: string,
) {
  const next = validateDraft(draft);
  if (editingId && !presets.some((item) => item.id === editingId))
    throw new Error("Selected preset not found.");
  if (
    presets.some(
      (item) =>
        item.id !== editingId &&
        item.name.toLowerCase() === next.name.toLowerCase(),
    )
  )
    throw new Error(
      "A preset with that name already exists. Choose it to save changes, or use another name.",
    );
  const saved = {
    id:
      editingId ??
      `light-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    ...next,
  };
  return {
    saved,
    presets: editingId
      ? presets.map((item) => (item.id === editingId ? saved : item))
      : [...presets, saved],
  };
}
export function deleteLightPreset(presets: SavedLightPreset[], id: string) {
  if (!presets.some((item) => item.id === id))
    throw new Error("Selected preset not found.");
  return presets.filter((item) => item.id !== id);
}
