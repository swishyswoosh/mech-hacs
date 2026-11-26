import React from 'react';
import {View} from 'react-native';
import Svg,{Line,Polyline,Text as SvgText} from 'react-native-svg';
import type {BatteryCycle} from '../../core/batteryProfile.ts';
import {HudText} from '../theme/Theme.tsx';
import {useColors} from '../theme/useColors.ts';
export function BatteryVoltageGraph({cycle}:{cycle:BatteryCycle}) {
 const colors=useColors(),samples=cycle.samples;
 if(samples.length<2)return <HudText muted>Voltage chart appears after two readings.</HudText>;
 const low=Math.min(...samples.map(s=>s.volts))-.02,high=Math.max(...samples.map(s=>s.volts))+.02,duration=Math.max(60000,samples.at(-1)!.at-cycle.startedAt);
 const x=(at:number)=>50+460*(at-cycle.startedAt)/duration,y=(v:number)=>150-120*(v-low)/(high-low),stride=Math.max(1,Math.ceil(samples.length/240));
 const visible=samples.filter((_,i)=>i%stride===0||i===samples.length-1);
 return <View accessibilityLabel="Battery voltage over elapsed minutes" style={{width:'100%'}}><Svg width="100%" height={185} viewBox="0 0 540 185">
  <Line x1={50} y1={20} x2={50} y2={150} stroke={colors.textMuted}/><Line x1={50} y1={150} x2={515} y2={150} stroke={colors.textMuted}/>
  <SvgText x={46} y={30} textAnchor="end" fontSize={12} fill={colors.textMuted}>{high.toFixed(2)} V</SvgText><SvgText x={46} y={150} textAnchor="end" fontSize={12} fill={colors.textMuted}>{low.toFixed(2)} V</SvgText>
  <SvgText x={50} y={174} fontSize={12} fill={colors.textMuted}>0 min</SvgText><SvgText x={510} y={174} textAnchor="end" fontSize={12} fill={colors.textMuted}>{(duration/60000).toFixed(0)} min</SvgText>
  <Polyline points={visible.map(s=>`${x(s.at)},${y(s.volts)}`).join(' ')} fill="none" stroke={colors.primary} strokeWidth={2}/>
 </Svg><HudText muted>Voltage during this cycle. Calibration uses only readings taken while controller activity is quiet.</HudText></View>;
}
