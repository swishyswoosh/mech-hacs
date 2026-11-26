import {useAppActive} from "../platform/useAppActive.ts";
import { useColors } from "../theme/useColors.ts";
import React, { useEffect, useRef, useState } from "react";
import { View, Pressable, Platform, useWindowDimensions } from "react-native";
import type { ControllerSession } from "../session/ControllerSession.ts";
import type { SessionSnapshot } from "../session/types.ts";
import { commands } from "../../core/index.ts";
import { HudText } from "../theme/Theme.tsx";
import { Icon } from "./Icon.tsx";
import { HudButton } from "./Hud.tsx";
import { Sheet } from "./Overlays.tsx";
import {
  profileBatteryIndicator,
  batteryLevel,
  batteryReading,
} from "./BatteryReading.ts";

export function BatteryStatus({
  session,
  snapshot,
  onStop,
}: {
  session: ControllerSession;
  snapshot: SessionSnapshot;
  onStop: () => void;
}) {
  const colors = useColors();
  const {height} = useWindowDimensions();
  const low = Platform.OS === "android" && height < 600;

  const [level, setLevel] = useState("Unavailable");
  const [details, setDetails] = useState(false);
  const [busy, setBusy] = useState(false);
  const [powerMessage, setPowerMessage] = useState("");
  const epoch = useRef<number | undefined>(undefined);
  const request = useRef(0);
  const connected = !["disconnected", "sleeping", "awaiting-restart"].includes(
    snapshot.state,
  );
  const refresh = async () => {
    const id = ++request.current;
    const connection = snapshot.connection.epoch;
    setBusy(true);
    try {
      if (session.mode === "remote") {setLevel("Unavailable"); return;}
      const response = await session.execute(commands.batteryState());
      if (
        request.current === id &&
        session.store.getSnapshot().connection.epoch === connection
      )
        {
        if (!response || typeof response !== "object" || !("data" in response) || !(response.data instanceof Uint8Array)) throw Error("Battery response unavailable");
        setLevel(batteryLevel(response.data));
      }
    } catch {
      if (request.current === id) setLevel("Unavailable");
    } finally {
      if (request.current === id) setBusy(false);
    }
  };
  useEffect(() => {
    if (!connected) {
      ++request.current;
      epoch.current = undefined;
      setLevel("Unavailable");
      setBusy(false);
    } else if (
      snapshot.state === "ready" &&
      epoch.current !== snapshot.connection.epoch
    ) {
      epoch.current = snapshot.connection.epoch;
      void refresh();
    }
  }, [connected, snapshot.state, snapshot.connection.epoch]);
  useEffect(
    () =>
      session.subscribeEvents((event) => {
        if (
          event.type === "notification" &&
          event.notification.type === "battery-state"
        )
          setLevel(batteryLevel(Uint8Array.of(event.notification.value)));
      }),
    [session],
  );
  useEffect(
    () => () => {
      ++request.current;
    },
    [],
  );
  const active=useAppActive();
  const [now,setNow]=useState(Date.now());
  useEffect(()=>{setNow(Date.now());if(!active||(!snapshot.batteryEstimate&&!snapshot.batteryStateReading))return;const timer=setInterval(()=>setNow(Date.now()),15000);return()=>clearInterval(timer);},[active,snapshot.batteryEstimate,snapshot.batteryStateReading]);
  const reading=snapshot.batteryStateReading;
  const clock=Math.max(now,Date.now());
  const displayedLevel=reading&&clock>=reading.at&&clock-reading.at<=120000?batteryLevel(Uint8Array.of(reading.value)):level;
  const indicator = profileBatteryIndicator(displayedLevel, snapshot.battery,snapshot.batteryEstimate,clock,snapshot.state);
  const color =
    indicator.tone === "warning"
      ? colors.danger
      : indicator.tone === "good"
        ? colors.ok
        : colors.text;
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Battery ${indicator.label}. Open battery details`}
        onPress={() => setDetails(true)}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingHorizontal: 10,
          minHeight: low ? 44 : 56,
        }}
      >
        <Icon name="battery" size={26} color={color} />
        <View>
          <HudText
            kind="heading"
            muted
            style={{ fontSize: 12, letterSpacing: 1 }}
          >
            Battery
          </HudText>
          <HudText kind="heading" style={{ fontSize: 18, color }}>
            {busy && indicator.label === "No reading"
              ? "Checking…"
              : indicator.label}
          </HudText>
        </View>
      </Pressable>
      {details && (
        <Sheet
          title="Battery"
          onClose={() => setDetails(false)}
          onStop={onStop}
        >
          <HudText kind="heading">{indicator.label}</HudText>
          <HudText>Remaining time: unavailable.</HudText>
          <HudText muted>
            {snapshot.batteryProfiling?.activeProfile
              ? "An accepted Depot profile estimates remaining usable runtime from a recent quiet voltage. Percentages are approximate; motion, sound and battery condition affect accuracy. Reported battery state is used when an estimate is unavailable."
              : "This droid reports a battery state, but not a percentage or minutes remaining. Runtime varies with motion, sound, and battery condition."}
          </HudText>
          <HudText kind="mono">
            Voltage: {batteryReading(snapshot.battery)}
          </HudText>
          <HudButton
            label="Refresh battery state"
            disabled={busy || snapshot.state !== "ready"}
            onPress={() => void refresh()}
          />
          <HudButton
            label="Put droid to sleep"
            disabled={busy || !snapshot.safety.canControl}
            onPress={() => {
              setBusy(true); setPowerMessage("");
              void session.sleep().then(() => setDetails(false), error =>
                setPowerMessage(`Sleep unconfirmed: ${String(error)}`)
              ).finally(() => setBusy(false));
            }}
          />
          {!!powerMessage && <HudText>{powerMessage}</HudText>}
        </Sheet>
      )}
    </>
  );
}
