import React, {useState} from 'react';
import {View, Pressable, Platform} from 'react-native';
import {HudText} from '../theme/Theme.tsx';
import {useColors} from '../theme/useColors.ts';
/** Reference material stays available without pushing primary controls down. */
export function Details({title,children}: {title:string;children:React.ReactNode}) {
 const [open,setOpen]=useState(false), colors=useColors();
 return <View style={{gap:6}}>
  <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityState={{expanded:open}} onPress={()=>setOpen(!open)}
   style={{minHeight:Platform.OS==='web'?32:44,paddingHorizontal:8,paddingVertical:6,borderWidth:1,borderColor:colors.line,borderRadius:6,backgroundColor:colors.panelRaised}}>
   <HudText style={{fontSize:13,color:colors.primary}}>{open?'−':'+'} {title}</HudText>
  </Pressable>
  {open&&children}
 </View>;
}
