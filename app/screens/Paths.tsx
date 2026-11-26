import { useColors } from "../theme/useColors.ts";
import { HudPage } from "../components/HudPage.tsx";
import React, { useState } from "react";
import { View, ScrollView, Pressable, useWindowDimensions, Platform } from "react-native";
import { HudButton } from "../components/Hud.tsx";
import { HudText } from "../theme/Theme.tsx";
import { useDroidPath } from "../workshop/useDroidPath.ts";
import { PathRunControls } from "../workshop/PathRunControls.tsx";
import { usePathEditor } from "../workshop/usePathEditor.ts";
import { PathCanvas } from "../workshop/PathCanvas.tsx";
import { WaypointInspector } from "../workshop/WaypointInspector.tsx";
import { PathSettings } from "../workshop/PathSettings.tsx";
import { PathTransfer } from "../workshop/PathTransfer.tsx";
import type { AppPort, AppSnapshot } from "../session/types.ts";
export type PathsProps = {
  port: AppPort;
  snapshot: AppSnapshot;
  ready?: boolean;
  onMessage: (message: string) => void;
  stopToken?: number;
  onOpenExperiences?: () => void;
  registerCancel?: (cancel:()=>void)=>()=>void;
  beforeStart?: ()=>Promise<void>;
  onRunning?: (name:string)=>void;
};
export function Paths(props: PathsProps) {
  const colors = useColors();

  const { width,height } = useWindowDimensions();
  const compact=Platform.OS==="android"&&width>height&&height<600;
  const live = useDroidPath(props);
  const editor = usePathEditor(props, () => void live.stop());
  const [details, setDetails] = useState<"waypoints" | "route" | null>(null);
  const wide = width >= 600 || width > height;
  const detailButtons = (
    <View style={{flexDirection:"row",gap:6}}>
      {([['waypoints','Waypoint inspector'],['route','Route details']] as const).map(([id,label])=>(
        <Pressable key={id} accessibilityRole="button" accessibilityLabel={label}
          accessibilityState={{expanded:details===id}} aria-expanded={details===id}
          onPress={()=>setDetails(details===id?null:id)}
          style={{flex:1,minHeight:compact?28:36,padding:compact?4:8,borderWidth:1,borderColor:colors.line2,borderRadius:6,backgroundColor:details===id?colors.panelRaised:colors.panel,flexDirection:"row",alignItems:"center",justifyContent:"space-between",gap:4}}>
          <HudText style={{fontSize:12,color:colors.primary}}>{label}</HudText>
          <HudText muted style={{fontSize:12}}>{details===id?'−':'+'}</HudText>
        </Pressable>
      ))}
    </View>
  );
  const detailContent = details==='waypoints' ? <WaypointInspector editor={editor}/> : details==='route' ? <View style={{gap:8}}>{compact&&<HudText muted style={{fontSize:11,lineHeight:15}}>Three-leg driving. 0° is the droid’s forward direction at Start. Drawing units describe the shape; floor distance varies with speed and surface.</HudText>}<PathSettings editor={editor}/><PathTransfer editor={editor}/></View> : null;
  // The desktop workbench never scrolls; only an opened detail section does.
  // Narrow screens retain natural scrolling instead of clipping drawing controls.
  if (!wide) return <HudPage contentContainerStyle={{padding:8,gap:8,paddingBottom:8}}>
    <PathCanvas editor={editor}/>
    <PathRunControls editor={editor} live={live} ready={!!props.ready} compact={compact}/>
    {detailButtons}
    {detailContent}
  </HudPage>;
  return <View style={{flex:1,minHeight:0,padding:8,gap:8}}>
    <View style={{flex:1,minHeight:0,flexDirection:"row",gap:8,alignItems:"stretch"}}>
      <View style={{flex:1,minWidth:0,minHeight:0}}><PathCanvas editor={editor} fit compact={compact}/></View>
      <View style={{width:compact?Math.min(270,width*.36):340,minHeight:0,gap:compact?4:8}}>
        <PathRunControls editor={editor} live={live} ready={!!props.ready} compact={compact}/>
        {detailButtons}
        {details&&<ScrollView accessibilityLabel={`${details==='waypoints'?'Waypoint inspector':'Route details'} content`}
          style={{flex:1,minHeight:0}} contentContainerStyle={{paddingBottom:8}} keyboardShouldPersistTaps="handled">
          {detailContent}
        </ScrollView>}
      </View>
    </View>
  </View>;
}
