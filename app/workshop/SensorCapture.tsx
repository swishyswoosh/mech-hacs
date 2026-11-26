import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { TelemetryRecording } from "../../core/telemetryEvents.ts";
import { PoseTrace } from "./poseTrace.ts";
import type { AppPort } from "../session/types.ts";
function useCapture(
  port: AppPort,
  stopToken: number,
  onRecordingChange?: (recording: boolean) => void,
) {
  const [recording] = useState(() => new TelemetryRecording()),
    [trace] = useState(() => new PoseTrace());
  const [recordingFields, setRecordingFields] = useState([
    "accelerometer.x",
    "accelerometer.y",
    "accelerometer.z",
  ]);
  const [recordingInterval, setRecordingInterval] = useState(50),
    [revision, refresh] = useState(0),
    [recordingSubscriptionMessage, setRecordingSubscriptionMessage] =
      useState("");
  const dirty = useRef(false);
  useEffect(
    () =>
      port.subscribeEvents?.((event) => {
        recording.accept(
          event.type === "sample" && recording.recording
            ? {
                ...event,
                values: Object.fromEntries(
                  Object.entries(event.values).filter(([name]) =>
                    recordingFields.includes(name),
                  ),
                ),
              }
            : event,
        );
        trace.accept(event);
        dirty.current = true;
      }),
    [port, recording, trace, recordingFields.join("|")],
  );
  useEffect(() => {
    const timer = setInterval(() => {
      if (dirty.current) {
        dirty.current = false;
        refresh((value) => value + 1);
      }
    }, 100);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (stopToken) {
      recording.markCancellation();
      refresh((value) => value + 1);
    }
  }, [stopToken, recording]);
  useEffect(() => {
    onRecordingChange?.(recording.recording);
  }, [recording.recording, onRecordingChange]);
  useEffect(() => {
    void port
      .setSensorConsumer?.(
        "recording",
        recording.recording && recordingFields.length
          ? { fields: recordingFields, intervalMs: recordingInterval }
          : null,
      )
      .then(
        () => setRecordingSubscriptionMessage(""),
        (error) => setRecordingSubscriptionMessage(String(error)),
      );
  }, [port, recording.recording, recordingFields.join("|"), recordingInterval]);
  useEffect(
    () => () => {
      recording.stop();
      void port.setSensorConsumer?.("recording", null);
    },
    [port, recording],
  );
  return {
    recording,
    trace,
    recordingFields,
    setRecordingFields,
    recordingInterval,
    setRecordingInterval,
    refresh,
    revision,
    recordingSubscriptionMessage,
  };
}
const CaptureContext = createContext<ReturnType<typeof useCapture> | undefined>(
  undefined,
);
/** Recording and pose capture persist across navigation screen changes. */
export function SensorCaptureProvider({
  port,
  stopToken = 0,
  onRecordingChange,
  children,
}: {
  port: AppPort;
  stopToken?: number;
  onRecordingChange?: (recording: boolean) => void;
  children: React.ReactNode;
}) {
  const capture = useCapture(port, stopToken, onRecordingChange);
  return (
    <CaptureContext.Provider value={capture}>
      {children}
    </CaptureContext.Provider>
  );
}
export function useSensorCapture() {
  const value = useContext(CaptureContext);
  if (!value)
    throw new Error("Mount SensorCaptureProvider above the navigator.");
  return value;
}
