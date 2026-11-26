import { useColors } from "../theme/useColors.ts";
import { CockpitSensors } from "./CockpitSensors.tsx";
import React, { useState } from "react";
import { View, Pressable, useWindowDimensions, Platform } from "react-native";
import Svg, { Path, Circle } from "react-native-svg";
import { HudButton, HudPanel, StopButton } from "./Hud.tsx";
import { Icon } from "./Icon.tsx";
import { Tooltip } from "./Tooltip.tsx";
import { Joystick } from "./Joystick.tsx";
import { DomeDial } from "./DomeDial.tsx";
import { PulseButton } from "./PulseButton.tsx";
import { HudText } from "../theme/Theme.tsx";
import type { HudPreferences } from "../library/preferences.ts";
import { libraryItem } from "../library/catalog.ts";
type Props = {
  prefs: HudPreferences;
  portrait: boolean;
  ready: boolean;
  soundReady?: boolean;
  pulseBusy: boolean;
  stopping: boolean;
  wizard: boolean;
  stance: "two" | "three" | "waddle";
  heading?: number;
  joystick: React.ComponentProps<typeof Joystick>;
  dome: React.ComponentProps<typeof DomeDial>;
  inputStatus: string;
  onGear: (i: number) => void;
  onStance: (s: "two" | "three" | "waddle") => void;
  onSlot: (i: number) => void;
  onLibrary: (i: number) => void;
  onWheelCheck: () => void;
  onStop: () => void;
  onActivate: () => void;
  onRevoke: () => void;
  onNudge: (d: "Forward" | "Reverse" | "Turn Left" | "Turn Right") => void;
  children?: React.ReactNode;
};
function SoundGlyph({ name, size = 20 }: { name: string; size?: number }) {
  const colors = useColors();

  const n = name.toLowerCase();
  const mood = /positive|happy|laugh|sad|negative/.test(n);
  let path = "M9 18V5l10-2v13M9 8l10-2";
  if (/alarm/.test(n))
    path = "M5 17h14M7 17v-6a5 5 0 0 1 10 0v6M9 21h6M12 2v2M3 7l2 1M21 7l-2 1";
  else if (/scream/.test(n)) path = "M13 2L5 14h6l-1 8 9-13h-7z";
  else if (/yes/.test(n)) path = "M5 12l5 5L20 6";
  else if (/\bno\b/.test(n)) path = "M6 6l12 12M18 6L6 18";
  else if (mood)
    path = /sad|negative/.test(n)
      ? "M8 16q4-5 8 0M8 9h.01M16 9h.01"
      : "M7 14q5 6 10 0M8 9h.01M16 9h.01";
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={colors.primary}
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={true}
    >
      {mood && <Circle cx={12} cy={12} r={9} />}
      <Path d={path} />
      {!mood && path.startsWith("M9 18") && (
        <>
          <Circle cx={6} cy={18} r={3} />
          <Circle cx={16} cy={16} r={3} />
        </>
      )}
    </Svg>
  );
}
const shortName = (name: string) =>
  name
    .replace(/^Positive 1$/, "Happy")
    .replace(/^Sad 1$/, "Sad")
    .replace(/^Alarm 1$/, "Alarm")
    .replace(/^Laugh 1$/, "Laugh")
    .replace(/^Hey 1$/, "Hey")
    .replace(/^Emote /, "");
