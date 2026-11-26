import { useColors, useThemedStyles } from "../theme/useColors.ts";
import type { Palette } from "../theme/appearance.ts";
import { inputTheme } from "../theme/appearance.ts";
import React, { useId } from "react";
import { TextInput, Platform, StyleSheet, View, Pressable } from "react-native";
import { HudText } from "../theme/Theme.tsx";
export function Field({
  label,
  value,
  onChange,
  multiline = false,
  compact = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
  compact?: boolean;
}) {
  const colors = useColors();
  const s = useThemedStyles(make_s);
  const {inputPalette, inputSurface} = inputTheme(colors);

  const id = useId();
  return (
    <View style={[s.field,compact&&{gap:4,minWidth:0}]}>
      {Platform.OS === "web" ? (
        React.createElement(
          "label",
          { htmlFor: id, style: { color: colors.text, fontSize: compact?12:14 } },
          label,
        )
      ) : (
        <HudText style={compact?{fontSize:12}:undefined}>{label}</HudText>
      )}
      <TextInput
        nativeID={id}
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        multiline={multiline}
        cursorColor={inputPalette.caret}
        selectionColor={inputPalette.selection}
        placeholderTextColor={inputPalette.placeholder}
        style={[
          s.input,
          compact && {minHeight:32,height:32,padding:6,fontSize:14},
          multiline && { minHeight: compact ? 72 : 140, height: compact ? 72 : undefined, textAlignVertical: "top" },
        ]}
      />
    </View>
  );
}
const make_s = (colors: Palette) => {
  const {inputSurface} = inputTheme(colors);
  return StyleSheet.create({
  field: { gap: 6, minWidth: 100, flexGrow: 1 },
  input: {
    ...inputSurface,
    minHeight: 56,
    borderWidth: 1,
    borderColor: colors.line2,
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
  },
});
};

/** Compact workshop actions retain their full accessible names. */
export function CompactButton({label,text=label,onPress,disabled=false,primary=false,fullWidth=false}:{label:string;text?:string;onPress:()=>void;disabled?:boolean;primary?:boolean;fullWidth?:boolean}){
  const colors = useColors();

 return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{disabled}} disabled={disabled} onPress={onPress}
  style={({pressed})=>({minHeight:Platform.OS === "web" ? 32 : 44,paddingVertical:5,paddingHorizontal:8,borderWidth:1,borderColor:primary?colors.primary:colors.line2,borderRadius:6,backgroundColor:primary?colors.primary:colors.panel,opacity:disabled?0.45:pressed?0.7:1,justifyContent:"center",flexBasis:fullWidth?undefined:"47%",flexGrow:fullWidth?0:1})}>
  <HudText numberOfLines={1} style={{fontSize:12,color:primary?colors.onPrimary:colors.primary}}>{text}</HudText>
 </Pressable>;
}
