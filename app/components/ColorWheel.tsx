import { useColors } from "../theme/useColors.ts";
import React, { useState } from "react";
import { View, Pressable, Platform } from "react-native";
import { HudText } from "../theme/Theme.tsx";
import { HudButton } from "./Hud.tsx";
import { Icon } from "./Icon.tsx";
const swatches = [
  ['Red', '#ff3333'], ['Orange', '#ffaa33'], ['Yellow', '#ffff33'],
  ['Green', '#33ff33'], ['Cyan', '#33ffff'], ['Blue', '#3333ff'],
  ['Purple', '#aa33ff'], ['Pink', '#ff33aa'], ['White', '#ffffff'],
] as const;
/** Only the two RGB dome emitters use this ring; fixed lights keep brightness controls. */
export function ColorWheel({label,value,onChange,size=220}:{
 label:string;value:string;onChange:(color:string)=>void;size?:number;
}){
 const colors=useColors();
 const diameter=size*.18, radius=(size-diameter)/2, center=size*.32;
 const isOff=value.toLowerCase()==='#000000';
 return <View accessibilityLabel={label} style={{width:size,height:size,flexShrink:0}}>
  {swatches.map(([name,color],index)=>{
   const angle=index/swatches.length*Math.PI*2-Math.PI/2;
   const selected=value.toLowerCase()===color;
   return <Pressable key={color} accessibilityRole="button" accessibilityLabel={`${label} ${name.toLowerCase()}`}
    accessibilityState={{selected}} onPress={()=>onChange(color)}
    style={{position:'absolute',left:radius+radius*Math.cos(angle),top:radius+radius*Math.sin(angle),
     width:diameter,height:diameter,borderRadius:diameter/2,backgroundColor:color,
     borderWidth:selected?3:1,borderColor:selected?colors.text:colors.line}}/>;
  })}
  <Pressable accessibilityRole="button" accessibilityLabel={`${label} off`} accessibilityState={{selected:isOff}}
   onPress={()=>onChange('#000000')}
   style={({pressed})=>({position:'absolute',left:(size-center)/2,top:(size-center)/2,width:center,height:center,
    borderRadius:center/2,borderWidth:isOff?2:1,borderColor:isOff?colors.primary:colors.line2,
    backgroundColor:pressed?colors.panelRaised:colors.panel,alignItems:'center',justifyContent:'center',gap:1})}>
   <Icon name="power" size={Math.max(16,size*.12)} color={colors.primary}/>
   <HudText kind="heading" style={{fontSize:size<160?9:12,letterSpacing:.5}}>Off</HudText>
  </Pressable>
 </View>;
}
export function BrightnessSlider({
  id,
  label,
  value,
  onChange,
  compact = false,
  dense = false,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (n: number) => void;
  compact?: boolean;
  dense?: boolean;
}) {
  const colors = useColors();

  const [trackWidth, setTrackWidth] = useState(1);
  const bounded = (n: number) =>
    onChange(Math.max(0, Math.min(255, Math.round(n))));
  return (
    <View style={{ gap: dense ? 6 : compact ? 4 : 8, flexGrow: dense ? 0 : 1, minWidth: compact ? 0 : 180, flexDirection:dense?"row":"column", alignItems:dense?"center":undefined }}>
      {Platform.OS === "web" ? React.createElement("label", {
        htmlFor: id,
        style: { color: colors.text, fontFamily: "Inter", fontSize: compact ? 12 : 16, ...(dense?{width:72,flexShrink:0}:{}) },
      }, `${label} · ${Math.round((value / 255) * 100)}%`) : (
        <HudText style={dense ? {fontSize:11,width:70} : compact ? { fontSize: 12 } : undefined}>
          {label} · {Math.round((value / 255) * 100)}%
        </HudText>
      )}
      {Platform.OS === "web" ? (
        React.createElement("input", {
          id,
          type: "range",
          min: 0,
          max: 255,
          step: 1,
          value,
          "aria-label": label,
          onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
            bounded(Number(event.target.value)),
          style: { margin: 0, width: dense ? undefined : "100%", flex:dense?1:undefined, minWidth:0, minHeight: compact ? 32 : 56, accentColor: colors.primary },
        })
      ) : (
        <View
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel={label}
          accessibilityValue={{ min: 0, max: 255, now: value }}
          accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
          onAccessibilityAction={(event) =>
            bounded(
              value + (event.nativeEvent.actionName === "increment" ? 13 : -13),
            )
          }
          style={{ gap: 8, ...(dense?{flex:1,minWidth:0}:{}) }}
        >
          <View
            onLayout={(event) => setTrackWidth(event.nativeEvent.layout.width)}
            onStartShouldSetResponder={() => true}
            onMoveShouldSetResponder={() => true}
            onResponderGrant={(event) =>
              bounded((event.nativeEvent.locationX / trackWidth) * 255)
            }
            onResponderMove={(event) =>
              bounded((event.nativeEvent.locationX / trackWidth) * 255)
            }
            style={{ height: dense ? 32 : compact ? 36 : 56, justifyContent: "center" }}
          >
            <View
              pointerEvents="none"
              style={{
                height: 12,
                borderRadius: 6,
                backgroundColor: colors.line,
              }}
            >
              <View
                style={{
                  width: `${(value / 255) * 100}%`,
                  height: 12,
                  borderRadius: 6,
                  backgroundColor: colors.primary,
                }}
              />
            </View>
          </View>
          {!compact && <View style={{ flexDirection: "row", gap: 8 }}>
            <HudButton
              label={`Decrease ${label}`}
              onPress={() => bounded(value - 13)}
            />
            <HudButton
              label={`Increase ${label}`}
              onPress={() => bounded(value + 13)}
            />
          </View>}
        </View>
      )}
    </View>
  );
}
