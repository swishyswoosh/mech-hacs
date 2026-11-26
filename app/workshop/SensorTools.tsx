import {DepotDetails} from "./CompactLayout.tsx";
import { useColors, useThemedStyles } from "../theme/useColors.ts";
import type { Palette } from "../theme/appearance.ts";
import { inputTheme } from "../theme/appearance.ts";
import React, { useEffect, useState, useRef } from "react";
import { TextInput, Pressable, StyleSheet, Platform } from "react-native";
import { View, Text } from "./primitives.tsx";
import { sensorFreshnessMs } from "../../core/sensorSession.ts";
import { streamFields, DEFAULT_SENSOR_BUDGET } from "../../core/index.ts";
import { useSensorCapture } from "./SensorCapture.tsx";
import type { AppSnapshot, AppPort } from "../session/types.ts";
import {
  prepareSensorExports,
  saveSensorExportPart,
  startSensorRecording,
} from "./sensorExport.ts";
import type {
  SensorExportPart,
  SavedSensorCapture,
} from "./sensorExport.ts";
import { SensorDetails } from "./SensorDetails.tsx";
import { PoseTracePanel } from "./PoseTracePanel.tsx";
import { sensorPages, sensorView } from "./sensorViews.ts";
export function useSensorTools({
  snapshot,
  port,
  onRecordingChange,
  stopToken = 0,
  onStartSensors,
  onStopSensors,
  registerBack,
  onOpenService,
  visible = true,
}: {
  visible?: boolean;
  snapshot: AppSnapshot;
  port: AppPort;
  stopToken?: number;
  onRecordingChange?: (recording: boolean) => void;
  onStartSensors: () => void;
  onStopSensors: () => void;
  registerBack?: (handler: () => boolean) => () => void;
  onOpenService?: () => void;
}) {
  const colors = useColors();
  const s = useThemedStyles(make_s);
  const {inputPalette, inputSurface} = inputTheme(colors);

  const [visibleInterval, setVisibleInterval] = useState(50);
  const {
    recording,
    trace,
    recordingFields,
    setRecordingFields,
    recordingInterval,
    setRecordingInterval,
    refresh,
    recordingSubscriptionMessage,
  } = useSensorCapture();
  const [subscriptionMessage, setSubscriptionMessage] = useState("");
  const [page, setPage] = useState("Motion"),
    [search, setSearch] = useState(""),
    [selected, setSelected] = useState("accelerometer.x");

  const [exportParts, setExportParts] = useState<SensorExportPart[]>([]),
    [exportIndex, setExportIndex] = useState(0),
    [exportMessage, setExportMessage] = useState(""),
    [exportBusy, setExportBusy] = useState(false);
  const saving = useRef(false),
    exportSnapshot = useRef<SavedSensorCapture | undefined>(undefined),
    savedCapture = useRef<SavedSensorCapture | undefined>(undefined);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  useEffect(
    () =>
      registerBack?.(() => {
        if (confirmDiscard) {
          setConfirmDiscard(false);
          return true;
        }
        if (page === "Motion") return false;
        setPage("Motion");
        setSelected("accelerometer.x");
        return true;
      }),
    [registerBack, page, confirmDiscard],
  );
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);
  const sensors = snapshot.sensors,
    ready = snapshot.state === "ready";
  const button = (title: string, run: () => void, disabled = false) => (
    <Pressable
      key={title}
      accessibilityRole="button"
      disabled={disabled}
      accessibilityState={{ disabled }}
      onPress={run}
      style={[s.button, disabled && { opacity: 0.55 }]}
    >
      <Text style={{ color: colors.text }}>{title}</Text>
    </Pressable>
  );
  const prepareExport = () => {
    if (saving.current) return;
    try {
      const parts = prepareSensorExports(recording);
      exportSnapshot.current = {
        records: recording.records,
        count: recording.records.length,
      };
      setExportParts(parts);
      setExportIndex(0);
      setExportMessage(
        `Prepared ${parts.length} JSON ${parts.length === 1 ? "file" : "files"} from ${recording.records.length} records. Review the snapshot details, then save each part explicitly.`,
      );
    } catch (error) {
      setExportParts([]);
      setExportMessage(error instanceof Error ? error.message : String(error));
    }
  };
  const savePart = () => {
    if (saving.current || !exportParts[exportIndex]) return;
    saving.current = true;
    setExportBusy(true);
    const part = exportParts[exportIndex],
      index = exportIndex;
    void (async () => {
      try {
        await saveSensorExportPart(part, async (name, text) => {
          if (port.exportLocalJson) {
            await port.exportLocalJson(name, text);
            return;
          }
          if (Platform.OS !== "web")
            throw new Error(
              "System Save As is unavailable on this device. No file was written.",
            );
          const url = URL.createObjectURL(
            new Blob([text], { type: "application/json" }),
          );
          const anchor = document.createElement("a");
          anchor.href = url;
          anchor.download = name;
          anchor.click();
          setTimeout(() => URL.revokeObjectURL(url), 0);
        });
        if (port.exportLocalJson && index + 1 === exportParts.length)
          savedCapture.current = exportSnapshot.current;
        setExportIndex(index + 1);
        setExportMessage(
          `${port.exportLocalJson ? "Saved" : "Download requested for"} part ${index + 1} of ${exportParts.length}.${index + 1 < exportParts.length ? " Save the next part explicitly to preserve the whole snapshot." : " All snapshot parts have been exported."}`,
        );
      } catch (error) {
        setExportMessage(
          `${error instanceof Error ? error.message : String(error)} Part ${index + 1} remains ready to retry; the recording is unchanged.`,
        );
      } finally {
        saving.current = false;
        setExportBusy(false);
      }
    })();
  };
  const startRecording = (allowDiscard = false) => {
    if (
      !startSensorRecording(
        recording,
        snapshot.state,
        allowDiscard,
        savedCapture.current,
      )
    ) {
      setConfirmDiscard(true);
      return;
    }
    setConfirmDiscard(false);
    recording.markSelection(recordingFields, recordingInterval);
    onRecordingChange?.(true);
    refresh((value) => value + 1);
  };
  const view = sensorView(page, search),
    samples = recording.samples;
  const visibleNames = sensorView(page, "").fields.map((field) => field.name),
    visibleKey = visibleNames.join("|"),
    recordingKey = recordingFields.join("|");
  useEffect(() => {
    if (!port.setSensorConsumer) return;
    void port
      .setSensorConsumer(
        "visible",
        visible && visibleNames.length
          ? { fields: visibleNames, intervalMs: visibleInterval }
          : null,
      )
      .catch((error) => setSubscriptionMessage(String(error)));
  }, [port, visible, page, visibleKey, visibleInterval]);
  useEffect(
    () => () => {
      void port.setSensorConsumer?.("visible", null);
    },
    [port],
  );

  const chart = samples.flatMap((sample) =>
      Number.isFinite(sample.values[selected]) ? [sample.values[selected]] : [],
    ),
    min = Math.min(...chart),
    max = Math.max(...chart);
  const chars = "▁▂▃▄▅▆▇█",
    spark = chart
      .map(
        (value) =>
          chars[
            max === min
              ? 3
              : Math.min(7, Math.floor(((value - min) / (max - min)) * 7))
          ],
      )
      .join("");
  const elapsed =
    samples.length > 1 ? samples[samples.length - 1].at - samples[0].at : 0;
  return (
    <View style={s.card}>
      <Text style={s.title}>Sensors</Text>
      <DepotDetails title="Stream schema and bandwidth details">
      <Text>
        34 stream slots include physical inputs, estimates and unresolved
        scalars. Values retain raw wire units. Visible and recording requests
        share one stream. The standard cockpit stream changes rate automatically
        without reconnecting; cockpit uses 1 Hz and this panel defaults to 20 Hz.
        Apply reconnects stopped only to install a different channel schema.
      </Text>
      <Text>
        Static bandwidth budget: {DEFAULT_SENSOR_BUDGET.toLocaleString()}{" "}
        bytes/s · policy estimate, not measured throughput. Worst-case escaping,
        framing and ATT overhead are included. Actual delivery is reported from
        received samples.
      </Text>
      </DepotDetails>
      <View style={s.row}>
      {button(
        "Apply sensor requests (reconnect stopped)",
        onStartSensors,
        !ready || !port.startSensors,
      )}
      {button("Stop sensor stream", onStopSensors, !ready || !port.stopSensors)}
      <Text>Visible rate</Text>
        {[25, 50, 100].map((interval) =>
          button(
            `${1000 / interval} Hz${visibleInterval === interval ? " selected" : ""}`,
            () => setVisibleInterval(interval),
          ),
        )}
      </View>
      <Text>
        {snapshot.sensorPlan
          ? `${snapshot.sensorPlan.fieldNames.length} merged channels · requested ${1000 / snapshot.sensorPlan.requestedIntervalMs} Hz · budgeted ${(1000 / snapshot.sensorPlan.intervalMs).toFixed(1)} Hz${snapshot.sensorPlan.adapted ? " (bandwidth adapted)" : ""}`
          : "No channels requested"}
      </Text>
      <Text>
        {snapshot.sensorPlanPending
          ? "Subscription changes pending: Apply to reconnect stopped and install them."
          : "Requested schema matches the installed stream."}{" "}
        {subscriptionMessage} {recordingSubscriptionMessage}
      </Text>
      <Text>
        {sensors?.status || "Not streaming"} · invalid samples{" "}
        {sensors?.invalid || 0}
      </Text>
      {sensors?.sampleAt !== undefined && (
        <Text>
          Sample age {Math.max(0, clock - sensors.sampleAt)} ms ·{" "}
          {sensors.status !== "streaming" ||
          clock - sensors.sampleAt > sensorFreshnessMs(sensors.intervalMs)
            ? "STALE"
            : "fresh"}
        </Text>
      )}
      <View style={s.row}>
        {sensorPages.map((name) =>
          button(name, () => {
            setPage(name);
            if (name === "All Fields") setVisibleInterval(50);
            const first = sensorView(name, "").fields[0];
            if (first) setSelected(first.name);
          }),
        )}
      </View>
      <View testID={`sensor-subpage-${page}`}>
        <Text style={s.title}>{page}</Text>
        <SensorDetails
          page={page}
          snapshot={snapshot}
          port={port}
          clock={clock}
          onOpenService={onOpenService}
        />
        {view.kind === "fields" && (
          <>
            {page === "All Fields" && (
              <View>
                <>
                  {Platform.OS === "web" ? (
                    React.createElement(
                      "label",
                      { htmlFor: "sensor-search" },
                      "Search sensor fields",
                    )
                  ) : (
                    <Text>Search sensor fields</Text>
                  )}
                </>
                <TextInput
                  cursorColor={inputPalette.caret}
                  selectionColor={inputPalette.selection}
                  placeholderTextColor={inputPalette.placeholder}
                  nativeID="sensor-search"
                  accessibilityLabel="Search sensor fields"
                  value={search}
                  onChangeText={setSearch}
                  style={s.input}
                />
              </View>
            )}
            {view.fields.map((field) => (
              <View key={field.name} style={s.reading}>
                <Text selectable style={{flex: 1, minWidth: 180}}>
                  {field.name}: {sensors?.values[field.name] ?? "—"} raw
                  {/^(locator|velocity)\./.test(field.name) &&
                  sensors?.values[field.name] !== undefined
                    ? ` · APK scale ${sensors.values[field.name] * 100}`
                    : ""}
                </Text>
                {button(`Chart ${field.name}`, () => setSelected(field.name))}
              </View>
            ))}
            <DepotDetails title="Sensor field masks">
              {view.fields.map(field => <Text key={field.name} selectable>{field.name} · {field.set} bit {field.bit} · mask 0x{(2 ** field.bit).toString(16)}</Text>)}
            </DepotDetails>
            <Text>
              {selected} · last {chart.length} accepted samples · raw wire scale
            </Text>
            <Text selectable style={{ fontFamily: "monospace", fontSize: 18 }}>
              {spark || "Awaiting samples"}
            </Text>
            {chart.length > 0 && (
              <Text>
                Range {min} to {max} · observed rate{" "}
                {elapsed > 0
                  ? (((samples.length - 1) * 1000) / elapsed).toFixed(1)
                  : "—"}{" "}
                Hz
              </Text>
            )}
            {page === "Articulation" && (
              <Text>
                Explicit dome and shoulder cam angle queries remain in Fine
                Control → Dome &amp; Stance.
              </Text>
            )}

            {page === "Pose & Odometry" && (
              <PoseTracePanel
                trace={trace}
                onReset={() => {
                  const at = Date.now(),
                    origin = trace.resetOrigin(at);
                  recording.markLocalOrigin(origin, at);
                  refresh((value) => value + 1);
                }}
              />
            )}
          </>
        )}
        {view.kind === "events" && (
          <>
            <Text>
              Received packets and events · newest first. Observed event ID
              gaps: {recording.dropped}. The display retains 100 packets; an
              active recording captures every event from the transport stream.
            </Text>
            <DepotDetails title={`Received packet evidence · ${snapshot.packets.length}`}>
            {snapshot.packets.map((packet, index) => (
              <Text selectable key={index} style={s.packet}>
                {packet}
              </Text>
            ))}
            </DepotDetails>
          </>
        )}
        {view.kind === "recording" && (
          <>
            <Text>
              Recording channel selection · {recordingFields.length} fields
            </Text>
            <View style={s.row}>
              {button(
                "Select all recording fields",
                () =>
                  setRecordingFields(streamFields.map((field) => field.name)),
                recording.recording,
              )}
              {button(
                "Record accelerometer XYZ",
                () =>
                  setRecordingFields([
                    "accelerometer.x",
                    "accelerometer.y",
                    "accelerometer.z",
                  ]),
                recording.recording,
              )}
            </View>
            <DepotDetails title={`Choose recording fields · ${recordingFields.length} selected`}>
            <View style={s.row}>
              {streamFields.map((field) => (
                <Pressable
                  key={field.name}
                  accessibilityRole="checkbox"
                  accessibilityState={{
                    checked: recordingFields.includes(field.name),
                    disabled: recording.recording,
                  }}
                  disabled={recording.recording}
                  onPress={() =>
                    setRecordingFields((current) =>
                      current.includes(field.name)
                        ? current.filter((name) => name !== field.name)
                        : [...current, field.name],
                    )
                  }
                  style={s.button}
                >
                  <Text style={{ color: colors.text }}>
                    {recordingFields.includes(field.name) ? "☑" : "☐"}{" "}
                    {field.name}
                  </Text>
                </Pressable>
              ))}
            </View>
            </DepotDetails>
            <Text>Recording requested rate</Text>
            <View style={s.row}>
              {[25, 50, 100].map((interval) =>
                button(
                  `${1000 / interval} Hz${recordingInterval === interval ? " selected" : ""}`,
                  () => setRecordingInterval(interval),
                  recording.recording,
                ),
              )}
            </View>
            <Text>
              Start recording, then Apply sensor requests to install its
              channels. Recording selection and requested rate stay fixed during
              a recording. Raw packet evidence preserves every received channel;
              interpreted samples use the selected recording fields.
            </Text>
            <Text>
              {recording.recording ? "Recording locally" : "Recording stopped"}{" "}
              · {recording.records.length} records · dropped event IDs{" "}
              {recording.dropped}
            </Text>
            {button(
              recording.recording
                ? "Stop local recording"
                : "Start new local recording",
              () => {
                if (recording.recording) {
                  recording.stop();
                  onRecordingChange?.(false);
                  refresh((value) => value + 1);
                } else startRecording();
              },
              !port.subscribeEvents || exportBusy || !recordingFields.length,
            )}
            {confirmDiscard && (
              <View style={s.reading}>
                <Text>
                  This recording has unsaved records. Starting another recording
                  discards the current in-memory session. Saved files and any
                  prepared export snapshot remain available.
                </Text>
                {button(
                  "Discard unsaved recording and start new",
                  () => startRecording(true),
                  exportBusy,
                )}
                {button("Keep current recording", () =>
                  setConfirmDiscard(false),
                )}
              </View>
            )}
            {!port.subscribeEvents && (
              <Text>
                Recording unavailable: this connection does not expose a
                transport event stream.
              </Text>
            )}
            {button(
              "Prepare recording export",
              prepareExport,
              exportBusy || !recording.records.length,
            )}
            <Text accessibilityLiveRegion="polite">{exportMessage}</Text>
            {exportParts.length > 0 && (
              <Text>
                Prepared snapshot: {exportParts.length} parts · largest file{" "}
                {Math.max(
                  ...exportParts.map((part) => part.bytes),
                ).toLocaleString()}{" "}
                UTF-8 bytes. Each JSON file includes its part number, total
                count, original record range, schema and event IDs. Capture may
                continue; newly received events are excluded from this prepared
                snapshot.
              </Text>
            )}
            {exportParts[exportIndex] && (
              <>
                <Text>
                  Ready to save: {exportParts[exportIndex].name} ·{" "}
                  {exportParts[exportIndex].bytes.toLocaleString()} bytes
                </Text>
                {button(
                  `Save recording part ${exportIndex + 1} of ${exportParts.length}`,
                  savePart,
                  exportBusy ||
                    (!port.exportLocalJson && Platform.OS !== "web"),
                )}
              </>
            )}
            <Text>
              Exports use compact JSON and a 2,000,000 UTF-8 byte limit per
              file. Long sessions split without dropping records. Each Android
              save opens the system document picker; choose the destination or
              cancel. Canceling leaves the same part ready to retry.
            </Text>
            <Text>
              Start the sensor stream separately. Recording remains active when
              you change panels. It captures each received packet, accepted
              sample, command metadata, stream schema/status and connection
              change with a monotonic event ID. Keep the app in the foreground.
            </Text>
          </>
        )}
      </View>
    </View>
  );
}
const make_s = (colors: Palette) => {
  const {inputSurface} = inputTheme(colors);
  return StyleSheet.create({
  card: {
    padding: 10,
    backgroundColor: colors.panel,
    gap: 8,
    borderWidth: 1,
    borderColor: colors.line2,
    borderRadius: 10,
  },
  title: { fontSize: 17, fontWeight: "600" },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  reading: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", marginVertical: 2, gap: 6 },
  packet: { fontFamily: "monospace", fontSize: 12, marginVertical: 4 },
  input: {
    ...inputSurface,
    minHeight: Platform.OS === "web" ? 32 : 44,
    borderWidth: 1,
    borderColor: colors.line2,
    padding: 8,
    fontSize: 14,
  },
  button: {
    minHeight: Platform.OS === "web" ? 32 : 44,
    padding: 8,
    backgroundColor: colors.panelRaised,
    borderRadius: 6,
    justifyContent: "center",
  },
});
};

export const SensorTools = (props: Parameters<typeof useSensorTools>[0]) =>
  useSensorTools(props);
