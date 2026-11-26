import React, {useCallback, useEffect, useRef, useState} from "react";
import {View} from "react-native";
import type {ControllerSession} from "../session/ControllerSession.ts";
import type {SessionSnapshot} from "../session/types.ts";
import {DomeTargets} from "../cockpit/DomeTargets.ts";
import {observedDomeDegrees, formatDomeDegrees} from "../cockpit/domeReading.ts";
import {DomeDial} from "./DomeDial.tsx";
import {DomeSlider} from "./DomeSlider.tsx";
import {PopupSensors} from "./PopupSensors.tsx";
import {HudText} from "../theme/Theme.tsx";

export function DomePopup({session, snapshot, enabled, notify}: {
  session: ControllerSession; snapshot: SessionSnapshot; enabled: boolean; notify: (message: string) => void;
}) {
  const observed = observedDomeDegrees(snapshot);
  const [target, setTarget] = useState(() => observed ?? 0);
  const [size, setSize] = useState(120);
  const registerCancel = useCallback((cancel: () => void) => session.registerCancel(cancel), [session]);
  const current = useRef({enabled, notify});
  current.current = {enabled, notify};
  const [targets] = useState(() => new DomeTargets(
    async angle => { await session.setDome(angle); },
    () => current.current.enabled && !session.manualMotion.active,
    error => current.current.notify(String(error)),
  ));
  useEffect(() => {
    const remove = session.registerCancel(() => targets.cancel());
    return () => {targets.cancel(); remove();};
  }, [session, targets]);
  useEffect(() => {if (!enabled) targets.cancel();}, [enabled, targets]);
  const change = (angle: number) => {
    if (!current.current.enabled || session.manualMotion.active) return;
    setTarget(angle);
    targets.set(angle);
  };
  return <View testID="dome-popup-body" style={{flex:1, minHeight:0, gap:8}}>
    <View style={{flex:1, minHeight:0, flexDirection:"row", gap:16, alignItems:"stretch"}}>
      <View testID="dome-popup-slider" style={{flex:1, minWidth:0, justifyContent:"center", alignItems:"center"}}>
        <View style={{width:"100%", maxWidth:300, paddingHorizontal:12, gap:8}}>
          <HudText kind="mono" style={{textAlign:"center"}}>TARGET {formatDomeDegrees(target)}</HudText>
          <DomeSlider target={target} enabled={enabled} onTarget={change} registerCancel={registerCancel}/>
        </View>
      </View>
      <View testID="dome-popup-dial" onLayout={event => {
        const {width, height} = event.nativeEvent.layout;
        setSize(Math.max(1, Math.floor(Math.min(width, height))));
      }} style={{flex:1, minWidth:0, minHeight:0, alignItems:"center", justifyContent:"center"}}>
        <DomeDial target={target} observed={observed} size={size} enabled={enabled} onTarget={change} registerCancel={registerCancel}/>
      </View>
    </View>
    <PopupSensors kind="dome" snapshot={snapshot}/>
  </View>;
}
