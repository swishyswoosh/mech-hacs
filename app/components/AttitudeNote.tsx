import {useAppActive} from "../platform/useAppActive.ts";
import React, {createContext,useContext,useEffect,useState} from 'react';
import type {AppSnapshot} from '../session/types.ts';
import {HudText} from '../theme/Theme.tsx';
import {attitudeNote} from './attitudeNote.ts';
export const AttitudeContext=createContext<AppSnapshot|undefined>(undefined);
/** Passive subscriber only: rendering a card never opens or replaces Bluetooth. */
export function AttitudeNote(){
 const active=useAppActive();
 const snapshot=useContext(AttitudeContext);
 const [now,setNow]=useState(Date.now);
 useEffect(()=>{if(!active)return;const timer=setInterval(()=>setNow(Date.now()),250);return()=>clearInterval(timer);},[active]);
 const text=attitudeNote(snapshot?.sensors,['ready','paused'].includes(snapshot?.state??''),Math.max(now,Date.now()));
 return text?<HudText nativeID="attitude-note" kind="mono" muted style={{fontSize:10,lineHeight:14,textAlign:'center',marginTop:8}}>{text}</HudText>:null;
}
