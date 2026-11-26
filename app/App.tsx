import { AttitudeContext } from "./components/AttitudeNote.tsx";
import { prepareTaskSwitch } from "./navigation/prepareTaskSwitch.ts";
import { ManualTools } from "./cockpit/ManualTools.tsx";
import { ConnectionSettings } from "./screens/ConnectionSettings.tsx";
import { SensorCaptureProvider } from "./workshop/SensorCapture.tsx";
import React, { useCallback, useState, useSyncExternalStore, useEffect } from "react";
import { ControllerShell } from "./navigation/ControllerShell.tsx";
import type { ScreenContext } from "./navigation/ControllerShell.tsx";
import { pauseGateFor } from "./navigation/PauseGate.ts";
import { useSessionSnapshot } from "./session/hooks.ts";
import type { ControllerSession } from "./session/ControllerSession.ts";
import { Cockpit } from "./screens/Cockpit.tsx";
import { Library } from "./screens/Library.tsx";
import { Lights } from "./screens/Lights.tsx";
import { Settings } from "./screens/Settings.tsx";
import { Paths } from "./screens/Paths.tsx";
import { Experiences } from "./screens/Experiences.tsx";
import { Depot } from "./screens/Depot.tsx";

import { loadInterface } from "./library/interfacePreferences.ts";
import { saveInterfacePreferences } from "./library/settings.ts";
import type { InterfacePreferences } from "./preferences.ts";
import type { Command } from "../core/index.ts";
import { requiresMotionArm } from "../core/index.ts";
import type { AutomationOwnerPanel } from "./session/runningSources.ts";
export function ControllerApp({
  port,
  platform = "web",
  onAppearanceChange,
}: {
  port: ControllerSession;
  platform?: "web" | "android";
  onAppearanceChange?: (appearance: "light" | "dark") => void;
}) {
  const [preferences, setPreferences] = useState(() =>
      loadInterface(port),
    ),
    [message, setMessage] = useState(""),
    [stopToken, setStopToken] = useState(0),
    [pinSlot, setPinSlot] = useState<number>(),
    [recheck, setRecheck] = useState(false);
  useEffect(() => {onAppearanceChange?.(preferences.theme === "light" ? "light" : "dark");}, [preferences.theme, onAppearanceChange]);
  const snapshot = useSessionSnapshot(port);
  useEffect(() => {
    setPreferences(loadInterface(port));
  }, [port, snapshot.preferencesRevision]);
  useEffect(()=>{if(snapshot.safety.canControl)void port.ensureAttitudeTelemetry?.();},[port,snapshot.safety.canControl,snapshot.sensors?.status]);
  const [pause] = useState(() => pauseGateFor(port));
  const paused = useSyncExternalStore(
    pause.subscribe,
    pause.getSnapshot,
    pause.getSnapshot,
  );
  const registerCancel = useCallback(
    (cancel: () => void) => port.registerCancel(cancel),
    [port],
  );
  const execute = async (command: Command) => {
    if (pause.getSnapshot() || !port.store.getSnapshot().safety.canControl)
      throw Error("Controls are paused or unavailable.");
    try {
      return await port.executeManual(command);
    } catch (error) {
      setMessage(String(error));
      throw error;
    }
  };
  const stop = () => {
    port.cancelSourceStart();
    port.cancelLocalSources();
    setStopToken((n) => n + 1);
    void port.stop().catch((error) => setMessage(String(error)));
  };
  // A tab choice completes the stop handoff before exposing its controls.
  const beforeNavigate = () => prepareTaskSwitch(port);
  const beforeAutomation = useCallback(
    async (_owner?: AutomationOwnerPanel) => {
      if (pause.getSnapshot()) throw Error("Resume controls first.");
      await port.requestLocalStart("automation");
    },
    [port, pause],
  );
  const beforeExperience = useCallback(async () => {
    if (pause.getSnapshot()) throw Error("Resume controls first.");
    await port.requestLocalStart("experience");
  }, [port, pause]);
  const automationRunning = useCallback(
    (name: string) => port.reportSource("automation", name),
    [port],
  );
  const experienceRunning = useCallback(
    (name: string) => port.reportSource("experience", name),
    [port],
  );
  const apply = (next: InterfacePreferences) => setPreferences(next);
  const changeAppearance = async (theme: "light" | "dark") => {
    try {
    const next = { ...loadInterface(port), theme };
    await saveInterfacePreferences(port, next);
    setPreferences(next);
    } catch(error) { setMessage(String(error)); }
  };
  const action = (work: () => Promise<unknown>) =>
    void work().catch((error) => setMessage(String(error)));
  const screen = (context: ScreenContext) => {
    const { route, ready, navigate, notify } = context;
    const common = { session: port, ready: ready && !paused, execute, notify };
    switch (route) {
      case "cockpit":
        return (
          <Cockpit
            {...common}
            recheck={recheck}
            onRecheckHandled={() => setRecheck(false)}
            onStop={stop}
            onHome={() => navigate("home")}
            onLibrary={(slot) => {
              setPinSlot(slot);
              navigate("sounds");
            }}
          />
        );
      case "sounds":
      case "animations":
        return (
          <Library
            key={route}
            {...common}
            initialKind={route}
            pinSlot={pinSlot}
          />
        );
      case "lights":
        return <Lights {...common} />;
      case "settings":
        return (
          <Settings
            session={port}
            ready={ready}
            notify={notify}
            applied={preferences}
            onApplied={apply}
            onAppearance={changeAppearance}
            onRecheckWheels={() => {
              setRecheck(true);
              navigate("cockpit");
            }}
            intensity={context.intensity}
            onIntensity={context.setIntensity}
            depot={context.depot}
            onDepot={context.setDepot}
            onSafety={context.onSafety}
          >
            <ConnectionSettings
              session={port}
              notify={notify}
              onConnect={() => navigate("launch")}
            />
          </Settings>
        );
      case "paths":
        return (
          <Paths
            port={port}
            snapshot={snapshot}
            ready={ready && port.motionAvailable !== false}
            onMessage={notify}
            stopToken={stopToken}
            onOpenExperiences={() => navigate("experiences")}
            registerCancel={registerCancel}
            beforeStart={beforeAutomation}
            onRunning={automationRunning}
          />
        );
      case "experiences":
        return (
          <Experiences
            key={context.navigationVersion}
            port={port}
            snapshot={snapshot}
            ready={ready}
            stopToken={stopToken}
            onMessage={notify}
            onRunning={automationRunning}
            registerCancel={registerCancel}
            beforeStart={beforeAutomation}
          />
        );
      case "depot":
        return (
          <Depot
            additionalControls={
              <ManualTools
                session={port}
                ready={ready}
                notify={notify}
                onWheelCheck={() => { setRecheck(true); navigate("cockpit"); }}
              />
            }
            port={port}
            snapshot={snapshot}
            ready={ready}
            stopToken={stopToken}
            onMessage={notify}
            execute={execute}
            beforeService={() => {
              port.cancelLocalSources();
              setStopToken((n) => n + 1);
            }}
            onStartSensors={() =>
              action(() => port.startSensors())
            }
            onStopSensors={() =>
              action(() => port.stopSensors())
            }
            onSleep={() => port.sleep()}
            manualMotion={port.manualMotion}
            registerCancel={registerCancel}
            executeNativePulse={
              platform === "android"
                ? (command) => port.pulseAdvancedDrive(command)
                : undefined
            }
          />
        );
      default:
        return null;
    }
  };
  return (
    <>
      <AttitudeContext.Provider value={snapshot}><SensorCaptureProvider port={port} stopToken={stopToken}>
        <ControllerShell
          session={port}
          pause={pause}
          largeLabels={preferences.largeLabels}
          appearance={preferences.theme === "light" ? "light" : "dark"}
          onAppearance={changeAppearance}
          message={message}
          onClearMessage={() => setMessage("")}
          beforeNavigate={beforeNavigate}
          onStop={stop}
        >
          {screen}
        </ControllerShell>
      </SensorCaptureProvider></AttitudeContext.Provider>
    </>
  );
}
