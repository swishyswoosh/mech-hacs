import React from 'react';
import type {NativeSliderProps,NativeDriveProps} from './nativeInputTypes.ts';
export function NativeSlider(props:NativeSliderProps){return React.createElement('input',{type:'range',min:props.minimumValue,max:props.maximumValue,step:props.step||1,value:props.value,disabled:props.enabled===false,'aria-label':props.accessibilityLabel,onChange:(event:React.ChangeEvent<HTMLInputElement>)=>props.onValueChange({nativeEvent:{value:Number(event.target.value)}}),style:{width:'100%',minHeight:48}});}
export function NativeDriveControls(_props:NativeDriveProps){return null;}
