import { useEffect, useRef, useState } from "react";
import { Platform, AppState } from "react-native";
import { CockpitInput, DriveInputLatch } from "./InputModel.ts";
import { shapePoint, shapeAxis } from "./controlModels.ts";
import type { PadSample } from "./InputModel.ts";
import type { DriveSource } from "./ManualControls.ts";
import type { HudPreferences } from "../library/preferences.ts";
import { startCockpitGamepad } from "../platform/startCockpitGamepad";
type Props = {
  enabled: boolean;
  prefs: HudPreferences;
  begin: (source: DriveSource) => boolean;
  move: (source: DriveSource, p: [number, number]) => void;
  release: () => void;
  action: (a: string) => void;
  dome: (delta: number) => void;
  notify: (s: string) => void;
  registerCancel: (c: () => void) => () => void;
};
export function useCockpitInputs(props: Props) {
  const latest = useRef(props);
  latest.current = props;
  const [status, setStatus] = useState("Keyboard ready · gamepad inactive");
  const model = useRef(
    new CockpitInput(props.prefs.input.keys, props.prefs.input.gamepad),
  );
  const latch = useRef(new DriveInputLatch());
  const driving = useRef<DriveSource | undefined>(undefined);
  const stopSampling = useRef<(() => void) | undefined>(undefined);
  const generation = useRef(0);
  const domeDirection = useRef(0);
  const revoke = () => {
    generation.current++;
    stopSampling.current?.();
    stopSampling.current = undefined;
    model.current.revoke();
    domeDirection.current = 0;
    if (driving.current) latest.current.release();
    driving.current = undefined;
    setStatus("Input released · activate gamepad to use it again");
  };
  const point = (source: DriveSource, p: [number, number]) => {
    if (!latest.current.enabled) return;
    const shaped = shapePoint(...p);
    if (shaped[0] === 0 && shaped[1] === 0) {
      latch.current.accept(source, shaped, () => false);
      if (driving.current === source) {
        latest.current.release();
        driving.current = undefined;
      }
      return;
    }
    if (driving.current !== source) {
      if (
        !latch.current.accept(source, shaped, () =>
          latest.current.begin(source),
        )
      )
        return;
      driving.current = source;
    }
    latest.current.move(source, shaped);
  };
  useEffect(() => {
    revoke();
    model.current = new CockpitInput(
      props.prefs.input.keys,
      props.prefs.input.gamepad,
    );
  }, [props.prefs.input]);
  useEffect(() => {
    if (!props.enabled) revoke();
  }, [props.enabled]);
  useEffect(() => props.registerCancel(revoke), [props.registerCancel]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (latest.current.enabled && domeDirection.current)
        latest.current.dome(domeDirection.current * 5);
    }, 100);
    const app = AppState.addEventListener("change", (state) => {
      if (state !== "active") revoke();
    });
    if (Platform.OS !== "web")
      return () => {
        clearInterval(timer);
        app.remove();
        revoke();
      };
    const editable = (target: EventTarget | null) =>
      target instanceof Element &&
      !!target.closest(
        'input,textarea,select,[contenteditable="true"],[role="dialog"]',
      );
    const key = (event: KeyboardEvent, down: boolean) => {
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        editable(event.target)
      )
        return;
      if (
        !latest.current.enabled &&
        event.code !== "Escape" &&
        event.code !== "Space"
      )
        return;
      const result = model.current.key(event.code, down, event.repeat);
      if (!result.handled) return;
      event.preventDefault();
      if (result.action && !["domeLeft", "domeRight"].includes(result.action))
        latest.current.action(result.action);
      if (["stop", "home"].includes(result.action || "")) {
        revoke();
        return;
      }
      point("keyboard", result.point);
      domeDirection.current = result.dome ?? 0;
    };
    const down = (e: KeyboardEvent) => key(e, true),
      up = (e: KeyboardEvent) => key(e, false),
      focus = (e: FocusEvent) => {
        if (editable(e.target)) revoke();
      };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", revoke);
    document.addEventListener("focusin", focus, true);
    return () => {
      clearInterval(timer);
      app.remove();
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", revoke);
      document.removeEventListener("focusin", focus, true);
      revoke();
    };
  }, []);
  const activate = async () => {
    revoke();
    if (!latest.current.enabled) return;
    const id = ++generation.current;
    const failed = (reason: string) => {
      if (id !== generation.current) return;
      revoke();
      setStatus(reason);
      latest.current.notify(reason);
    };
    const sample = (s: PadSample) => {
      if (id !== generation.current || !latest.current.enabled) return;
      try {
        const result = model.current.gamepad(s, Date.now());
        setStatus(
          result.ready
            ? "Gamepad active · fresh hardware input"
            : "Release sticks and buttons to activate",
        );
        for (const action of result.actions) {
          latest.current.action(action);
          if (action === "stop" || action === "home") {
            revoke();
            return;
          }
        }
        point("gamepad", result.point);
        domeDirection.current = result.ready ? shapeAxis(result.dome) : 0;
      } catch (error) {
        failed(String(error));
      }
    };
    try {
      if (Platform.OS !== "web") {
        const cleanup = await startCockpitGamepad(sample, failed);
        if (id !== generation.current) cleanup();
        else stopSampling.current = cleanup;
        return;
      }
      if (!navigator.getGamepads) throw Error("Gamepad API is unavailable");
      const pad = Array.from(navigator.getGamepads()).find(
        (p) => p?.connected && p.mapping === "standard",
      );
      if (!pad)
        throw Error(
          "Connect a standard gamepad and press a button, then activate.",
        );
      const poll = () => {
        const p = navigator.getGamepads()[pad.index];
        if (!p || p.id !== pad.id || !p.connected || p.mapping !== "standard") {
          failed("Gamepad disconnected or changed");
          return;
        }
        sample({
          at: performance.timeOrigin + p.timestamp,
          deviceId: `${p.index}:${p.id}`,
          axes: Array.from(p.axes),
          buttons: p.buttons.map((b) => b.pressed),
        });
      };
      const timer = setInterval(poll, 50);
      stopSampling.current = () => clearInterval(timer);
      poll();
    } catch (error) {
      failed(String(error));
    }
  };
  return { activate, revoke, status };
}
