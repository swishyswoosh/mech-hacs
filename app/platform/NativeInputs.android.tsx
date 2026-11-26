import React from 'react';
import {requireNativeComponent} from 'react-native';
import type {NativeSliderProps,NativeDriveProps} from './nativeInputTypes.ts';
import {useColors} from '../theme/useColors.ts';
type NativeColors = {accentColor:string;mutedColor:string;surfaceColor:string;textColor:string};
const Slider=requireNativeComponent<NativeSliderProps & NativeColors>('R2Slider');
type StickColors = {stickHighlightColor:string;stickShadowColor:string;stickRingColor:string};
const Drive=requireNativeComponent<NativeDriveProps & NativeColors & StickColors>('R2DriveControls');
function useNativeColors(): NativeColors {
 const colors=useColors();
 return {accentColor:colors.primary,mutedColor:colors.line2,surfaceColor:colors.panel,textColor:colors.text};
}
export function NativeSlider(props:NativeSliderProps){return <Slider {...props} {...useNativeColors()}/>;}
export function NativeDriveControls(props:NativeDriveProps){
 const colors=useColors();
 return <Drive {...props} {...useNativeColors()} stickHighlightColor={colors.stickHi} stickShadowColor={colors.stickLow} stickRingColor={colors.primaryHi}/>;
}
