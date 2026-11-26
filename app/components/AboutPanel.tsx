import React from "react";
import { View } from "react-native";
import { getAppInfo } from "../platform/AppInfo";
import { HudText } from "../theme/Theme.tsx";
import { Sheet } from "./Overlays.tsx";
export function AboutPanel({onClose}: {onClose: () => void}) {
  const info = getAppInfo();
  return <Sheet title="About" onClose={onClose}>
    <View style={{gap:8}}>
      <HudText kind="heading" style={{fontSize:24}}>{info.name}</HudText>
      <HudText>Version {info.version}</HudText>
      {info.build && <HudText muted>Build {info.build}</HudText>}
      {info.system && <HudText muted>{info.system}</HudText>}
    </View>
  </Sheet>;
}
