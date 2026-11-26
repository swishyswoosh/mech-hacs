import type {StyleProp,ViewStyle} from 'react-native';
export type NativeSliderProps={minimumValue:number;maximumValue:number;value:number;step?:number;enabled?:boolean;accessibilityLabel:string;style?:StyleProp<ViewStyle>;onValueChange:(event:{nativeEvent:{value:number}})=>void};
export type NativeDriveProps={cockpit?:boolean;driveEnabled:boolean;speedPercent:number;style?:StyleProp<ViewStyle>;onControlChange:(event:{nativeEvent:{kind:string;x:number;y:number;value:number}})=>void};
