import { PulseButton } from "../components/PulseButton.tsx";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Platform, View } from "react-native";
import type { ControllerSession } from "../session/ControllerSession.ts";
import { ManualControls } from "./ManualControls.ts";
import { ExternalSteering } from "./ExternalSteering.tsx";
import { shapePoint } from "./controlModels.ts";
import { HudButton, HudPanel } from "../components/Hud.tsx";
import { HudText } from "../theme/Theme.tsx";
import { loadInterface } from "../library/interfacePreferences.ts";
export function ManualTools({
  session,
  ready,
  notify,
  onWheelCheck,
}: {
  session: ControllerSession;
  ready: boolean;
  notify: (s: string) => void;
  onWheelCheck: () => void;
}) {
  const current = useRef({ ready, notify });
  current.current = { ready, notify };
  const [manual] = useState(
    () =>
      new ManualControls(
        session,
        () => current.current.ready,
        (error) => current.current.notify(String(error)),
      ),
  );
  const revoke = useRef<(() => void) | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const registerCancel = useCallback(
    (c: () => void) => session.registerCancel(c),
    [session],
  );
  const registerRevoke = useCallback((c: () => void) => {
    revoke.current = c;
    return () => {
      revoke.current = undefined;
    };
  }, []);
  useEffect(() => () => manual.dispose(), [manual]);
  const release = () => void manual.release().catch((e) => notify(String(e)));
  const s = session.store.getSnapshot();
  const speed = loadInterface(session).defaultSpeed;
  return (
    <HudPanel>
      <HudText kind="heading">Accessible & external steering</HudText>
      {!s.safety.wheelsValidated && (
        <HudButton label="Run Wheel Check in cockpit" onPress={onWheelCheck} />
      )}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {(["Forward", "Reverse", "Turn Left", "Turn Right"] as const).map(
          (d) => (
            <PulseButton
              key={d}
              label={`200 ms ${d}`}
              disabled={!ready || !s.safety.wheelsValidated || busy}
              onPress={() => {
                revoke.current?.();
                setBusy(true);
                void manual
                  .pulse(d, Math.min(25, speed), Platform.OS === "android")
                  .then(
                    () => notify("Pulse ended."),
                    (e) => notify(String(e)),
                  )
                  .finally(() => setBusy(false));
              }}
            />
          ),
        )}
      </View>
      <ExternalSteering
        enabled={ready && s.safety.wheelsValidated && !busy}
        connectionEpoch={s.connection.epoch}
        speed={speed / 100}
        allowed={() =>
          current.current.ready &&
          session.store.getSnapshot().safety.wheelsValidated
        }
        onSelect={release}
        onBegin={() => manual.begin("tilt")}
        onPoint={(p) => manual.move("tilt", shapePoint(...p), speed)}
        onRelease={release}
        registerCancel={registerCancel}
        registerManualRevoke={registerRevoke}
      />
    </HudPanel>
  );
}
