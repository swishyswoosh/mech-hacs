import { parsePathDraft, serializePathDraft } from "../../core/automation.ts";
import type { PathDraft } from "../../core/automation.ts";
import { readPathDraft } from "./pathEditor.ts";

type PreferenceReader = { loadPreference(key: string): string | null };

function drawingSpacing(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0.25 || value > 100)
    throw new Error("Drawing spacing must be 0.25–100 preview units.");
  return value;
}

/** Legacy reads neither migrate nor discard saved bytes; invalid data blocks saving. */
export function readPathEditor(reader: PreferenceReader): { draft: PathDraft; spacing: string } {
  const text = reader.loadPreference("automation.path.v1");
  const value = text === null ? undefined : JSON.parse(text);
  const draft = readPathDraft(text);
  if (value && Object.prototype.hasOwnProperty.call(value, "editor")) {
    if (!value.editor || value.editor.version !== 1)
      throw new Error("Unsupported saved path editor settings.");
    return {
      draft: cleanDraft(draft),
      spacing: String(drawingSpacing(value.editor.drawingSpacing)),
    };
  }
  const legacySpacing = reader.loadPreference("automation.path.spacing.v1");
  if (legacySpacing !== null && !legacySpacing.trim())
    throw new Error("Saved path spacing is empty.");
  return {
    draft: cleanDraft(draft),
    spacing: legacySpacing === null ? "2" : String(drawingSpacing(Number(legacySpacing))),
  };
}

function cleanDraft(draft: PathDraft): PathDraft {
  return {
    version: 1,
    units: "preview",
    points: draft.points.map((point) => ({ x: point.x, y: point.y })),
    speedPercent: draft.speedPercent,
    startOrientation: draft.startOrientation,
  };
}

/** One preference commit retains the ordinary version-1 path file shape. */
export function serializePathEditor(draft: PathDraft, spacing: string): string {
  if (!spacing.trim()) throw new Error("Enter drawing spacing.");
  const validated = parsePathDraft(serializePathDraft(cleanDraft(draft)));
  return JSON.stringify({
    ...validated,
    editor: { version: 1, drawingSpacing: drawingSpacing(Number(spacing)) },
  });
}
