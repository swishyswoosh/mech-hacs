import { animations, sounds } from "../../core/catalogs.ts";
import { actionSchedules } from "../../core/actionSchedules.ts";
export type LibraryItem = {
  key: string;
  id: number;
  kind: "sound" | "animation";
  name: string;
  category: string;
  sector?: number;
  lightEffect?: "rainbow";
  description: string;
};
const clean = (name: string) =>
  name
    .replace(/^R2D2_|^R2[_ ]?/, "")
    .replace(/\.bin$/, "")
    .replace(/_/g, " ");
// Normalize source naming first: both "R2 Hit_1" and "R2_Chatty_1"
// belong to numbered families. Unnumbered Scream joins Scream 2.
const soundFamily = (name: string) => clean(name).replace(/\s*\d+$/, "").trim();
const familyCounts = sounds.reduce((counts, item) => {
  const family = soundFamily(item.name);
  counts.set(family, (counts.get(family) || 0) + 1);
  return counts;
}, new Map<string, number>());
const naturalNames = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
export const libraryItems: LibraryItem[] = [
  {key:"lights:rainbow",id:-1,kind:"animation",lightEffect:"rainbow",name:"Rainbow",category:"Lights",description:"Both dome lights cycle smoothly through the rainbow until stopped."},
  ...sounds.map((item) => ({
    key: `sound:${item.id}`,
    id: item.id,
    kind: "sound" as const,
    name: clean(item.name),
    category: (familyCounts.get(soundFamily(item.name)) || 0) > 1
      ? soundFamily(item.name) : "Effects",
    sector: item.sector,
    description: `Catalog sound ${item.id}. Stored sector ${item.sector}; playback duration unknown.`,
  })),
  ...[
    ...animations,
    { id: 55, name: "Additional motor sound", group: "Additional" },
  ].map((item) => {
    const schedule = actionSchedules.find((value) => value.id === item.id);
    return {
      key: `animation:${item.id}`,
      id: item.id,
      kind: "animation" as const,
      name: clean(item.name),
      category: /^Charger\d+$/.test(clean(item.name)) ? "Charger" : item.group === "WWM" ? "Movie" : item.group,
      description: schedule
        ? `Decoded tracks: ${schedule.tracks.join(", ")}. Encoded schedule ${(schedule.scheduleMs / 1000).toFixed(2)} s; actual playback and physical completion unknown.`
        : "Movement content and completion unknown.",
    };
  }),
];
export const libraryItem = (key: string) =>
  libraryItems.find((item) => item.key === key);
export function searchLibrary({
  kind,
  category,
  query,
  favorites,
  favoritesOnly,
}: {
  kind: "sounds" | "animations" | "all";
  category: string;
  query: string;
  favorites: string[];
  favoritesOnly: boolean;
}) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return libraryItems.filter(
    (item) =>
      (kind === "all" ||
        item.kind === (kind === "sounds" ? "sound" : "animation")) &&
      (category === "All" || item.category === category) &&
      (!favoritesOnly || favorites.includes(item.key)) &&
      terms.every((term) =>
        `${item.name} ${item.category}`.toLowerCase().includes(term),
      ),
  ).sort((a, b) => naturalNames.compare(a.name, b.name));
}
export function loadFavorites(text: string | null): string[] {
  try {
    const value: unknown = JSON.parse(text || "[]");
    return Array.isArray(value)
      ? [
          ...new Set(
            value.filter(
              (key): key is string =>
                typeof key === "string" && !!libraryItem(key),
            ),
          ),
        ]
      : [];
  } catch {
    return [];
  }
}
