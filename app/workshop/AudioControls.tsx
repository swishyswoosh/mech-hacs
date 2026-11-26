import React, { useState } from "react";
import {View} from "react-native";
import {DepotButton as HudButton, DepotPanel as HudPanel, depotLayout} from "./CompactLayout.tsx";
import { HudText } from "../theme/Theme.tsx";
import { NativeSlider } from "../platform/NativeInputs";
import { Field } from "./Controls.tsx";
import {
  volumeDraftCommand,
  soundSectorDraftCommand,
} from "./audioCommands.ts";
import type { Command } from "../../core/protocol.ts";
export function AudioControls({
  ready,
  execute,
  onMessage,
}: {
  ready: boolean;
  execute: (command: Command) => Promise<unknown>;
  onMessage: (message: string) => void;
}) {
  const [volume, setVolume] = useState("128"),
    [sector, setSector] = useState("1609"),
    [busy, setBusy] = useState(false);
  const apply = async (build: () => Command) => {
    setBusy(true);
    try {
      await execute(build());
    } catch (error) {
      onMessage(String(error));
    } finally {
      setBusy(false);
    }
  };
  const sliderValue = Number.isFinite(Number(volume))
    ? Math.max(0, Math.min(255, Number(volume)))
    : 0;
  return (
    <HudPanel>
      <HudText kind="heading" style={{ fontSize: 17 }}>
        Audio controls
      </HudText>
      <HudText>Volume · {Math.round((sliderValue / 255) * 100)}%</HudText>
      <NativeSlider
        minimumValue={0}
        maximumValue={255}
        step={1}
        value={sliderValue}
        accessibilityLabel="Volume slider"
        onValueChange={(event) => setVolume(String(event.nativeEvent.value))}
      />
      <View style={depotLayout.fields}>
      <Field compact label="Volume byte (0–255)" value={volume} onChange={setVolume} />
      <HudButton
        label="Apply volume"
        disabled={!ready || busy}
        onPress={() => {
          void apply(() => volumeDraftCommand(volume));
        }}
      />
      </View>
      <HudText muted style={{fontSize:12}}>
        Adjust the draft with the slider or exact byte, then Apply. Use Read
        audio volume below for a timestamped readback.
      </HudText>
      <View style={depotLayout.fields}>
      <Field compact
        label="Sound starting sector"
        value={sector}
        onChange={setSector}
      />
      <HudButton
        label="Play sound sector"
        disabled={!ready || busy}
        onPress={() => {
          void apply(() => soundSectorDraftCommand(sector));
        }}
      />
      </View>
      <HudText muted>
        Advanced droid-stored audio entry · 0–65535 · vetted playback mode 0.
      </HudText>
    </HudPanel>
  );
}
