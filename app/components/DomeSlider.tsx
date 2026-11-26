import {useColors} from "../theme/useColors.ts";
import React, {useEffect, useRef, useState} from "react";
import {View, Platform} from "react-native";
import {HudText} from "../theme/Theme.tsx";
import {domeSliderPosition, domeSliderTarget} from "../cockpit/domeSlider.ts";

type Props = {target: number; enabled: boolean; onTarget: (angle: number) => void; registerCancel: (cancel: () => void) => () => void};
export function DomeSlider(props: Props) {
  const colors = useColors();
  const latest = useRef(props); latest.current = props;
  const element = useRef<HTMLInputElement>(null);
  const pointer = useRef<number | undefined>(undefined);
  const source = useRef<'pointer' | 'keyboard' | undefined>(undefined);
  const lastTarget = useRef<number | undefined>(undefined);
  const [width, setWidth] = useState(1);
  const cancel = () => {
    source.current = undefined;
    lastTarget.current = undefined;
    const id = pointer.current; pointer.current = undefined;
    try { if (id !== undefined && element.current?.hasPointerCapture(id)) element.current.releasePointerCapture(id); } catch {}
  };
  useEffect(() => props.registerCancel(cancel), [props.registerCancel]);
  useEffect(() => { if (!props.enabled) cancel(); }, [props.enabled]);
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    window.addEventListener('blur', cancel);
    return () => { window.removeEventListener('blur', cancel); cancel(); };
  }, []);
  const change = (position: number, snap: boolean) => {
    if (!latest.current.enabled) return;
    const angle = domeSliderTarget(position, snap);
    // Deduplicate within a gesture, not across gestures: a fresh center tap
    // must resend zero when the physical dome did not reach its prior target.
    if (angle !== undefined && angle !== lastTarget.current) {
      lastTarget.current = angle;
      latest.current.onTarget(angle);
    }
  };
  const percent = (domeSliderPosition(props.target) + 100) / 2;
  return <View style={{width: '100%', height: 44, position: 'relative'}}>
    {Platform.OS === 'web' ? React.createElement('input', {
      ref: element, type: 'range', min: -100, max: 100, step: .5,
      value: domeSliderPosition(props.target), disabled: !props.enabled,
      'aria-label': 'Dome angle', 'aria-valuetext': `${props.target} degrees; center snaps to zero`,
      style: {width: '100%', height: 40, minHeight: 40, margin: 0, accentColor: colors.primary, touchAction: 'none'},
      onPointerDown: (e: React.PointerEvent<HTMLInputElement>) => {
        if (!latest.current.enabled || e.button !== 0 || pointer.current !== undefined) return;
        source.current = 'pointer'; pointer.current = e.pointerId; lastTarget.current = undefined;
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
        const bounds = e.currentTarget.getBoundingClientRect();
        const position = (e.clientX - bounds.left) / bounds.width * 200 - 100;
        if (Math.abs(position) <= 10) change(position, true);
      },
      onPointerUp: cancel, onPointerCancel: cancel, onLostPointerCapture: cancel, onBlur: cancel,
      onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (!latest.current.enabled) return;
        if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key) && (!e.repeat || source.current === 'keyboard')) {
          source.current = 'keyboard'; if (!e.repeat) lastTarget.current = undefined;
        }
      },
      onKeyUp: () => { if (source.current === 'keyboard') cancel(); },
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => { if (source.current) change(Number(e.target.value), source.current === 'pointer'); },
    }) : <View accessible accessibilityRole="adjustable" accessibilityLabel="Dome angle"
      accessibilityState={{disabled: !props.enabled}}
      accessibilityValue={{min: -160, max: 180, now: props.target, text: `${props.target} degrees`}}
      accessibilityActions={[{name: 'increment'}, {name: 'decrement'}]}
      onAccessibilityAction={event => {
        lastTarget.current = undefined;
        change(domeSliderPosition(props.target + (event.nativeEvent.actionName === 'increment' ? 1 : -1)), false);
      }}
      onLayout={event => setWidth(event.nativeEvent.layout.width)}
      onStartShouldSetResponder={() => latest.current.enabled}
      onMoveShouldSetResponder={() => latest.current.enabled && source.current === 'pointer'}
      onResponderGrant={event => {source.current = 'pointer'; lastTarget.current = undefined; change(event.nativeEvent.locationX / width * 200 - 100, true);}}
      onResponderMove={event => {if (source.current === 'pointer') change(event.nativeEvent.locationX / width * 200 - 100, true);}}
      onResponderRelease={cancel} onResponderTerminate={cancel}
      style={{height: 40, justifyContent: 'center', opacity: props.enabled ? 1 : .45}}>
      <View pointerEvents="none" style={{height: 12, borderRadius: 6, backgroundColor: colors.line}}>
        <View style={{height: 12, borderRadius: 6, width: `${percent}%`, backgroundColor: colors.primary}}/>
      </View>
      <View pointerEvents="none" style={{position: 'absolute', left: `${percent}%`, width: 22, height: 22, borderRadius: 11, transform: [{translateX: -11}], borderWidth: 2, borderColor: colors.primary, backgroundColor: colors.panel}}/>
    </View>}
    <View pointerEvents="none" style={{position: 'absolute', left: '50%', top: 1, width: 2, height: 9, backgroundColor: props.target === 0 ? colors.primary : colors.textMuted, transform: [{translateX: -1}]}}/>
    <View pointerEvents="none" style={{position: 'absolute', left: '50%', bottom: -1, width: 30, transform: [{translateX: -15}], alignItems: 'center'}}><HudText kind="mono" muted={props.target !== 0} style={{fontSize: 9, lineHeight: 11}}>0°</HudText></View>
  </View>;
}
