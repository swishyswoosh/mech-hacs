import { useColors, useThemedStyles } from "../theme/useColors.ts";
import type { Palette } from "../theme/appearance.ts";
import { inputTheme } from "../theme/appearance.ts";
import React from "react";
import { TextInput, Platform, View, StyleSheet } from "react-native";
import type { TextInputProps } from "react-native";
import { HudText } from "../theme/Theme.tsx";
export function Field({
  id,
  label,
  compact = false,
  hideLabel = false,
  ...props
}: TextInputProps & { id: string; label: string; compact?: boolean; hideLabel?: boolean }) {
  const input = React.useRef<React.ComponentRef<typeof TextInput>>(null);
  const colors = useColors();
  const s = useThemedStyles(make_s);
  const {inputPalette, inputSurface} = inputTheme(colors);

  return (
    <View style={{ gap: compact ? 4 : 6, flexGrow: Platform.OS === "web" ? 1 : 0, minWidth: 0 }}>
      {!hideLabel && (Platform.OS === "web" ? (
        React.createElement(
          "label",
          {
            htmlFor: id,
            style: { color: colors.text, fontFamily: "Inter", fontSize: compact ? 12 : 15 },
          },
          label,
        )
      ) : (
        <HudText onPress={() => input.current?.focus()} style={compact ? {fontSize:12} : undefined}>{label}</HudText>
      ))}
      <TextInput
        ref={input}
        {...props}
        nativeID={id}
        accessibilityLabel={label}
        cursorColor={inputPalette.caret}
        selectionColor={inputPalette.selection}
        placeholderTextColor={inputPalette.placeholder}
        style={[s.input, compact && {minHeight:36,height:36,padding:6,fontSize:14}, props.style]}
      />
    </View>
  );
}
const make_s = (colors: Palette) => {
  const {inputSurface} = inputTheme(colors);
  return StyleSheet.create({
  input: {
    ...inputSurface,
    borderColor: colors.line2,
    borderWidth: 1,
    borderRadius: 4,
    minHeight: 56,
    padding: 12,
    fontSize: 16,
  },
});
};
