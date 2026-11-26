import {Details} from "../components/Details.tsx";
import { useColors, useThemedStyles } from "../theme/useColors.ts";
import type { Palette } from "../theme/appearance.ts";
import { inputTheme } from "../theme/appearance.ts";
import React, { useEffect, useRef, useState } from "react";
import {
  TextInput,
  Pressable,
  Platform,
  StyleSheet,
  Image,
} from "react-native";
import { View, Text } from "./primitives.tsx";
import type { AppPort } from "../session/types.ts";
import { experienceBackTarget } from "../navigation/legacyNavigation.ts";
import { animations } from "../../core/catalogs.ts";
import {
  TimelineSession,
  EnvironmentReactionSession,
  parseTimeline,
  importTimelineFiles,
  parseEnvironment,
  verifyEnvironment,
  demoEnvironment,
  demoTimeline,
  actionDescription,
} from "../../core/experience.ts";
import { AutomationRunner } from "../../core/automation.ts";
import {
  serializeLocalJson,
  validateLocalJsonFiles,
} from "../../core/localJson.ts";
import type {
  LocalTimeline,
  EnvironmentPack,
  EnvironmentHotspot,
  LocalJsonFile,
} from "../../core/experience.ts";

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
  const styles = useThemedStyles(make_styles);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, disabled && styles.disabled]}
    >
      <Text style={styles.buttonText}>{title}</Text>
    </Pressable>
  );
}
function loadTimeline(port: AppPort) {
  try {
    const saved = port.loadPreference("experience.timeline");
    return saved ? parseTimeline(JSON.parse(saved)) : demoTimeline;
  } catch {
    return demoTimeline;
  }
}
type InstalledPack = { pack: EnvironmentPack; sha256: string; bytes: number };
function loadPack(port: AppPort): InstalledPack | undefined {
  try {
    const saved = port.loadPreference("experience.environment");
    if (!saved) return;
    const d = JSON.parse(saved);
    return {
      pack: parseEnvironment(d.pack),
      sha256: String(d.sha256),
      bytes: Number(d.bytes),
    };
  } catch {
    return;
  }
}
async function digest(text: string, port?: AppPort) {
  if (port?.hashLocalText) return port.hashLocalText(text);
  if (!globalThis.crypto?.subtle)
    throw new Error(
      "Local SHA-256 verification requires a supported secure browser.",
    );
  const bytes = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return {
    sha256: Array.from(new Uint8Array(hash), (n) =>
      n.toString(16).padStart(2, "0"),
    ).join(""),
    bytes: bytes.length,
  };
}
const validateRaster = (uri: string) =>
  new Promise<void>((resolve, reject) =>
    Image.getSize(
      uri,
      (width, height) => {
        if (width > 0 && height > 0 && width * height <= 16000000) resolve();
        else
          reject(
            new Error("Background image must have 1 to 16 million pixels."),
          );
      },
      () =>
        reject(new Error("Local background image is corrupt or unsupported.")),
    ),
  );
const animationIds = Object.fromEntries(
  animations.map((a) => [a.name.replace(/\.bin$/, ""), a.id]),
);

