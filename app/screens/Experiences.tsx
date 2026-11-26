import { useColors } from "../theme/useColors.ts";
import { HudPage } from "../components/HudPage.tsx";
import React, { useState } from "react";
import { StyleSheet, View } from "react-native";
import { HudButton, HudPanel } from "../components/Hud.tsx";
import { HudText } from "../theme/Theme.tsx";
import { DeviceRamPanel } from "../workshop/DeviceRamPanel.tsx";
import { AutomationPanels } from "../workshop/AutomationPanels.tsx";
import type { AppPort, AppSnapshot } from "../session/types.ts";
import type { AutomationOwnerPanel } from "../session/runningSources.ts";
export type ExperiencesProps = {
  port: AppPort;
  snapshot: AppSnapshot;
  ready?: boolean;
  stopToken: number;
  onRunning: (label: string, owner?: AutomationOwnerPanel) => void;
  onMessage: (message: string) => void;
  registerCancel?: (cancel: () => void) => () => void;
  beforeStart?: (owner?: AutomationOwnerPanel) => Promise<void>;
  registerBack?: (handler: () => boolean) => () => void;
};
export function Experiences({
  port,
  snapshot,
  ready = snapshot.state === "ready",
  stopToken,
  onRunning,
  onMessage,
  registerCancel,
  beforeStart,
  registerBack,
}: ExperiencesProps) {
  const colors = useColors();

  const [section, setSection] = useState<
    "patrol" | "recipes" | null
  >(null);
  const currentSnapshot = ready
    ? snapshot
    : { ...snapshot, state: "disconnected" as const };
  const cards = [
    {
      key: "patrol" as const,
      title: "Patrol",
      description:
        "Supervised, finite patrol with a choice of animation, duration and repeats.",
      experimental: true,
    },
    {
      key: "recipes" as const,
      title: "Protocols",
      description:
        "Build timed actions, event waits, and parallel cues. Review, save, import, and export your own protocols.",
      experimental: false,
    },
  ];
  React.useEffect(
    () =>
      registerBack?.(() => {
        if (section === null) return false;
        setSection(null);
        return true;
      }),
    [registerBack, section],
  );
  return (
    <HudPage contentContainerStyle={{padding:12,paddingBottom:12,gap:10}}>
      {section === null ? (
        <>
          <View style={s.cards}>
            {cards.map((card) => (
              <HudPanel key={card.key} style={s.card}>
                <HudText kind="heading" style={{ fontSize: 19 }}>
                  {card.title}
                </HudText>
                {card.experimental && (
                  <HudText kind="mono" style={{ color: colors.caution, fontSize:10 }}>
                    EXPERIMENTAL
                  </HudText>
                )}
                <HudText muted style={{fontSize:13,lineHeight:18}}>{card.description}</HudText>
                <HudButton
                  style={{minHeight:34,paddingVertical:5}}
                  label={`Open ${card.title.toLowerCase()}`}
                  onPress={() => setSection(card.key)}
                />
              </HudPanel>
            ))}
          </View>

        </>
      ) : (
        <>
        {section === "recipes" && <DeviceRamPanel port={port} ready={ready}/>}
        <AutomationPanels
          kind={section === "recipes" ? "sequences" : "patrol"}
          port={port}
          snapshot={currentSnapshot}
          stopToken={stopToken}
          onRunning={onRunning}
          onMessage={onMessage}
          registerCancel={registerCancel}
          beforeStart={beforeStart}
        />
        </>
      )}

    </HudPage>
  );
}
const s = StyleSheet.create({
  row: {
    flexDirection: "row",
    gap: 12,
    flexWrap: "wrap",
    alignItems: "center",
  },
  cards: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  card: { flexBasis: "46%", minWidth:260, flexGrow: 1, gap: 6, padding:12 },
});
