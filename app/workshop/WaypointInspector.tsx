import { useColors } from "../theme/useColors.ts";
import React from "react";
import { ScrollView, View, Pressable } from "react-native";
import { HudPanel } from "../components/Hud.tsx";
import { HudText } from "../theme/Theme.tsx";
import { Field } from "./Controls.tsx";
import { editWaypoint, moveWaypoint } from "./pathEditor.ts";
import type { PathEditor } from "./usePathEditor.ts";

function InspectorButton({label,text=label,onPress,disabled=false,row=false,selected=false}:{label:string;text?:string;onPress:()=>void;disabled?:boolean;row?:boolean;selected?:boolean}){
  const colors = useColors();

 return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{disabled,selected}} disabled={disabled} onPress={onPress}
  style={({pressed})=>({minHeight:32,paddingVertical:5,paddingHorizontal:8,borderWidth:1,borderColor:selected?colors.primary:colors.line2,borderRadius:6,backgroundColor:selected?colors.panelRaised:colors.panel,opacity:disabled?0.45:pressed?0.7:1,justifyContent:"center",flexBasis:row?undefined:"47%",flexGrow:row?0:1})}>
  <HudText numberOfLines={1} style={{fontSize:12,color:colors.primary}}>{text}</HudText>
 </Pressable>;
}
export function WaypointInspector({ editor }: { editor: PathEditor }) {
  const {
    points,
    selected,
    setSelected,
    x,
    setX,
    y,
    setY,
    attempt,
    change,
    select,
    coordinate,
    append,
  } = editor;
  return (
    <HudPanel style={{padding:8,gap:6}}>
      <HudText kind="heading" style={{fontSize:16}}>
        Waypoint inspector
      </HudText>
      <View style={{flexDirection:"row",flexWrap:"wrap",gap:6}}>
        <View style={{flex:1,minWidth:0}}><Field compact label="Point X preview units" value={x} onChange={setX} /></View>
        <View style={{flex:1,minWidth:0}}><Field compact label="Point Y preview units" value={y} onChange={setY} /></View>
      </View>
      <View style={{flexDirection:"row",flexWrap:"wrap",gap:6}}>
        <InspectorButton
          label="Add path point" text="Add point"
          onPress={() => attempt(() => append(coordinate()))}
        />
        <InspectorButton
          label="Update selected waypoint" text="Update"
          disabled={selected < 0 || selected >= points.length}
          onPress={() =>
            attempt(() =>
              change(editWaypoint(points, selected, "replace", coordinate())),
            )
          }
        />
        <InspectorButton
          label="Insert after selected" text="Insert after"
          disabled={selected < 0 || selected >= points.length}
          onPress={() =>
            attempt(() => {
              change(editWaypoint(points, selected, "insert", coordinate()));
              setSelected(selected + 1);
            })
          }
        />
        <InspectorButton
          label="Delete selected waypoint" text="Delete"
          disabled={selected < 0 || selected >= points.length}
          onPress={() =>
            attempt(() => {
              change(editWaypoint(points, selected, "delete"));
              setSelected(-1);
            })
          }
        />
        <InspectorButton
          label="Move waypoint earlier" text="Earlier"
          disabled={selected <= 0}
          onPress={() =>
            attempt(() => {
              change(moveWaypoint(points, selected, -1));
              setSelected(selected - 1);
            })
          }
        />
        <InspectorButton
          label="Move waypoint later" text="Later"
          disabled={selected < 0 || selected >= points.length - 1}
          onPress={() =>
            attempt(() => {
              change(moveWaypoint(points, selected, 1));
              setSelected(selected + 1);
            })
          }
        />
        <InspectorButton
          label="Undo last point" text="Undo last"
          disabled={!points.length}
          onPress={() => {
            change(points.slice(0, -1));
            setSelected(-1);
          }}
        />
      </View>
      <ScrollView style={{ maxHeight: 144 }} contentContainerStyle={{gap:4}} nestedScrollEnabled>
        {points.map((p, i) => (
          <InspectorButton
            key={i} row selected={selected===i}
            text={`#${i+1} · X ${p.x} · Y ${p.y}`}
            label={`${selected === i ? "Selected · " : ""}Waypoint ${i + 1}: X ${p.x}, Y ${p.y}`}
            onPress={() => select(i)}
          />
        ))}
      </ScrollView>
    </HudPanel>
  );
}
