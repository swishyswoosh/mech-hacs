import { useEffect, useRef, useState } from "react";
import { DroidPathRunner } from "../../core/pathRunner.ts";
import type { DroidPathState } from "../../core/pathRunner.ts";
import type { PathsProps } from "../screens/Paths.tsx";
import type { PathDraft } from "../../core/automation.ts";
export function useDroidPath(props: PathsProps) {
  const current = useRef(props);
  current.current = props;
  const [state, setState] = useState<DroidPathState>({ status: "idle", progress: 0, segment: 0 });
  const [runner] = useState(
    () =>
      new DroidPathRunner(
        props.port,
        (next) => {
          setState(next);
          if (next.error) current.current.onMessage(next.error);
        },
        { isReady: () => !!current.current.ready },
      ),
  );
  const [starting, setStarting] = useState(false);
  useEffect(
    () =>
      props.registerCancel?.(() => {
        void runner.cancel(false);
      }),
    [runner, props.registerCancel],
  );
  useEffect(
    () => () => {
      void runner.cancel();
    },
    [runner],
  );
  useEffect(() => {
    if (props.stopToken) void runner.cancel(false);
  }, [props.stopToken, runner]);
  useEffect(() => {
    props.onRunning?.(["preparing", "running"].includes(state.status) ? "Drawn path" : "");
  }, [state.status, props.onRunning]);
  const start = async (draft: PathDraft) => {
    if (starting) return;
    setStarting(true);
    try {
      if (state.status === "paused") await runner.resume();
      else await runner.start(draft, props.beforeStart);
    } catch (error) {
      props.onMessage(String(error));
    } finally {
      setStarting(false);
    }
  };
  return {
    state,
    starting,
    start,
    pause: () => runner.cancel(true, true).catch((e) => props.onMessage(String(e))),
    stop: () => runner.cancel(true).catch((e) => props.onMessage(String(e))),
  };
}
