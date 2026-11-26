import React, {useState} from "react";
import {Platform, Pressable, StyleSheet, View} from "react-native";
import {HudButton as BaseButton, HudPanel as BasePanel} from "../components/Hud.tsx";
import {HudText} from "../theme/Theme.tsx";
import {useColors} from "../theme/useColors.ts";

export function DepotButton(props: React.ComponentProps<typeof BaseButton>) {
  return <BaseButton {...props} style={[{minHeight: Platform.OS === "web" ? 32 : 44, paddingVertical: 5, paddingHorizontal: 10}, props.style]} />;
}
export function DepotPanel(props: React.ComponentProps<typeof BasePanel>) {
  return <BasePanel {...props} style={[{padding: 10, gap: 6}, props.style]} />;
}

/** Optional evidence stays available without occupying the primary control rows. */
export function DepotDetails({title, children}: {title: string; children: React.ReactNode}) {
  const [open, setOpen] = useState(false);
  const colors = useColors();
  return <View style={{gap: open ? 6 : 0}}>
    <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityState={{expanded: open}}
      onPress={() => setOpen(!open)} style={{minHeight: Platform.OS === "web" ? 32 : 44, justifyContent: "center", paddingVertical: 5}}>
      <HudText style={{fontSize: 13, color: colors.primary}}>{open ? "▾" : "▸"} {title}</HudText>
    </Pressable>
    {open && children}
  </View>;
}

export const depotLayout = StyleSheet.create({
  row: {flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center"},
  fields: {flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "flex-end"},
  field: {flexBasis: 160, flexGrow: 1, minWidth: 120},
});
