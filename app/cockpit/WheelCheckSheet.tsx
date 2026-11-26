import { PulseButton } from "../components/PulseButton.tsx";
import React, { useEffect, useState } from "react";
import { View } from "react-native";
import { Sheet } from "../components/Overlays.tsx";
import { HudButton } from "../components/Hud.tsx";
import { HudText } from "../theme/Theme.tsx";
import { WheelCheck } from "./WheelCheck.ts";
import type { ControllerSession } from "../session/ControllerSession.ts";
import type { ManualControls } from "./ManualControls.ts";
export function WheelCheckSheet({
  session,
  manual,
  native,
  onDone,
  onClose,
  onStop,
  notify,
}: {
  session: ControllerSession;
  manual: ManualControls;
  native: boolean;
  onDone: (x: number, y: number) => void;
  onClose: () => void;
  onStop: () => void;
  notify: (s: string) => void;
}) {
  const [check] = useState(
    () =>
      new WheelCheck(
        session.store.getSnapshot().connection.epoch,
        () => session.validateWheels(check.epoch),
        (direction) => manual.pulse(direction, 10, native, true),
      ),
  );
  const [, render] = useState(0);
  const refresh = () => render((n) => n + 1);
  useEffect(() => {
    const remove = session.registerCancel(() => {
      check.cancel();
      onClose();
    });
    return () => {
      remove();
      check.cancel();
    };
  }, [session, check]);
  const action = (work: () => void) => {
    try {
      work();
      refresh();
    } catch (e) {
      notify(String(e));
    }
  };
  const nudge = async () => {
    const work = check.nudge();
    refresh();
    try {
      await work;
    } catch (e) {
      notify(String(e));
    }
    refresh();
  };
  return (
    <Sheet
      title="Wheel Check"
      onClose={() => {
        void manual.release().catch((e) => notify(String(e)));
        onClose();
      }}
      onStop={onStop}
    >
      <HudText>
        Calibration is optional. Close this panel to use the joystick with the current directions.
      </HudText>
      <HudButton label="Use joystick" disabled={check.busy} onPress={onClose} />
      <HudText>
        Lift R2 or give him room. Each test is one 200 ms nudge at 10%.
      </HudText>
      {check.stage === "prepare" ? (
        <HudButton
          label="R2 has room · begin check"
          onPress={() => action(() => check.prepare())}
        />
      ) : (
        <>
          <HudText kind="heading">
            {check.stage === "forward"
              ? "1 · Forward direction"
              : "2 · Left turn"}
          </HudText>
          <PulseButton
            label={
              check.busy
                ? "Nudge in progress"
                : "Test " +
                  (check.stage === "forward" ? "forward" : "left turn")
            }
            disabled={check.busy}
            onPress={() => void nudge()}
          />
          <HudText>
            {check.stage === "forward"
              ? "Did R2 roll forward?"
              : "Did R2 turn left?"}
          </HudText>
          <View style={{ gap: 8 }}>
            <HudButton
              label="Yes, correct direction"
              disabled={!check.canConfirm}
              primary
              onPress={() =>
                action(() => {
                  check.confirm();
                  if (check.stage === "complete")
                    onDone(check.xSign, check.ySign);
                })
              }
            />
            <HudButton
              label="No · reverse this axis and retest"
              disabled={!check.canConfirm}
              onPress={() => action(() => check.swap())}
            />
          </View>
        </>
      )}
    </Sheet>
  );
}
