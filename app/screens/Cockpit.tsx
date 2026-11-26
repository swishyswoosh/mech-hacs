import { observedDomeDegrees } from '../cockpit/domeReading.ts';
import { DomeTargets } from "../cockpit/DomeTargets.ts";
import { setCalibration } from "../cockpit/Calibration.ts";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Platform, useWindowDimensions } from "react-native";
import type { ControllerSession } from "../session/ControllerSession.ts";
import { useSessionSnapshot } from "../session/hooks.ts";
import { ManualControls } from "../cockpit/ManualControls.ts";
import type { DriveSource } from "../cockpit/ManualControls.ts";
import { useCockpitInputs } from "../cockpit/useCockpitInputs.ts";
import { WheelCheckSheet } from "../cockpit/WheelCheckSheet.tsx";
import { CockpitSurface } from "../components/CockpitSurface.tsx";
import {
  loadHudPreferences,
  saveHudPreferences,
} from "../library/preferences.ts";
import { libraryItem } from "../library/catalog.ts";
import { cockpitHaptic, useCockpitPlatform } from "../platform/CockpitPlatform";
import type { Command } from "../../core/index.ts";
import { commands, requiresMotionArm } from "../../core/index.ts";
type Props = {
  session: ControllerSession;
  ready: boolean;
  execute: (command: Command) => Promise<unknown>;
  notify: (s: string) => void;
  onStop: () => void;
  onHome: () => void;
  onLibrary: (slot?: number) => void;
  recheck?: boolean;
  onRecheckHandled?: () => void;
};
export function Cockpit({
  session,
  ready,
  execute,
  notify,
  onStop,
  onHome,
  onLibrary,
  recheck = false,
  onRecheckHandled,
}: Props) {
  const snapshot = useSessionSnapshot(session),
    { width, height } = useWindowDimensions();
  const portrait = width < 700 && height > width;
  useCockpitPlatform(true);
  useEffect(()=>session.observeCockpitTelemetry?.(),[session]);
  ready=ready&&!snapshot.cockpitTelemetryBusy;
  const [prefs, setPrefs] = useState(() => loadHudPreferences(session)),
    [target, setTarget] = useState(0),
    [stance, setStance] = useState<"two" | "three" | "waddle">("three"),
    [wizard, setWizard] = useState(recheck),
    [pulseBusy, setPulseBusy] = useState(false);
  useEffect(() => setPrefs(loadHudPreferences(session)), [session, snapshot.preferencesRevision]);
  const motionReady=ready && session.motionAvailable !== false;
  const current = useRef({ ready, motionReady, portrait, notify, prefs, target, stance });
  current.current = { ready, motionReady, portrait, notify, prefs, target, stance };
  const [manual] = useState(
    () =>
      new ManualControls(
        session,
        () => current.current.motionReady && !current.current.portrait,
        (error) => current.current.notify(String(error)),
      ),
  );
  useEffect(() => () => manual.dispose(), [manual]);
  useEffect(() => {
    if (recheck) {
      setWizard(true);
      onRecheckHandled?.();
    }
  }, [recheck, onRecheckHandled]);
  const registerCancel = useCallback(
    (cancel: () => void) => session.registerCancel(cancel),
    [session],
  );
  const release = () => {
    void manual.release().catch((error) => notify(String(error)));
  };
  const begin = (source: DriveSource) => {
    const accepted = manual.begin(source);
    if (accepted) cockpitHaptic("arm", prefs.haptics);
    return accepted;
  };
  const move = (source: DriveSource, p: [number, number]) => {
    manual.move(
      source,
      p,
      current.current.prefs.gearSpeeds[current.current.prefs.gear],
    );
  };
  const actionBusy = useRef(false);

  const action = async (work: () => Promise<unknown>) => {
    if (!current.current.ready || actionBusy.current) return;
    actionBusy.current = true;
    try {
      await work();
    } catch (error) {
      notify(String(error));
    } finally {
      actionBusy.current = false;
    }
  };
  const latestDomeExecute=useRef(execute);latestDomeExecute.current=execute;
  const [domeTargets]=useState(()=>new DomeTargets(async angle=>{
    session.assertManualSource(commands.head(angle));
    session.armMotion();
    await latestDomeExecute.current(commands.head(angle));
  },()=>current.current.ready&&!current.current.portrait&&!session.manualMotion.active,
  error=>current.current.notify(String(error))));
  useEffect(()=>{const remove=session.registerCancel(()=>domeTargets.cancel());return()=>{domeTargets.cancel();remove();};},[session,domeTargets]);
  const dome = (n:number) => {
    if(!current.current.ready||current.current.portrait||session.manualMotion.active)return;
    const angle=Math.max(-160,Math.min(180,Math.round(n)));
    setTarget(angle);domeTargets.set(angle);
  };
  const gear = async (index: number) => {
    try {
    const next = {
      ...current.current.prefs,
      gear: Math.max(0, Math.min(2, index)) as 0 | 1 | 2,
    };
    await saveHudPreferences(session, next);
    session.setDriveSpeed(next.gearSpeeds[next.gear]);
    setPrefs(next);
    cockpitHaptic("gear", next.haptics);
    } catch(error) { notify(String(error)); }
  };
  const setDroidStance = (next: "two" | "three" | "waddle") =>
    void action(async () => {
      if(!current.current.ready)return;
      if (session.manualMotion.active)
        throw Error("Release drive before changing stance.");
      const command = commands.legAction({ two: 2, three: 1, waddle: 3 }[next]);
      session.assertManualSource(command);
      session.armMotion();
      await execute(command);
      setStance(next);
    });
  const slot = (index: number) => {
    const key = current.current.prefs.soundboard[index];
    const item = key ? libraryItem(key) : undefined;
    if (!item) {
      onLibrary(index);
      return;
    }
    void action(async () => {
      const command =
        item.kind === "sound"
          ? commands.audio(item.sector!)
          : commands.animation(item.id);
      if (requiresMotionArm(command)) {
        if (session.manualMotion.active)
          throw Error("Release drive before a motion animation.");
        session.assertManualSource(command);
        session.armMotion();
      }
      await execute(command);
    });
  };
  const stop = () => {
    cockpitHaptic("stop", prefs.haptics);
    onStop();
  };
  const input = useCockpitInputs({
    enabled: ready && !portrait && !wizard,
    prefs,
    begin,
    move,
    release,
    action: (a) => {
      if (a === "stop") stop();
      else if (a === "home") onHome();
      else if (a === "gearUp") gear(current.current.prefs.gear + 1);
      else if (a === "gearDown") gear(current.current.prefs.gear - 1);
      else if (a === "domeCenter") dome(0);
      else if (a === "stance") {
        const s = current.current.stance;
        setDroidStance(
          s === "two" ? "three" : s === "three" ? "waddle" : "two",
        );
      } else if (a.startsWith("slot")) slot(Number(a.slice(4)) - 1);
    },
    dome: (delta) => dome(current.current.target + delta),
    notify,
    registerCancel,
  });
  useEffect(() => {
    if (portrait) {
      input.revoke();
      release();
    }
  }, [portrait]);
  const nudge = async (
    direction: "Forward" | "Reverse" | "Turn Left" | "Turn Right",
  ) => {
    setPulseBusy(true);
    try {
      input.revoke();
      await manual.pulse(
        direction,
        prefs.gearSpeeds[prefs.gear],
        Platform.OS === "android",
      );
    } catch (error) {
      notify(String(error));
    } finally {
      setPulseBusy(false);
    }
  };
  return (
    <CockpitSurface
      prefs={prefs}
      portrait={portrait}
      ready={ready}
      soundReady={ready}
      pulseBusy={pulseBusy}
      stopping={snapshot.safety.state === "stopping"}
      wizard={wizard}
      stance={stance}
      heading={snapshot.telemetry.sensors?.values["attitude.yaw"]}
      joystick={{
        enabled:
          motionReady && !wizard && !pulseBusy,
        speed: prefs.gearSpeeds[prefs.gear],
        onBegin: () => {
          input.revoke();
          return begin("pointer");
        },
        onMove: (p) => move("pointer", p),
        onRelease: release,
        registerCancel,
      }}
      dome={{
        registerCancel,
        enabled: ready && !wizard && !pulseBusy,
        target,
        observed: observedDomeDegrees(snapshot),
        onTarget: dome,
      }}
      inputStatus={input.status}
      onGear={gear}
      onStance={setDroidStance}
      onSlot={slot}
      onLibrary={onLibrary}
      onWheelCheck={() => {
        input.revoke();
        setWizard(true);
      }}
      onStop={stop}
      onActivate={() => void input.activate()}
      onRevoke={input.revoke}
      onNudge={(d) => void nudge(d)}
    >
      {wizard && motionReady && !portrait && (
        <WheelCheckSheet
          session={session}
          manual={manual}
          native={Platform.OS === "android"}
          notify={notify}
          onStop={stop}
          onClose={() => setWizard(false)}
          onDone={(x, y) => {
            setCalibration(session, snapshot.connection.epoch, x, y);
            setWizard(false);
            notify(
              "Wheel directions confirmed for this connection. Use a fresh drive input.",
            );
          }}
        />
      )}
    </CockpitSurface>
  );
}
