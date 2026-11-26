import { useSyncExternalStore } from "react";
import { Platform } from "react-native";
import { presentationFor } from "./presentation.ts";
import type { ControllerSession } from "./ControllerSession.ts";
export function usePreferenceRevision(session: ControllerSession) {
  return useSyncExternalStore(
    session.store.subscribe,
    () => session.store.getSnapshot().preferencesRevision,
    () => session.store.getSnapshot().preferencesRevision,
  );
}
export function useSessionSnapshot(session: ControllerSession) {
  const source=Platform.OS === "android" ? presentationFor(session.store) : session.store;
  return useSyncExternalStore(
    source.subscribe,
    source.getSnapshot,
    source.getSnapshot,
  );
}
export function useConnection(session: ControllerSession) {
  return useSyncExternalStore(
    session.store.subscribe,
    () => session.store.getSnapshot().connection,
    () => session.store.getSnapshot().connection,
  );
}
export function useSafety(session: ControllerSession) {
  return useSyncExternalStore(
    session.store.subscribe,
    () => session.store.getSnapshot().safety,
    () => session.store.getSnapshot().safety,
  );
}
export function useActivity(session: ControllerSession) {
  return useSyncExternalStore(
    session.store.subscribe,
    () => session.store.getSnapshot().activity,
    () => session.store.getSnapshot().activity,
  );
}
export function useTelemetry(session: ControllerSession) {
  return useSyncExternalStore(
    session.store.subscribe,
    () => session.store.getSnapshot().telemetry,
    () => session.store.getSnapshot().telemetry,
  );
}
