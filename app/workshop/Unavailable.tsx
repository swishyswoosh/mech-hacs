import { useColors } from "../theme/useColors.ts";
import React from "react";
import { HudPanel } from "../components/Hud.tsx";
import { HudText } from "../theme/Theme.tsx";
export const unavailableFeatures = [
  [
    "UNAVAILABLE: Firmware installation and deep sleep",
    "Firmware installation remains unvalidated. Deep sleep uses the same guarded leg retraction as normal sleep and has not been physically tested.",
  ],

] as const;
export function Unavailable() {
  const colors = useColors();

  return (
    <>
      {unavailableFeatures.map(([name, reason]) => (
        <HudPanel key={name} style={{padding:10,gap:5}}>
          <HudText
            kind="heading"
            style={{ fontSize: 16, color: colors.caution }}
          >
            {name}
          </HudText>
          <HudText muted style={{fontSize:13,lineHeight:18}}>{reason}</HudText>
        </HudPanel>
      ))}
    </>
  );
}
