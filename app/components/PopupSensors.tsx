import React, {useEffect, useRef, useState} from "react";
import {View} from "react-native";
import type {AppSnapshot, SessionSnapshot} from "../session/types.ts";
import {useAppActive} from "../platform/useAppActive.ts";
import {useColors} from "../theme/useColors.ts";
import {HudText} from "../theme/Theme.tsx";
import {CockpitDisplayWindow, cockpitDisplaySnapshot, cockpitSensorRows} from "./cockpitSensors.ts";

export function PopupSensors({kind, snapshot}: {kind: "dome" | "stance"; snapshot: SessionSnapshot}) {
  const colors = useColors(), active = useAppActive();
  const window = useRef(new CockpitDisplayWindow());
  const [display, setDisplay] = useState<{snapshot: AppSnapshot | undefined; now: number}>(() => ({snapshot, now: Date.now()}));
  const connected = ["ready", "paused"].includes(snapshot.state);
  useEffect(() => { window.current.add(snapshot); }, [snapshot]);
  useEffect(() => {
    if (!active || !connected) return;
    const timer = setInterval(() => {
      const now = Date.now();
      setDisplay({snapshot: window.current.read(now), now});
    }, 1000);
    return () => clearInterval(timer);
  }, [active, connected]);
  const rows = cockpitSensorRows(cockpitDisplaySnapshot(snapshot, display.snapshot), display.now)
    .filter(row => (kind === "dome" ? ["DOME"] : ["ACCEL", "GYRO", "SHOULDER"]).includes(row.label));
  return <View testID={`${kind}-popup-sensors`} style={{flexShrink:0, borderTopWidth:1, borderColor:colors.line, paddingTop:8, flexDirection:"row", flexWrap:"wrap", gap:8, justifyContent:"space-between"}}>
    {rows.map(row => <View key={row.label} accessibilityLabel={`${row.label}: ${row.value}`} style={{flexDirection:"row", alignItems:"center", gap:6}}>
      <HudText kind="mono" muted style={{fontSize:10}}>{row.label}</HudText>
      <HudText kind="mono" style={{fontSize:11, fontVariant:["tabular-nums"]}}>{row.value.replace(/ raw$/, "")}</HudText>
    </View>)}
  </View>;
}
