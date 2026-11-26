import React, { useEffect, useRef, useState } from "react";
import { AppState, Platform } from "react-native";
import { PathTraversal, previewPosition, readPathDraft, canvasPoint } from "./pathEditor.ts";
import { previewPath, parsePathDraft, serializePathDraft } from "../../core/automation.ts";
import type { PathPoint } from "../../core/automation.ts";
import type { PathsProps } from "../screens/Paths.tsx";
import { readPathEditor, serializePathEditor } from "./pathPersistence.ts";
export function usePathEditor(
  { port, onMessage, stopToken = 0 }: Pick<PathsProps, "port" | "onMessage" | "stopToken">,
  cancelLive?: () => void,
) {
  const [savedRead] = useState(() => {
    try {
      return {
        ...readPathEditor(port),
        error: undefined as string | undefined,
      };
    } catch (error) {
      return {
        draft: readPathDraft(undefined),
        spacing: "2",
        error: `Saved path could not be read. Saving is blocked to preserve existing data. ${String(error)}`,
      };
    }
  });
  const saved = savedRead.draft;
  const [points, setPoints] = useState(saved.points),
    [speed, setSpeed] = useState(String(saved.speedPercent)),
    [orientation, setOrientation] = useState(String(saved.startOrientation));
  const [selected, setSelected] = useState(-1),
    [x, setX] = useState("50"),
    [y, setY] = useState("50"),
    [transfer, setTransfer] = useState(""),
    [review, setReview] = useState<ReturnType<typeof parsePathDraft>>();
  const [spacing, setSpacing] = useState(savedRead.spacing);
  const [saving, setSaving] = useState(false);
  const savePending = useRef(false);
  const currentDraft = useRef("");
  currentDraft.current = JSON.stringify({ points, speed, orientation, spacing });
  const [drawing, setDrawing] = useState(true),
    [width, setWidth] = useState(600),
    [canvasHeight, setCanvasHeight] = useState(280),
    [confirmClear, setConfirmClear] = useState(false),
    [traversal] = useState(() => new PathTraversal()),
    [run, setRun] = useState(traversal.snapshot);
  const attempt = async (action: () => void | Promise<void>) => {
    try {
      await action();
    } catch (error) {
      onMessage(error instanceof Error ? error.message : String(error));
    }
  };
  const stop = () => {
    cancelLive?.();
    setRun({ ...traversal.stop() });
  };
  useEffect(() => {
    stop();
  }, [stopToken]);
  useEffect(() => {
    const timer = setInterval(() => setRun({ ...traversal.tick(performance.now()) }), 50);
    const pause = () => setRun({ ...traversal.pause(performance.now()) });
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active") pause();
    });
    if (Platform.OS === "web") window.addEventListener("blur", pause);
    return () => {
      clearInterval(timer);
      sub.remove();
      if (Platform.OS === "web") window.removeEventListener("blur", pause);
      traversal.stop();
    };
  }, [traversal]);
  const draft = () => {
    if (!speed.trim() || !orientation.trim()) throw new Error("Enter speed and orientation.");
    return parsePathDraft(
      serializePathDraft({
        version: 1,
        units: "preview",
        points,
        speedPercent: Number(speed),
        startOrientation: Number(orientation),
      }),
    );
  };
  const save = async () => {
    if (savePending.current || savedRead.error) return;
    const value = serializePathEditor(draft(), spacing);
    const submittedDraft = currentDraft.current;
    savePending.current = true;
    setSaving(true);
    try {
      await port.savePreference("automation.path.v1", value);
      onMessage(
        currentDraft.current === submittedDraft
          ? "Path draft, waypoint order, speed, orientation and drawing spacing saved."
          : "Path draft saved. Newer edits are not saved.",
      );
    } finally {
      savePending.current = false;
      setSaving(false);
    }
  };
  const change = (next: PathPoint[]) => {
    stop();
    setPoints(next);
  };
  const select = (index: number) => {
    setSelected(index);
    setX(String(points[index].x));
    setY(String(points[index].y));
  };
  const coordinate = () => {
    if (!x.trim() || !y.trim() || !Number.isFinite(Number(x)) || !Number.isFinite(Number(y)))
      throw new Error("Enter finite X and Y coordinates.");
    return { x: Number(x), y: Number(y) };
  };
  const append = (point: PathPoint) => {
    if (points.length >= 256) throw new Error("A path supports at most 256 waypoints.");
    change([...points, point]);
    setSelected(points.length);
    setX(String(point.x));
    setY(String(point.y));
  };
  let segments: ReturnType<typeof previewPath> = [],
    validation = "";
  try {
    const value = draft();
    segments = previewPath(value.points, value.speedPercent, value.startOrientation);
    validation = segments.length
      ? `${segments.length} segments validated · ${segments.reduce((n, p) => n + p.length, 0).toFixed(1)} preview units`
      : "Add two distinct waypoints";
  } catch (error) {
    validation = String(error);
  }
  const position = previewPosition(points, run.progress, Number(orientation) || 0);
  const bounds = points.reduce(
    (b, p) => ({
      minX: Math.min(b.minX, p.x - 20),
      minY: Math.min(b.minY, p.y - 20),
      maxX: Math.max(b.maxX, p.x + 20),
      maxY: Math.max(b.maxY, p.y + 20),
    }),
    { minX: 0, minY: 0, maxX: width, maxY: 280 },
  );
  const spanX = bounds.maxX - bounds.minX,
    spanY = bounds.maxY - bounds.minY;
  const addFromPointer = (event: { nativeEvent: { locationX: number; locationY: number } }) => {
    if (!drawing) return;
    const { locationX, locationY } = event.nativeEvent;
    attempt(() => append(canvasPoint(locationX, locationY, width, canvasHeight, bounds)));
  };

  return {
    port,
    onMessage,
    cancelLive,
    points,
    setPoints,
    speed,
    setSpeed,
    orientation,
    setOrientation,
    selected,
    setSelected,
    x,
    setX,
    y,
    setY,
    transfer,
    setTransfer,
    review,
    setReview,
    spacing,
    setSpacing,
    drawing,
    setDrawing,
    width,
    setWidth,
    canvasHeight,
    setCanvasHeight,
    confirmClear,
    setConfirmClear,
    traversal,
    run,
    setRun,
    attempt,
    stop,
    draft,
    save,
    saving,
    saveBlocked: !!savedRead.error,
    change,
    select,
    coordinate,
    append,
    segments,
    validation: [savedRead.error, validation].filter(Boolean).join(" "),
    position,
    bounds,
    spanX,
    spanY,
    addFromPointer,
  };
}
export type PathEditor = ReturnType<typeof usePathEditor>;
