import React, { useState } from "react";
import {View} from "react-native";
import type { ControllerSession } from "../session/ControllerSession.ts";
import { HudPanel, HudButton } from "../components/Hud.tsx";
import { HudText } from "../theme/Theme.tsx";
export function ConnectionSettings({
  session,
  notify,
  onConnect,
}: {
  session: ControllerSession;
  notify: (text: string) => void;
  onConnect: () => void;
}) {
  const snapshot = session.store.getSnapshot();
  const [sleeping, setSleeping] = useState(false);
  const waitingForSleep = sleeping || snapshot.state === "sleep-requested";
  const disconnect = async () => {
    if (waitingForSleep || !snapshot.safety.canControl) return;
    setSleeping(true);
    try { await session.sleep(); }
    catch (error) { notify(`Disconnect incomplete: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setSleeping(false); }
  };
  return (
    <HudPanel style={{padding:8,gap:6,flexDirection:"row",flexWrap:"wrap",alignItems:"center"}}>
      <View style={{flex:1,minWidth:220,gap:3}}>
      <View style={{flexDirection:"row",flexWrap:"wrap",alignItems:"center",gap:8}}>
      <HudText kind="heading" style={{fontSize:20}}>Comlink</HudText>
      <HudText>{snapshot.connection.droidName || "No droid connected"}</HudText>
      </View>
      <HudText muted style={{fontSize:12}}>{snapshot.detail}</HudText>
      </View>
      {["disconnected", "sleeping", "awaiting-restart"].includes(
        snapshot.state,
      ) ? (
        <HudButton style={{minHeight:34,paddingVertical:5}} label="Find or reconnect a droid" onPress={onConnect} />
      ) : (
        <HudButton style={{minHeight:34,paddingVertical:5,paddingHorizontal:10}}
          label={waitingForSleep ? "Sleeping…" : "Disconnect droid"}
          icon="power"
          disabled={waitingForSleep || !snapshot.safety.canControl}
          onPress={() => void disconnect()}
        />
      )}
    </HudPanel>
  );
}
