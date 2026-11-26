import React,{useId} from 'react';
import {Platform} from 'react-native';
/** Web hover/focus help; the button keeps its normal accessible name. */
export function Tooltip({label,children}:{label?:string;children:React.ReactElement}){
 const id=useId();
 if(Platform.OS!=='web'||!label)return children;
 return React.createElement('span',{className:'hud-tooltip'},
  React.cloneElement(children as React.ReactElement<Record<string,unknown>>,{'aria-describedby':id}),
  React.createElement('span',{id,role:'tooltip',className:'hud-tooltip-label'},label));
}