export function ExperiencesPanel({
  port,
  ready,
  cancellationKey = 0,
  onRunningChange,
  registerCancel,
  beforeStart,
  registerBack,
  initialPage = "Movie Reactions",
}: {
  initialPage?: "Movie Reactions" | "Virtual Environments";
  port: AppPort;
  ready: boolean;
  cancellationKey?: number;
  onRunningChange?: (name: string) => void;
  registerCancel?: (cancel: () => void) => () => void;
  beforeStart?: () => Promise<void>;
  registerBack?: (handler: () => boolean) => () => void;
}) {
  const colors = useColors();
  const styles = useThemedStyles(make_styles);
  const {inputPalette, inputSurface} = inputTheme(colors);

  const [page, setPage] = useState<string>(initialPage);
  const [message, setMessage] = useState("");
  const [timeline, setTimeline] = useState<LocalTimeline>(() =>
    loadTimeline(port),
  );
  const [seek, setSeek] = useState("0");
  const [, refresh] = useState(0);
  const [installed, setInstalled] = useState<InstalledPack | undefined>(() =>
    loadPack(port),
  );
  const pack = installed?.pack || demoEnvironment;
  const [roomId, setRoomId] = useState(pack.startRoom);
  const [launched, setLaunched] = useState(false);
  const [selected, setSelected] = useState<EnvironmentHotspot>();
  useEffect(
    () =>
      registerBack?.(() => {
        const target = experienceBackTarget({
          page,
          launched,
          selected: !!selected,
        });
        if (target === "hotspot") {
          setSelected(undefined);
          return true;
        }
        if (target === "explorer") {
          setLaunched(false);
          return true;
        }
        if (target === "page") {
          setPage("Movie Reactions");
          return true;
        }
        return false;
      }),
    [registerBack, page, launched, selected],
  );
  const actionEpoch = useRef(0);
  const resident = useRef("");
  const reactionError = useRef("");
  const reactionRunner = useRef<AutomationRunner | undefined>(undefined);
  if (!reactionRunner.current)
    reactionRunner.current = new AutomationRunner(port, (snapshot) => {
      if (snapshot.status === "failed") {
        reactionError.current = snapshot.error || "Reaction failed";
        setMessage(reactionError.current);
      }
    });
  const latest = useRef({ ready, onRunningChange, beforeStart });
  latest.current = { ready, onRunningChange, beforeStart };
  const reported = useRef("");
  const reportedError = useRef("");
  const report = (name: string) => {
    if (reported.current === name) return;
    reported.current = name;
    latest.current.onRunningChange?.(name);
  };
  const runPort = {
    acquireSourceLease: port.acquireSourceLease
      ? (id: string) => port.acquireSourceLease!(id)
      : undefined,
    renewSourceLease: port.renewSourceLease
      ? (id: string) => port.renewSourceLease!(id)
      : undefined,
    releaseSourceLease: port.releaseSourceLease
      ? (id: string) => port.releaseSourceLease!(id)
      : undefined,
    replaceSources: async () => {
      if (!port.replaceSources)
        throw new Error("Source replacement unavailable on this platform.");
      await port.replaceSources();
    },
    armMotion: () => port.armMotion(),
    execute: (
      command: Parameters<AppPort["execute"]>[0],
      access: Parameters<AppPort["execute"]>[1],
    ) => port.execute(command, access),
    stop: () => port.stop(),
  };
  const session = useRef<TimelineSession | undefined>(undefined);
  if (!session.current)
    session.current = new TimelineSession(timeline, runPort);
  const environment = useRef<EnvironmentReactionSession | undefined>(undefined);
  if (!environment.current)
    environment.current = new EnvironmentReactionSession(runPort);
  const makeSession = (next: LocalTimeline) =>
    new TimelineSession(next, runPort);
  const operation = async (action: () => Promise<void>, success: string) => {
    try {
      await action();
      setMessage(success);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
    refresh((n) => n + 1);
  };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    let ticking = true;
    const timer = setInterval(() => {
      const run = session.current!;
      void run.tick().then(() => {
        if (!ticking) return;
        report(
          run.active || run.preparing
            ? `Movie · ${run.clock.timeline.title}`
            : resident.current,
        );
        const error = run.error || environment.current?.error;
        if (error && error !== reportedError.current) {
          reportedError.current = error;
          resident.current = "";
          report("");
          setMessage(error);
        }
        refresh((n) => n + 1);
      });
    }, 50);
    return () => {
      ticking = false;
      mounted.current = false;
      actionEpoch.current++;
      const active =
        !!resident.current ||
        session.current?.active ||
        session.current?.preparing ||
        environment.current?.active;
      resident.current = "";
      void environment.current?.cancel(false);
      void reactionRunner.current?.cancel(false);
      clearInterval(timer);
      void session.current?.pause(false);
      if (active) void port.stop().catch(() => {});
      report("");
    };
  }, [port]);
  useEffect(
    () =>
      registerCancel?.(() => {
        actionEpoch.current++;
        resident.current = "";
        void environment.current?.cancel(false);
        void reactionRunner.current?.cancel(false);
        void session.current?.pause(false);
        report("");
        refresh((n) => n + 1);
      }),
    [registerCancel],
  );
  useEffect(() => {
    actionEpoch.current++;
    resident.current = "";
    void environment.current?.cancel(false);
    void reactionRunner.current?.cancel(false);
    void session.current?.pause(false);
    report("");
    refresh((n) => n + 1);
  }, [cancellationKey, ready]);
  const importTimeline = async (value: unknown) =>
    saveTimeline(
      importTimelineFiles(
        [{ name: "timeline.json", text: JSON.stringify(value) }],
        animationIds,
      ),
    );
  const saveTimeline = async (next: LocalTimeline) => {
    if (session.current!.active || session.current!.preparing) {
      stopLocal();
      await session.current!.pause();
    }
    await port.savePreference("experience.timeline", serializeLocalJson(next));
    session.current = makeSession(next);
    setTimeline(next);
    setSeek("0");
  };
  const importPack = async (value: unknown) => {
    const next = await verifyEnvironment(
      value,
      (text) => digest(text, port),
      validateRaster,
    );
    const serialized = serializeLocalJson(next);
    const hash = await digest(serialized, port);
    const complete = { pack: next, ...hash };
    // One storage write after every room/action has passed validation: failed installs
    // retain the previous complete pack and never issue droid operations.
    await port.savePreference("experience.environment", JSON.stringify(complete));
    setInstalled(complete);
    setRoomId(next.startRoom);
    setLaunched(false);
    setSelected(undefined);
  };
  const importFiles = async (
    kind: "timeline" | "environment",
    files: LocalJsonFile[],
  ) => {
    validateLocalJsonFiles(files);
    if (kind === "timeline")
      await saveTimeline(importTimelineFiles(files, animationIds));
    else {
      if (files.length !== 1)
        throw new Error("Choose one self-contained environment manifest.");
      await importPack(JSON.parse(files[0].text));
    }
  };
  const fileInput = (kind: "timeline" | "environment") =>
    Platform.OS === "web" ? (
      React.createElement("input", {
        type: "file",
        multiple: kind === "timeline",
        accept: ".json,application/json",
        "aria-label":
          kind === "timeline"
            ? "Import local timeline JSON files"
            : "Import local environment JSON",
        style: { minHeight: Platform.OS === "web" ? 32 : 44, maxWidth: "100%" },
        onChange: async (event: React.ChangeEvent<HTMLInputElement>) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          if (!files.length) return;
          await operation(
            async () => {
              if (
                files.length > 3 ||
                files.reduce((sum, f) => sum + f.size, 0) > 2_000_000
              )
                throw new Error(
                  "Choose at most three JSON files totaling at most 2 MB.",
                );
              await importFiles(
                kind,
                await Promise.all(
                  files.map(async (file) => ({
                    name: file.name,
                    text: await file.text(),
                  })),
                ),
              );
            },
            `${kind === "timeline" ? "Timeline" : "Environment"} validated and saved locally.`,
          );
        },
      })
    ) : (
      <Button
        title={`Import local ${kind} JSON`}
        disabled={!port.importLocalJsonFiles && !port.importLocalJson}
        onPress={() =>
          void operation(async () => {
            const files = port.importLocalJsonFiles
              ? await port.importLocalJsonFiles()
              : [{ name: "local.json", text: await port.importLocalJson!() }];
            await importFiles(kind, files);
          }, `${kind} validated and saved locally.`)
        }
      />
    );
  const exportJson = async (name: string, value: unknown) => {
    const text = serializeLocalJson(value);
    if (port.exportLocalJson) {
      await port.exportLocalJson(name, text);
      return;
    }
    if (Platform.OS !== "web")
      throw new Error("Local export unavailable on this platform.");
    const url = URL.createObjectURL(
      new Blob([text], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const clock = session.current.clock;
  const running = clock.running || session.current.preparing;
  const room = pack.rooms.find((r) => r.id === roomId) || pack.rooms[0];
  const background = pack.assets?.find((a) => a.id === room.background);
  const selectedRecipe = pack.recipes?.find(
    (r) => r.id === selected?.recipeId,
  )?.recipe;
  const stopLocal = () => {
    resident.current = "";
    void environment.current?.cancel(false);
    void reactionRunner.current?.cancel(false);
    report("");
  };
  useEffect(
    () =>
      port.registerExperience?.("timeline", {
        label: `Movie · ${timeline.title}`,
        start: async () => {
          if (!mounted.current || !latest.current.ready)
            throw new Error("Experience screen closed; use a fresh start.");
          reportedError.current = "";
          session.current!.error = "";
          resident.current = `Movie · ${timeline.title}`;
          report(resident.current);
          await session.current!.start();
        },
        cancel: () => {
          void session.current?.pause(false);
        },
      }),
    [port, timeline],
  );
  const prepareLocal = async (name: string) => {
    const intent = ++actionEpoch.current;
    await latest.current.beforeStart?.();
    if (
      !mounted.current ||
      intent !== actionEpoch.current ||
      !latest.current.ready
    )
      throw new Error("Start canceled; use a fresh action.");
    reportedError.current = "";
    session.current!.error = "";
    environment.current!.error = "";
    resident.current = name;
    report(name);
  };
  const playReaction = async () => {
    if (!selected) return;
    await prepareLocal(`Environment · ${selected.title}`);
    const intent = ++actionEpoch.current;
    try {
      await session.current!.pause(false);
      if (selectedRecipe) {
        reactionError.current = "";
        await reactionRunner.current!.play(selectedRecipe);
        if (reactionError.current) throw new Error(reactionError.current);
      } else {
        if (intent !== actionEpoch.current || !latest.current.ready)
          throw new Error("Reaction canceled by STOP or disconnect.");
        await environment.current!.play(selected.action!);
      }
    } catch (error) {
      if (intent === actionEpoch.current) stopLocal();
      throw error;
    }
  };
  const selectedDescription = selected?.action
    ? actionDescription(selected.action)
    : selectedRecipe
      ? `Protocol ${selectedRecipe.name} · ${selectedRecipe.steps.length} steps · ${selectedRecipe.steps.some((s) => ["drive", "head", "stance", "animation"].includes(s.action.type)) ? "may move the droid" : "lights/audio/waits only"}`
      : "Missing protocol";
  return (
    <View style={styles.root}>
      <View style={styles.row}>
        {["Movie Reactions", "Virtual Environments"].map((name) => (
          <Button
            key={name}
            title={page === name ? `${name} · selected` : name}
            onPress={() => setPage(name)}
          />
        ))}
      </View>
      {!!message && <Text accessibilityLiveRegion="polite">{message}</Text>}
      {page === "Movie Reactions" ? (
        <>
          <View style={styles.card}>
            <Text style={styles.title}>{timeline.title}</Text>
            <Text>{timeline.language} · {timeline.edition} · {timeline.cues.length} cues</Text>
            <Text>
              Match this specific edition and language. Title alone does not
              establish synchronization. Animation cues may move the droid.
            </Text>
            <Text accessibilityLiveRegion="polite">
              {session.current.preparing
                ? "Preparing"
                : clock.running
                  ? "Running"
                  : session.current.active
                    ? "All cues requested; completion unknown"
                    : "Paused"}{" "}
              · {(clock.positionMs / 1000).toFixed(1)} seconds
            </Text>
            <Button
              title="Stop current sources and start / resume timeline"
              disabled={
                !ready ||
                running ||
                !port.replaceSources ||
                !timeline.cues.length
              }
              onPress={() =>
                void operation(async () => {
                  try {
                    if (!port.startExperience)
                      throw new Error("Experience session unavailable");
                    await port.startExperience("timeline");
                  } catch (error) {
                    stopLocal();
                    throw error;
                  }
                }, "Timeline started from the selected position.")
              }
            />
            <Button
              title="Pause timeline and stop droid"
              disabled={!ready && !running}
              onPress={() =>
                void operation(async () => {
                  stopLocal();
                  await session.current!.pause();
                }, "Timeline paused; STOP requested. Verify the droid stopped.")
              }
            />
            {Platform.OS === "web" ? (
              React.createElement(
                "label",
                { htmlFor: "experience-seek" },
                "Movie position in seconds",
              )
            ) : (
              <Text>Movie position in seconds</Text>
            )}
            <TextInput
              cursorColor={inputPalette.caret}
              selectionColor={inputPalette.selection}
              placeholderTextColor={inputPalette.placeholder}
              nativeID="experience-seek"
              accessibilityLabel="Movie position in seconds"
              value={seek}
              onChangeText={setSeek}
              style={styles.input}
            />
            <Button
              title="Seek / resynchronize and pause"
              onPress={() =>
                void operation(async () => {
                  if (
                    !seek.trim() ||
                    !Number.isFinite(Number(seek)) ||
                    Number(seek) < 0 ||
                    Number(seek) > 86400
                  )
                    throw new Error("Enter 0 to 86400 seconds.");
                  stopLocal();
                  if (ready) await session.current!.seek(Number(seek) * 1000);
                  else {
                    await session.current!.pause(false);
                    session.current!.clock.seek(Number(seek) * 1000);
                  }
                }, "Position changed; skipped cues were not replayed. Start explicitly to resume.")
              }
            />
            <Details title="Timeline behavior">
            <Text>
              Pause, seek, STOP and disconnect cancel pending cues. Late cues
              pause after suspension. Manual timing works offline. Compatibility
              details are retained in timeline files.
            </Text>
            </Details>
          </View>
          <Details title="Timeline files & compatibility">
          <View style={styles.card}>
            <Text style={styles.title}>Local timeline manager</Text>
            {fileInput("timeline")}
            <Text>
              Local JSON imports and compact exports share a limit of 2,000,000
              UTF-8 bytes on Chrome and Android. Version 1 JSON: title,
              language, edition and cues [atMs, action]. Actions: animation
              (id), audio (sector), head (degrees), lights (eight values). For
              recovered files, select the unchanged TimeLineData JSON, EventData
              JSON and your compatibility metadata JSON together. Metadata must
              state title, language and exact edition. A single wrapper
              containing timeline and eventData is also supported. Duplicate
              timestamps keep the last entry, then sort by time.
            </Text>
            <Button
              title="Export current timeline JSON"
              onPress={() =>
                void operation(
                  () => exportJson("local-timeline.json", timeline),
                  "Timeline export requested; confirm its destination in the system picker.",
                )
              }
            />
            <Button
              title="Export compatibility metadata template"
              onPress={() =>
                void operation(
                  () =>
                    exportJson("movie-compatibility.json", {
                      title: "Your film title",
                      language: "Your soundtrack language",
                      edition: "Your exact release / edition",
                    }),
                  "Metadata template export requested. Replace placeholders with the matching film edition before importing.",
                )
              }
            />
            <Button
              title="Restore original light demo"
              onPress={() =>
                void operation(
                  () => importTimeline(demoTimeline),
                  "Original demo saved locally.",
                )
              }
            />
          </View>
          </Details>
          <Details title="Cue review">
          {timeline.cues.slice(0, 100).map((c) => (
            <View style={styles.cue} key={c.atMs}>
              <Text>
                {(c.atMs / 1000).toFixed(1)} s · {actionDescription(c.action)}
              </Text>
            </View>
          ))}
          {timeline.cues.length > 100 && (
            <Text>
              First 100 of {timeline.cues.length} cues shown; the complete
              validated schedule is loaded.
            </Text>
          )}
          </Details>
        </>
      ) : (
        <>
          <View style={styles.card}>
            <Text style={styles.title}>{pack.title}</Text>
            <Text>
              Self-contained scene pack v{pack.version} · compatible app
              contract {pack.appVersion} · {pack.rooms.length} rooms
            </Text>
            <Text>
              Virtual scenery; no physical sensor readings. Exploring rooms
              sends no droid command. Choose a hotspot to review its action
              before playing.
            </Text>
            {installed && (
              <>
                <Text>
                  {installed.bytes} bytes · {pack.assets?.length || 0} embedded
                  assets · {pack.recipes?.length || 0} protocols · SHA-256
                </Text>
                <Text selectable style={styles.hash}>
                  {installed.sha256}
                </Text>
              </>
            )}
            <Button
              title="Validate pack and launch explorer"
              onPress={() =>
                void operation(async () => {
                  await verifyEnvironment(
                    pack,
                    (text) => digest(text, port),
                    validateRaster,
                  );
                  if (installed) {
                    const hash = await digest(JSON.stringify(pack), port);
                    if (
                      hash.sha256 !== installed.sha256 ||
                      hash.bytes !== installed.bytes
                    )
                      throw new Error(
                        "Local pack hash/size mismatch. Reimport your pack.",
                      );
                  }
                  setRoomId(pack.startRoom);
                  setSelected(undefined);
                  setLaunched(true);
                }, "All local rooms and reactions validated.")
              }
            />
          </View>
          {launched && (
            <View style={styles.card}>
              <Text style={styles.title}>{room.title}</Text>
              <View
                accessibilityLabel={`Virtual scene: ${room.title}`}
                style={[styles.scene, { backgroundColor: room.color }]}
              >
                {background?.kind === "raster" && (
                  <Image
                    source={{ uri: background.uri }}
                    resizeMode="cover"
                    accessibilityLabel={`${room.title} local background`}
                    style={StyleSheet.absoluteFill}
                  />
                )}
                {background?.kind === "vector" &&
                  background.elements.map((e, i) => (
                    <View
                      key={i}
                      style={{
                        position: "absolute",
                        left: `${e.x * 100}%`,
                        top: `${e.y * 100}%`,
                        width: `${e.width * 100}%`,
                        height: `${e.height * 100}%`,
                        backgroundColor: e.fill,
                        borderRadius: e.shape === "ellipse" ? 999 : 0,
                      }}
                    />
                  ))}
                {room.hotspots.map((h) => (
                  <View
                    key={h.id}
                    style={{
                      position: "absolute",
                      left: `${Math.min(75, h.x * 100)}%`,
                      top: `${Math.min(65, h.y * 100)}%`,
                      maxWidth: "65%",
                    }}
                  >
                    <Button title={h.title} onPress={() => setSelected(h)} />
                  </View>
                ))}
              </View>
              <Text>{room.description}</Text>
              <Text>Exits</Text>
              <View style={styles.row}>
                {room.exits.map((id) => (
                  <Button
                    key={id}
                    title={`Explore ${pack.rooms.find((r) => r.id === id)!.title}`}
                    onPress={() => {
                      setRoomId(id);
                      setSelected(undefined);
                    }}
                  />
                ))}
              </View>
              {selected && (
                <View style={styles.card}>
                  <Text style={styles.title}>{selected.title}</Text>
                  <Text>{selectedDescription}</Text>
                  <Button
                    title="Stop current sources and play reaction"
                    disabled={!ready || !port.replaceSources}
                    onPress={() =>
                      void operation(
                        playReaction,
                        "Reaction requested; physical completion unknown.",
                      )
                    }
                  />
                </View>
              )}
            </View>
          )}
          <View style={styles.card}>
            <Text style={styles.title}>Local pack manager</Text>
            {fileInput("environment")}
            <Text>
              Install validates the whole self-contained JSON manifest before
              saving. Chrome and Android limit imports and compact exports to
              2,000,000 UTF-8 bytes. Backgrounds embed local PNG/JPEG/WebP
              raster data or normalized vector rectangles/ellipses with SHA-256
              hashes. Hotspots can reference allowlisted protocols. Missing
              assets or protocols prevent installation; no content download is
              attempted.
            </Text>
            {installed && (
              <Button
                title="Remove imported environment pack"
                onPress={async () => {
                  try {
                  await port.savePreference("experience.environment", "");
                  setSelected(undefined);
                  setLaunched(false);
                  setInstalled(undefined);
                  setRoomId(demoEnvironment.startRoom);
                  setMessage(
                    "Imported pack removed; original demo remains available. Saved protocols are unchanged.",
                  );
                  } catch(error) { setMessage(String(error)); }
                }}
              />
            )}
            <Button
              title="Export environment manifest JSON"
              onPress={() =>
                void operation(
                  () => exportJson("local-environment.json", pack),
                  "Environment export requested; confirm its destination in the system picker.",
                )
              }
            />
            <Text>
              The original demo is independently authored. Original Unity/Falcon
              assets and arbitrary 3D bundles are not bundled or executable
              here.
            </Text>
          </View>
        </>
      )}
    </View>
  );
}
const make_styles = (colors: Palette) => {
  const {inputSurface} = inputTheme(colors);
  return StyleSheet.create({
  root: { gap: 8 },
  card: {
    borderWidth: 1,
    borderColor: colors.line2,
    borderRadius: 10,
    padding: 10,
    backgroundColor: colors.panel,
    gap: 8,
    marginVertical: 3,
  },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  title: { fontSize: 17, fontWeight: "600", color: colors.text },
  button: {
    minHeight: Platform.OS === "web" ? 32 : 44,
    padding: 8,
    backgroundColor: colors.panelRaised,
    borderRadius: 7,
    justifyContent: "center",
    marginVertical: 2,
  },
  buttonText: {
    color: colors.text,
    fontWeight: "600",
    fontSize: 14,
    textAlign: "center",
  },
  disabled: { backgroundColor: colors.panelRaised, opacity: 0.45 },
  input: {
    ...inputSurface,
    borderWidth: 1,
    borderColor: colors.line2,
    minHeight: Platform.OS === "web" ? 32 : 44,
    padding: 8,
    fontSize: 14,
    borderRadius: 5,
  },
  cue: { paddingVertical: 8, borderBottomWidth: 1, borderColor: colors.line },
  scene: {
    height: 260,
    borderRadius: 8,
    position: "relative",
    overflow: "hidden",
  },
  hash: { fontSize: 12, fontFamily: "monospace" },
});
};
