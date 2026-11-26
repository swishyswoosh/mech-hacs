import React, { useState } from "react";
import { View, useWindowDimensions } from "react-native";
import { HudPanel, HudButton } from "../components/Hud.tsx";
import { HudText } from "../theme/Theme.tsx";
import { Field } from "./Fields.tsx";
import { INPUT_ACTIONS } from "./preferences.ts";
import type { InputAction } from "./preferences.ts";
export function InputMapping({
  keys,
  gamepad,
  onKey,
  onGamepad,
}: {
  keys: Record<InputAction, string>;
  gamepad: Record<InputAction, string>;
  onKey: (action: InputAction, value: string) => void;
  onGamepad: (action: InputAction, value: string) => void;
}) {
  const {width}=useWindowDimensions();
  const [open, setOpen] = useState(false);
  return (
    <HudPanel style={{ padding: 10, gap: 8 }}>
      <HudButton
        label={`${open ? "Hide" : "Edit"} input mapping`}
        style={{minHeight:34,paddingVertical:5}}
        onPress={() => setOpen(!open)}
      />
      {open && (
        <>
          <HudText muted style={{fontSize:12,lineHeight:17}}>
            Keyboard codes use KeyW, Digit1, Space, and similar names. Escape
            always stops. Gamepad axes use standard mapping; -1 leaves a button
            unassigned. B tap plays its slot; hold B for 0.5 seconds to stop.
          </HudText>
          <View style={{flexDirection:"row",flexWrap:"wrap",gap:10}}>
          {INPUT_ACTIONS.map((action) => (
            <View
              key={action}
              style={{
                flexDirection: "row",
                flexBasis:width<900?"100%":"48%",
                flexGrow:1,
                minWidth:0,
                gap:8,
                paddingVertical:2,
              }}
            >
              <View style={{flex:1,minWidth:0}}><Field compact
                id={`hud-key-${action}`}
                label={`${action} keyboard code`}
                value={keys[action]}
                autoCapitalize="none"
                autoCorrect={false}
                onChangeText={(value) => onKey(action, value)}
              /></View>
              <View style={{flex:1,minWidth:0}}><Field compact
                id={`hud-pad-${action}`}
                label={`${action} gamepad button`}
                keyboardType="numbers-and-punctuation"
                value={gamepad[action]}
                onChangeText={(value) => onGamepad(action, value)}
              /></View>
            </View>
          ))}
          </View>
        </>
      )}
    </HudPanel>
  );
}
