import { useColors } from "../theme/useColors.ts";
import { DomeSlider } from './DomeSlider.tsx';
import { formatDomeDegrees } from '../cockpit/domeReading.ts';
import { domePointerAngle } from "../cockpit/DomeTargets.ts";
import React, { useEffect, useRef, useState } from "react";
import { View, Platform } from "react-native";
import Svg, { Circle, Line, Path, G, Rect, Text as SvgText } from "react-native-svg";
import { DomeGesture } from "../cockpit/controlModels.ts";
type Props = {
  target: number;
  size?: number;
  showFineControls?: boolean;
  observed?: number;
  enabled: boolean;
  onTarget: (n: number) => void;
  registerCancel: (c: () => void) => () => void;
};
export function DomeDial({
  target,
  size = 156,
  showFineControls = false,
  observed,
  enabled,
  onTarget,
  registerCancel,
}: Props) {
  const colors = useColors();

  const [gesture] = useState(() => new DomeGesture());
  const element = useRef<HTMLDivElement>(null);
  const lastTap = useRef(0);
  const latest = useRef({ enabled, onTarget });
  latest.current = { enabled, onTarget };
  const cancel = () => {
    const pointer = gesture.pointer;
    gesture.cancel();
    lastTap.current = 0;
    try {
      if (pointer !== undefined && element.current?.hasPointerCapture(pointer))
        element.current.releasePointerCapture(pointer);
    } catch {}
  };
  useEffect(() => registerCancel(cancel), [registerCancel]);
  useEffect(() => {
    if (!enabled) cancel();
  }, [enabled]);
  useEffect(() => {
    if (Platform.OS !== "web") return;
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("blur", cancel);
      cancel();
    };
  }, []);
  const xy = (angle: number, r: number) => ({
    x: 100 + Math.sin((angle * Math.PI) / 180) * r,
    y: 100 - Math.cos((angle * Math.PI) / 180) * r,
  });
  const t = xy(target, 79),
    o = observed === undefined ? undefined : xy(observed, 79);
  const signed = (n: number) => `${n > 0 ? "+" : ""}${Math.round(n)}°`;
  const end = t;
  const art = (
    <Svg viewBox="0 0 200 200" width={size} height={size}>
      <Circle
        cx={100}
        cy={100}
        r={90}
        stroke={colors.line}
        fill={colors.panel}
        fillOpacity={0.8}
      />
      <Circle
        cx={100}
        cy={100}
        r={79}
        fill="none"
        stroke={colors.primary}
        strokeOpacity={0.3}
        strokeWidth={8}
        strokeDasharray="1.6 6.9"
      />
      {Array.from({ length: 4 }, (_, i) => {
        const a = xy(i * 90, 78),
          b = xy(i * 90, 89);
        return (
          <Line
            key={i}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            stroke={colors.primary}
            strokeOpacity={0.5}
            strokeWidth={2}
          />
        );
      })}
      <Path
        d="M100 179 A79 79 0 0 1 73 174"
        stroke={colors.danger}
        strokeOpacity={0.6}
        strokeWidth={8}
        fill="none"
      />
      {/* Input feedback must not wait for the lower-rate measured-position stream. */}
      <G rotation={target} origin="100, 100">
        <Circle cx={100} cy={100} r={70} fill={colors.panelRaised} stroke={colors.primary} strokeWidth={1.5} />
        <Circle cx={100} cy={100} r={66} fill="none" stroke={colors.line2} />
        {Array.from({length:8},(_,i)=>{
          const a=xy(i*45-15,62),b=xy(i*45+15,62),c=xy(i*45+15,37),d=xy(i*45-15,37);
          return <Path key={`crown-${i}`} d={`M${a.x} ${a.y} A62 62 0 0 1 ${b.x} ${b.y} L${c.x} ${c.y} A37 37 0 0 0 ${d.x} ${d.y} Z`}
            fill={colors.primary} fillOpacity={i%2===0?0.3:0.15} stroke={colors.primary} strokeWidth={1.2} />;
        })}
        <Circle cx={100} cy={100} r={30} fill={colors.panel} stroke={colors.primary} strokeWidth={1.5} />
        <Circle cx={100} cy={100} r={25} fill="none" stroke={colors.line2} />
        <Rect x={91} y={27} width={18} height={17} rx={3} fill={colors.panel} stroke={colors.primaryHi} strokeWidth={1.5} />
        <Circle cx={100} cy={35} r={5} fill={colors.primary} stroke={colors.text} strokeWidth={1} />
        <Path d="M86 26 L86 20 L114 20 L114 26" fill="none" stroke={colors.primaryHi} strokeWidth={1.5} />
      </G>
      {target !== 0 && (
        <Path
          d={`M100 21 A79 79 0 ${Math.abs(target) > 180 ? 1 : 0} ${target > 0 ? 1 : 0} ${end.x} ${end.y}`}
          stroke={colors.primary}
          strokeWidth={3}
          strokeLinecap="round"
          fill="none"
        />
      )}
      <Circle
        cx={t.x}
        cy={t.y}
        r={8}
        fill={colors.panel}
        stroke={colors.primaryHi}
        strokeWidth={2}
      />
      {o && (
        <Circle
          cx={o.x}
          cy={o.y}
          r={6}
          stroke={colors.bg}
          strokeWidth={1.8}
          fill={colors.primaryHi}
        />
      )}
      <SvgText
        x={100}
        y={105}
        textAnchor="middle"
        fill={colors.text}
        fontFamily="monospace"
        fontSize={14}
      >
        {formatDomeDegrees(observed)}
      </SvgText>
      <SvgText
        x={100}
        y={194}
        textAnchor="middle"
        fill={colors.textMuted}
        fontFamily="monospace"
        fontSize={8}
        letterSpacing={0.5}
      >
        {`TGT ${signed(target)}`}
      </SvgText>
    </Svg>
  );
  const move = (id: number, x: number, y: number, w: number, h: number) => {
    if (!latest.current.enabled) return;
    const angle = gesture.pointer === id ? domePointerAngle(x,y,w,h) : undefined;
    if (angle !== undefined) latest.current.onTarget(angle);
  };
  const begin = (id: number, x: number, y: number, w: number, h: number) => {
    if (!latest.current.enabled || !gesture.begin(id)) return false;
    const now = Date.now();
    if (now - lastTap.current < 300) {latest.current.onTarget(0);gesture.cancel();lastTap.current=0;return false;}
    else move(id, x, y, w, h);
    lastTap.current = now;
    return true;
  };
  return (
    <View style={{ alignItems: "center", width: "100%", gap: 4 }}>
      {Platform.OS === "web" ? (
        React.createElement(
          "div",
          {
            ref: element,
            role: "group",
            "aria-label": `Dome dial; target ${signed(target)}, observed ${observed === undefined ? "unavailable" : formatDomeDegrees(observed)}; drag around ring, double tap to center`,
            style: {
              width: size,
              height: size,
              touchAction: "none",
              opacity: enabled ? 1 : 0.5,
            },
            onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
              const r = e.currentTarget.getBoundingClientRect();
              if (
                begin(
                  e.pointerId,
                  e.clientX - r.left,
                  e.clientY - r.top,
                  r.width,
                  r.height,
                )
              )
                e.currentTarget.setPointerCapture(e.pointerId);
            },
            onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
              const r = e.currentTarget.getBoundingClientRect();
              move(
                e.pointerId,
                e.clientX - r.left,
                e.clientY - r.top,
                r.width,
                r.height,
              );
            },
            onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => {
              if (gesture.pointer === e.pointerId) gesture.cancel();
            },
            onPointerCancel: cancel,
            onLostPointerCapture: () => gesture.cancel(),
          },
          art,
        )
      ) : (
        <View
          style={{ width: size, height: size }}
          onStartShouldSetResponder={() => enabled}
          onResponderGrant={(e) =>
            begin(
              Number(e.nativeEvent.identifier),
              e.nativeEvent.locationX,
              e.nativeEvent.locationY,
              size,
              size,
            )
          }
          onResponderMove={(e) =>
            move(
              Number(e.nativeEvent.identifier),
              e.nativeEvent.locationX,
              e.nativeEvent.locationY,
              size,
              size,
            )
          }
          onResponderRelease={() => gesture.cancel()}
          onResponderTerminate={cancel}
        >
          {art}
        </View>
      )}
      {showFineControls && (
        <View style={{ width: size }}>
          <DomeSlider target={target} enabled={enabled} onTarget={onTarget} registerCancel={registerCancel}/>
        </View>
      )}
    </View>
  );
}
