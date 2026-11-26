import {useAppActive} from "../platform/useAppActive.ts";
import { useColors } from "../theme/useColors.ts";
import {observedDomeDegrees,formatDomeDegrees} from '../cockpit/domeReading.ts';
import React,{useContext,useEffect,useState,useRef} from 'react';
import {View,Platform,useWindowDimensions} from 'react-native';
import {AttitudeContext} from './AttitudeNote.tsx';
import {cockpitSensorRows,CockpitDisplayWindow,cockpitDisplaySnapshot} from './cockpitSensors.ts';
import {HudText,HudTheme} from '../theme/Theme.tsx';
// Fixed slots keep signs and digit counts from moving neighboring readouts.
const sensorWidths:Record<string,number>={ACCEL:192,GYRO:192,WHEELS:136,DOME:136,SHOULDER:136,BATTERY:100,CPU:100};
const compactValue=(value:string)=>value.replace(/ · /g,' ').replace(/ raw$/,'').replace('Left ','L ').replace('Right ','R ').replace(' ADC stance ',' ADC/').replace(/(\d+)\.00\b/g,'$1');
export function CockpitSensors(){
 const active=useAppActive();
  const colors = useColors();

 const {height}=useWindowDimensions();
 const low=Platform.OS === "android" && height<600;
 const live=useContext(AttitudeContext),{largeLabels}=useContext(HudTheme);
 const scale=low?0.78:largeLabels?1.2:1;
 const window=useRef(new CockpitDisplayWindow());
 const [{snapshot,now},setDisplay]=useState(()=>({snapshot:live,now:Date.now()}));
 useEffect(()=>{window.current.add(live);},[live]);
 useEffect(()=>{if(!active)return;const timer=setInterval(()=>{const now=Date.now();setDisplay({snapshot:window.current.read(now),now});},1000);return()=>clearInterval(timer);},[active]);
 const display=cockpitDisplaySnapshot(live,snapshot);
 const rows=cockpitSensorRows(display,now).map(row=>row.label==='DOME'?{...row,value:formatDomeDegrees(observedDomeDegrees(live))}:row);if(!rows.length)return null;
 const renderReading=(row:typeof rows[number],health=false)=><View key={row.label} accessibilityLabel={`${row.label}: ${row.value}`} accessibilityHint={row.hint} style={{width:sensorWidths[row.label]*scale,flexGrow:0,flexShrink:0,flexDirection:health?'row':'column',alignItems:health?'center':'flex-start',justifyContent:health?'space-between':'flex-start',gap:health?4:0}}>
  <HudText kind="mono" muted numberOfLines={1} style={{fontSize:10,lineHeight:18*scale,flexShrink:0}}>{row.label}</HudText>
  <HudText kind="mono" numberOfLines={1} style={{fontSize:low?10:12,lineHeight:18*scale,fontVariant:['tabular-nums'],flexShrink:1}}>{compactValue(row.value)}</HudText>
 </View>;
 if(low){
  const reading=(label:string)=>rows.find(row=>row.label===label)!;
  const compactReading=(label:string)=><View key={label} accessibilityLabel={`${label}: ${reading(label).value}`} accessibilityHint={reading(label).hint} style={{flexDirection:'row',alignItems:'center',gap:5,minWidth:0,height:18}}>
   <HudText kind="mono" muted style={{fontSize:9,lineHeight:14}}>{label}</HudText>
   <HudText kind="mono" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8} style={{fontSize:10,lineHeight:14,flexShrink:1,fontVariant:['tabular-nums']}}>{compactValue(reading(label).value)}</HudText>
  </View>;
  // Android briefly reports the launcher's portrait dimensions during resume.
  // These layouts have different native child trees: remount only the readout
  // view when crossing the breakpoint instead of reusing flattened columns.
  return <View key="compact-sensors" accessibilityLabel="Cockpit sensor readings" style={{width:'100%',height:44,borderTopWidth:1,borderColor:colors.line,paddingTop:5,flexDirection:'row',gap:10}}>
   <View style={{flex:2.4,minWidth:0}}>{compactReading('ACCEL')}{compactReading('GYRO')}</View>
   <View style={{flex:1.8,minWidth:0}}>{compactReading('WHEELS')}{compactReading('DOME')}</View>
   <View style={{flex:1.5,minWidth:0}}>{compactReading('SHOULDER')}{display?.cockpitTelemetryStatus&&<HudText muted numberOfLines={1} style={{fontSize:9,lineHeight:18}}>{display.cockpitTelemetryStatus}</HudText>}</View>
   <View accessibilityLabel="Battery and CPU temperature" style={{flex:0.9,minWidth:0,alignItems:'flex-end'}}>{compactReading('BATTERY')}{compactReading('CPU')}</View>
  </View>;
 }
 return <View key="full-sensors" accessibilityLabel="Cockpit sensor readings" style={{width:'100%',maxWidth:1100,borderTopWidth:1,borderColor:colors.line,marginTop:low?2:6,paddingTop:low?3:8,flexDirection:'row',alignItems:'flex-start',flexWrap:'wrap',gap:12}}>
  <View style={{flexGrow:1,flexShrink:1,flexBasis:816*scale,minWidth:0,flexDirection:'row',flexWrap:'wrap',alignItems:'center',justifyContent:'space-between',gap:6,minHeight:36*scale}}>
   {rows.filter(row=>row.label!=='BATTERY'&&row.label!=='CPU').map(row=>renderReading(row))}
   {display?.cockpitTelemetryStatus&&<HudText muted numberOfLines={1} style={{fontSize:low?10:12,lineHeight:18*scale}}>{display.cockpitTelemetryStatus}</HudText>}
  </View>
  <View accessibilityLabel="Battery and CPU temperature" style={{alignItems:'flex-end',flexShrink:0,marginLeft:'auto'}}>
   {rows.filter(row=>row.label==='BATTERY'||row.label==='CPU').map(row=>renderReading(row,true))}
  </View>
 </View>;
}
