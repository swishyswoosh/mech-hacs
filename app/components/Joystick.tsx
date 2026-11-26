import { useColors } from "../theme/useColors.ts";
import React, { useEffect, useRef, useState } from "react";
import { Platform, View } from "react-native";
import { FloatingJoystick } from "../cockpit/controlModels.ts";
import { NativeDriveControls } from "../platform/NativeInputs";
import Svg, {
  Circle,
  Line,
  Path,
  Defs,
  RadialGradient,
  Stop,
} from "react-native-svg";
type Props = {
  enabled: boolean;
  size?: number;
  speed: number;
  onBegin: () => boolean;
  onMove: (point: [number, number]) => void;
  onRelease: () => void;
  registerCancel: (handler: () => void) => () => void;
};
export function Joystick(props: Props) {
  const colors = useColors();

  const size = props.size ?? 176;
  const [pad] = useState(() => new FloatingJoystick());
  const latest = useRef(props);
  latest.current = props;
  const el = useRef<HTMLButtonElement>(null);
  const [visual, setVisual] = useState({
    dx: 0,
    dy: 0,
    active: false,
  });
  const started = useRef(false);
  const release = (notify = true) => {
    const id = pad.pointer;
    pad.cancel();
    try {
      if (id !== undefined && el.current?.hasPointerCapture(id))
        el.current.releasePointerCapture(id);
    } catch {}
    if (started.current && notify) latest.current.onRelease();
    started.current = false;
    setVisual((v) => ({ ...v, active: false, dx: 0, dy: 0 }));
  };
  useEffect(
    () => props.registerCancel(() => release(false)),
    [props.registerCancel],
  );
  useEffect(() => {
    if (!props.enabled) release();
  }, [props.enabled]);
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const blur = () => release();
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("blur", blur);
      release();
    };
  }, []);
  const commandedSpeed = visual.active
    ? Math.min(1, Math.hypot(visual.dx, visual.dy) / 70) * (props.speed / 100)
    : 0;
  if (Platform.OS === "android")
    return (
      <NativeDriveControls
        cockpit
        driveEnabled={props.enabled}
        speedPercent={props.speed}
        style={{ height: size, width: size, alignSelf:"center" }}
        onControlChange={({ nativeEvent: e }) => {
          if (e.kind === "start") started.current = props.onBegin();
          else if (e.kind === "move" && started.current)
            props.onMove([e.x, e.y]);
          else if (e.kind === "release") release();
        }}
      />
    );
  return (
    <View style={{ height: size, width: "100%", position: "relative" }}>
      {React.createElement(
        "button",
        {
          ref: el,
          type: "button",
          disabled: !props.enabled,
          "aria-label": "Drive joystick; drag inside circle, release to stop",
          style: {
            position: "absolute",
            left: "50%",
            top: 0,
            transform: "translateX(-50%)",
            width: size,
            height: size,
            clipPath: "circle(47.159% at 50% 50%)",
            border: "none",
            borderRadius: 16,
            background: "transparent",
            padding: 0,
            color: colors.primary,
            touchAction: "none",
            userSelect: "none",
            overflow: "visible",
            opacity: props.enabled ? 1 : 0.5,
          },
          onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
            if (!props.enabled || e.button !== 0 || pad.pointer !== undefined)
              return;
            const bounds=e.currentTarget.getBoundingClientRect();
            if(Math.hypot(e.clientX-bounds.left-bounds.width/2,e.clientY-bounds.top-bounds.height/2)>Math.min(bounds.width,bounds.height)*83/176)return;
            const point = pad.begin(e.pointerId, e.clientX, e.clientY);
            if (!point) return;
            try {
              e.currentTarget.setPointerCapture(e.pointerId);
            } catch {
              pad.cancel();
              return;
            }
            started.current = props.onBegin();
            if (!started.current) {
              release(false);
              return;
            }
            setVisual({
              dx: 0,
              dy: 0,
              active: true,
            });
          },
          onPointerMove: (e: React.PointerEvent<HTMLButtonElement>) => {
            const p = pad.move(e.pointerId, e.clientX, e.clientY, 100);
            if (p && started.current) {
              props.onMove(p);
              setVisual((v) => ({ ...v, dx: p[0] * 70, dy: -p[1] * 70 }));
            }
          },
          onPointerUp: (e: React.PointerEvent<HTMLButtonElement>) => {
            if (pad.pointer === e.pointerId) release();
          },
          onPointerCancel: (e: React.PointerEvent<HTMLButtonElement>) => {
            if (pad.pointer === e.pointerId) release();
          },
          onLostPointerCapture: (e: React.PointerEvent<HTMLButtonElement>) => {
            if (pad.pointer === e.pointerId) release();
          },
          onBlur: () => release(),
        },
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            width: size,
            height: size,
            transform: [{ translateX: -size / 2 }, { translateY: -size / 2 }],
          }}
        >
          <Svg viewBox="0 0 176 176" width={size} height={size}>
            <Defs>
              <RadialGradient id="stickHalo">
                <Stop
                  offset="0"
                  stopColor={colors.primary}
                  stopOpacity={0.14}
                />
                <Stop offset="1" stopColor={colors.primary} stopOpacity={0} />
              </RadialGradient>
              <RadialGradient id="stickKnob" cx="38%" cy="32%" r="70%">
                <Stop offset="0" stopColor={colors.stickHi} />
                <Stop offset="0.52" stopColor={colors.primary} />
                <Stop offset="1" stopColor={colors.stickLow} />
              </RadialGradient>
            </Defs>
            <Circle
              cx={88}
              cy={88}
              r={83}
              fill="url(#stickHalo)"
              stroke={colors.primary}
              strokeOpacity={0.35}
            />
            <Circle
              cx={88}
              cy={88}
              r={58}
              fill="none"
              stroke={colors.primary}
              strokeOpacity={0.22}
              strokeDasharray="3 5"
            />
            <Circle
              cx={88}
              cy={88}
              r={8}
              fill="none"
              stroke={colors.primary}
              strokeOpacity={0.3}
            />
            <Path
              d="M88 8v10M88 158v10M8 88h10M158 88h10"
              stroke={colors.primary}
              strokeWidth={2}
              strokeOpacity={0.45}
            />
            {commandedSpeed > 0 && (
              <Circle
                cx={88}
                cy={88}
                r={84}
                fill="none"
                stroke={colors.primaryHi}
                strokeWidth={3}
                strokeLinecap="round"
                strokeDasharray={`${commandedSpeed * 128} 528`}
                rotation={-90}
                origin="88,88"
              />
            )}
            {visual.active && (
              <Line
                x1={88}
                y1={88}
                x2={88 + visual.dx}
                y2={88 + visual.dy}
                stroke={colors.primary}
                strokeWidth={2}
                strokeDasharray="2 4"
              />
            )}
            <Circle
              cx={88 + visual.dx}
              cy={88 + visual.dy}
              r={33}
              fill={colors.primary}
              fillOpacity={visual.active ? 0.19 : 0.08}
            />
            <Circle
              cx={88 + visual.dx}
              cy={88 + visual.dy}
              r={26}
              fill="url(#stickKnob)"
              stroke={colors.primaryHi}
              strokeOpacity={0.6}
            />
            <Circle
              cx={88 + visual.dx}
              cy={88 + visual.dy}
              r={11}
              fill="none"
              stroke="#FFFFFF"
              strokeOpacity={0.45}
            />
          </Svg>
        </View>,
      )}
    </View>
  );
}