export function CockpitSurface(p: Props) {
  const colors = useColors();

  const { height, width } = useWindowDimensions();
  const [surface, setSurface] = useState({ width, height: 400 });
  const low = Platform.OS === "android" && height < 600;
  const compact = surface.height < 560;
  const tight = compact && surface.width < 750;
  const [customizing, setCustomizing] = useState(false);
  const [driveWidth, setDriveWidth] = useState(190);
  const sensorHeight = low ? 48 : 64;
  const [controlsHeight, setControlsHeight] = useState(260);
  const [rightWidth,setRightWidth]=useState(400);
  const stickSize = Math.max(low?100:140, Math.min(low?180:300,driveWidth-8,controlsHeight-(low?30:54)));
  const dialSize = Math.max(low?64:96, Math.min(low?150:240,controlsHeight-64,rightWidth*.46));
  const soundHeight = Math.max(low?24:36, Math.min(low?48:72,(controlsHeight-(low?30:40))/3,(rightWidth-dialSize-24)/3));
  const stanceHeight = low ? Math.min(36,Math.max(28,controlsHeight*.18)) : 40;
  const stopHeight = low ? Math.min(44,Math.max(32,controlsHeight*.22)) : 52;
  const gearStep = Math.max(low?18:28,Math.min(low?40:54,(controlsHeight-stanceHeight-stopHeight-(low?12:32))/3));
  const shifterWidth=low?64:84;
  const stanceControls = (
              <View
                style={{
                  flexDirection: "row",
                  borderWidth: 1,
                  borderColor: colors.line,
                  borderRadius: 10,
                  overflow: "hidden",
                  alignSelf: "center",
                  backgroundColor: colors.bg,
                }}
              >
                {(["two", "three", "waddle"] as const).map((s, i) => (
                  <Pressable
                    key={s}
                    accessibilityRole="button"
                    accessibilityLabel={
                      ["2-leg stance", "3-leg stance", "Waddle stance"][i]
                    }
                    accessibilityState={{
                      selected: s === p.stance,
                      disabled: !p.ready || p.pulseBusy,
                    }}
                    disabled={!p.ready || p.pulseBusy}
                    onPress={() => p.onStance(s)}
                    style={({ pressed }) => ({
                      minWidth: low ? 40 : 56,
                      minHeight: stanceHeight,
                      paddingHorizontal: low ? 6 : compact ? 10 : 18,
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor:
                        s === p.stance ? colors.primary : "transparent",
                      borderRightWidth: i < 2 ? 1 : 0,
                      borderColor: colors.line,
                      opacity: pressed
                        ? 0.65
                        : !p.ready || p.pulseBusy
                          ? 0.5
                          : 1,
                    })}
                  >
                    <HudText
                      kind="heading"
                      style={{
                        fontSize: low ? 10 : compact ? 12 : 14,
                        letterSpacing: low ? 0.5 : 1,
                        color:
                          s === p.stance ? colors.onPrimary : colors.textMuted,
                      }}
                    >
                      {["2-LEG", "3-LEG", "WADDLE"][i]}
                    </HudText>
                  </Pressable>
                ))}
              </View>
  );
  return (
    <View
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        setSurface((old) =>
          old.width === width && old.height === height
            ? old
            : { width, height },
        );
      }}
      style={{
        flex: 1,
        minHeight: 0,
        paddingHorizontal: low ? 10 : tight ? 8 : compact ? 18 : 30,
        paddingVertical: low ? 2 : compact ? 8 : 28,
        alignItems: "center",
      }}
    >
      {p.portrait ? (
        <HudPanel style={{ width: "100%" }}>
          <HudText kind="heading">Rotate to drive</HudText>
          <HudText>
            Turn your phone sideways for the cockpit. STOP remains available.
          </HudText>
          <StopButton prominent onPress={p.onStop} stopping={p.stopping} />
        </HudPanel>
      ) : (
        <View
          onLayout={event => setControlsHeight(event.nativeEvent.layout.height)}
          style={{
            width: "100%",
            maxWidth: 1200,
            flexGrow: 1,
            flex:1,minHeight:0,
            justifyContent: "center",
          }}
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: tight ? 8 : compact ? 14 : 30,
            }}
          >
            <View
              onLayout={(event) => setDriveWidth(event.nativeEvent.layout.width)}
              style={{
                flex: 1,
                minWidth: 0,
                alignSelf: "stretch",
                justifyContent: "space-between",
                gap: compact ? 2 : 16,
              }}
            >
              {!low && <HudText
                kind="mono"
                muted
                style={{ fontSize: 10, letterSpacing: 1.6, paddingLeft: 10 }}
              >
                DRIVE · DRAG JOYSTICK
              </HudText>}
              <View style={{ position: "relative", justifyContent: "center" }}>
                <Joystick {...p.joystick} size={stickSize} />

              </View>
              <View
                style={{
                  flexDirection: "row",
                  justifyContent: "space-between",
                  alignItems: "center",
                  paddingHorizontal: 10,
                  gap: 8,
                }}
              >
                <HudText kind="mono" muted style={{ fontSize: 10 }}>
                  CAP{" "}
                  <HudText kind="mono" style={{ fontSize: 11 }}>
                    {p.prefs.gearSpeeds[p.prefs.gear]}%
                  </HudText>
                </HudText>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Calibrate wheels"
                  accessibilityHint="Optional wheel direction calibration"
                  disabled={!p.ready || p.pulseBusy}
                  onPress={p.onWheelCheck}
                  style={{minHeight:low?24:32,paddingHorizontal:6,justifyContent:'center',borderWidth:1,borderColor:colors.line2,borderRadius:5,backgroundColor:colors.panel,opacity:!p.ready||p.pulseBusy?0.45:1}}
                >
                  <HudText kind="mono" muted style={{fontSize:9}}>CALIBRATE WHEELS</HudText>
                </Pressable>
                <HudText kind="mono" muted style={{ fontSize: 10 }}>
                  HDG{" "}
                  <HudText kind="mono" style={{ fontSize: 11 }}>
                    {p.heading === undefined
                      ? "—"
                      : `${Math.round(p.heading)}°`}
                  </HudText>
                </HudText>
                {!compact && (
                  <HudText kind="mono" muted style={{ fontSize: 10 }}>
                    RELEASE TO STOP
                  </HudText>
                )}
              </View>
            </View>
            <View
              style={{
                width: low ? 136 : compact ? 170 : 180,
                alignItems: "center",
                gap: low ? 4 : 8,
              }}
            >
              {stanceControls}
              <View style={{alignItems:"center",gap:low?4:8}} >
                {<View accessibilityLabel="Vertical gear shifter" style={{width:shifterWidth,height:gearStep * 3,borderWidth:1,borderColor:colors.line2,borderRadius:12,backgroundColor:colors.bg}}>
                  <View pointerEvents="none" style={{position:"absolute",left:low?44:54,top:gearStep / 2,bottom:gearStep / 2,width:4,borderRadius:2,backgroundColor:colors.line2}} />
                  {[0,1,2].map((i) => <Pressable key={i} accessibilityRole="button"
                    accessibilityLabel={`Gear ${i + 1}, ${p.prefs.gearSpeeds[i]} percent speed cap`}
                    accessibilityState={{selected:p.prefs.gear === i}} onPress={() => p.onGear(i)}
                    style={{height:gearStep,width:shifterWidth-2,flexDirection:"row",alignItems:"center",paddingLeft:low?8:10,gap:8}}>
                    <HudText kind="heading" style={{width:low?16:22,fontSize:low?16:18,color:p.prefs.gear===i?colors.primary:colors.textMuted}}>{i+1}</HudText>
                    <View pointerEvents="none" style={{width:low?28:32,height:low?28:32,alignItems:"center",justifyContent:"center"}}>
                      <View style={{width:p.prefs.gear===i?(low?28:32):8,height:p.prefs.gear===i?(low?28:32):8,borderRadius:14,borderWidth:p.prefs.gear===i?3:1,borderColor:p.prefs.gear===i?colors.primaryHi:colors.line2,backgroundColor:p.prefs.gear===i?colors.primary:colors.panel}} />
                    </View>
                  </Pressable>)}
                </View>}
                <View style={{ alignItems: "center", gap: 9 }}>
                <Tooltip label={p.stopping ? "Stopping motion" : "Stop motion"}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="STOP"
                  accessibilityState={{ busy: p.stopping }}
                  aria-busy={p.stopping}
                  onPress={p.onStop}
                  style={({ pressed }) => ({
                    width: shifterWidth,
                    height: stopHeight,
                    justifyContent: "center",
                    alignItems: "center",
                    backgroundColor: "#B82222",
                    borderColor: "#FF8686",
                    borderWidth: 1,
                    borderRadius: 13,
                    opacity: pressed ? 0.8 : 1,
                  })}
                >
                  <Icon name="stop" color="#FFFFFF" size={p.stopping ? 20 : 28} />
                  {p.stopping && <HudText
                    accessibilityLiveRegion="polite"
                    kind="heading"
                    style={{ color: "#FFFFFF", fontSize: low ? 8 : 18, letterSpacing: 1 }}
                  >
                    STOPPING
                  </HudText>}
                </Pressable>
                </Tooltip>
                {Platform.OS === "web" && <HudText
                  kind="mono"
                  muted
                  style={{ fontSize: 9, letterSpacing: 1 }}
                >
                  SPACE · ESC · START
                </HudText>}
              </View>
              </View>
            </View>
            <View
              onLayout={event=>setRightWidth(event.nativeEvent.layout.width)}
              style={{
                flex: 1.8,
                minWidth: 0,
                alignSelf: "stretch",
                justifyContent: "space-between",
                alignItems: "center",
                gap: low ? 8 : compact ? 8 : 20,
                flexDirection: "row",
              }}
            >
              <View style={{width:dialSize,alignSelf:"center"}}><DomeDial
                {...p.dome}
                size={dialSize}
                showFineControls
              /></View>
              <View style={{width:soundHeight * 3 + (low?8:16),flexShrink:0,minWidth:0,maxWidth:compact?280:380,gap:4}}>
                <View style={{flexDirection:'row',alignItems:'center',justifyContent:low?'flex-end':'space-between'}}>
                  {!low && <HudText kind="mono" muted style={{fontSize:9}}>{customizing?'CHOOSE A BUTTON TO REPLACE':'SOUNDBOARD'}</HudText>}
                  <Pressable accessibilityRole="button" accessibilityLabel={customizing?'Done customizing sounds':'Customize cockpit sounds'} accessibilityState={{selected:customizing}} onPress={()=>setCustomizing(!customizing)} style={{minHeight:low?18:32,paddingHorizontal:low?0:6,justifyContent:'center'}}>
                    <HudText kind="heading" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8} style={{fontSize:low?8:12,letterSpacing:low?0.5:1.8,color:colors.primary}}>{customizing?'Done':'Customize'}</HudText>
                  </Pressable>
                </View>
              <View
                style={{
                  flexDirection: "row",
                  flexWrap: "wrap",
                  width: "100%",
                  maxWidth: compact ? 280 : 380,
                  gap: low ? 4 : 8,
                  justifyContent: "center",
                }}
              >
                {p.prefs.soundboard.map((key, i) => {
                  const item = key ? libraryItem(key) : undefined;
                  return (
                    <Pressable
                      key={i}
                      accessibilityRole="button"
                      accessibilityLabel={customizing?`Replace soundboard ${i + 1}: ${item?.name || "Empty"}`:`Soundboard ${i + 1}: ${item?.name || "Empty"}`}
                      accessibilityHint={customizing?"Choose a replacement sound":"Long press to change this slot"}
                      onPress={() => customizing?p.onLibrary(i):p.onSlot(i)}
                      onLongPress={() => p.onLibrary(i)}
                      disabled={!customizing && !(p.soundReady ?? p.ready) && !!item}
                      style={({ pressed }) => ({
                        width: soundHeight,
                        height: soundHeight,
                        minWidth: soundHeight,
                        flexGrow: 0,
                        minHeight: soundHeight,
                        flexDirection: "column",
                        padding: low ? 2 : 5,
                        borderWidth: 1,
                        borderColor: pressed || customizing ? colors.primary : colors.line,
                        borderRadius: 10,
                        backgroundColor: pressed
                          ? colors.panelRaised
                          : colors.panel,
                        alignItems: "center",
                        justifyContent: "center",
                        gap: low ? 2 : 4,
                        opacity: !customizing && !(p.soundReady ?? p.ready) && !!item ? 0.5 : 1,
                      })}
                    >
                      <HudText
                        kind="mono"
                        muted
                        style={{ position: "absolute", top: low ? 1 : 4, right: low ? 2 : 6, fontSize: low ? 7 : 9, lineHeight: low ? 8 : 11 }}
                      >
                        {i + 1}
                      </HudText>
                      <SoundGlyph name={item?.name || "Choose"} size={Platform.OS === "android" ? Math.min(low ? 18 : 28, soundHeight - 18) : 20} />
                      <HudText
                        kind="heading"
                        muted
                        numberOfLines={1}
                        adjustsFontSizeToFit={low}
                        minimumFontScale={0.8}
                        style={{
                          fontSize: low ? 8.5 : compact ? 10 : 12,
                          ...(low ? {lineHeight:10} : {}),
                          letterSpacing: low ? 0.2 : 0.5,
                          textAlign: "center",
                          maxWidth: "100%",
                          ...(low ? {width:"100%"} : {}),
                        }}
                      >
                        {item ? shortName(item.name) : "Choose"}
                      </HudText>
                    </Pressable>
                  );
                })}
              </View>
              </View>
            </View>
          </View>
          {p.prefs.showNudges && (
            <View style={{ marginTop: 14, gap: 6 }}>
              <HudText kind="mono" muted>
                ACCESSIBLE NUDGES · 200 MS
              </HudText>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                {(
                  ["Forward", "Reverse", "Turn Left", "Turn Right"] as const
                ).map((d) => (
                  <PulseButton
                    key={d}
                    label={`Nudge ${d}`}
                    disabled={!p.ready || p.wizard || p.pulseBusy}
                    onPress={() => p.onNudge(d)}
                  />
                ))}
              </View>
            </View>
          )}
        </View>
      )}
      {Platform.OS === "web" && <HudText kind="mono" muted style={{width:'100%',maxWidth:1100,fontSize:9,lineHeight:14,marginTop:low?2:6,textAlign:'center'}}>
        WASD / arrows drive · Q/E dome · C center · 1–9 soundboard · [ ] gear · T stance · H home
      </HudText>}
      <View style={{width:"100%",height:sensorHeight,flexShrink:0,justifyContent:"flex-end"}}><CockpitSensors /></View>
      {p.children}
    </View>
  );
}
