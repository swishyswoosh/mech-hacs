import { stopCurrentActivity } from "./stopCurrentActivity.ts";
import React, {useEffect} from "react";
import {View, Platform} from "react-native";
import {DomePopup} from "../components/DomePopup.tsx";
import {PopupSensors} from "../components/PopupSensors.tsx";
import type { ControllerSession } from "../session/ControllerSession.ts";
import type { SessionSnapshot } from "../session/types.ts";
import { HudText } from "../theme/Theme.tsx";
import { HudButton } from "../components/Hud.tsx";
import { Sheet } from "../components/Overlays.tsx";
export type HubSheetKind =
  "notes" | "dome" | "stance" | "safety" | "conflict" | null;
export function HubSheet({
  sheet,
  setSheet,
  onStop,
  notes,
  onClearNotes,
  notify,
  snapshot,
  canControl,
  action,
  session,
  stance,
}: {
  sheet: HubSheetKind;
  setSheet: (value: HubSheetKind) => void;
  onStop: () => void;
  notes: string[];
  onClearNotes: () => void;
  notify: (message: string) => void;
  snapshot: SessionSnapshot;
  canControl: boolean;
  action: (work: () => Promise<unknown>) => Promise<void>;
  session: ControllerSession;
  stance?: "two" | "three" | "waddle";
}) {
  useEffect(() => {
    if (sheet === "dome" || sheet === "stance") return session.observeCockpitTelemetry?.();
  }, [sheet, session]);
  return (
    <>
      {sheet && (
        <Sheet
          title={
            sheet === "dome"
              ? "Dome controls"
              : sheet === "stance"
                ? "Stance"
                : sheet === "safety"
                  ? "About safety"
                  : sheet === "conflict"
                    ? "Controls busy"
                    : "Comlink notes"
          }
          onClose={() => setSheet(null)}
          onStop={onStop}
          controls={sheet === "dome" || sheet === "stance"}
          compact={(sheet === "dome" || sheet === "stance") && Platform.OS === "android"}
        >
          {sheet === "conflict" && (
            <>
              <HudText>
                A running activity owns these controls. Stop it before choosing
                a fresh action?
              </HudText>
              <HudButton
                label="Stop current activity"
                onPress={() =>
                  void action(async () => {
                    await stopCurrentActivity(session);
                    setSheet(null);
                  })
                }
              />
              <HudButton
                label="Keep current activity"
                onPress={() => setSheet(null)}
              />
            </>
          )}
          {sheet === "notes" &&
            (notes.length ? (
              <>
                <HudButton label="Clear messages" onPress={onClearNotes} />
                {notes.map((note, i) => (
                  <HudText key={i} style={{ lineHeight: 24 }}>
                    {note}
                  </HudText>
                ))}
              </>
            ) : (
              <HudText muted>No messages.</HudText>
            ))}
          {sheet === "dome" && <DomePopup session={session} snapshot={snapshot}
            enabled={canControl && !snapshot.cockpitTelemetryBusy} notify={notify}/>}
          {sheet === "stance" && (
            <View style={{flex:1, minHeight:0, justifyContent:"space-between", gap:12}}>
              <View style={{flex:1, flexDirection:"row", alignItems:"center", gap:8}}>
              {(["two", "three", "waddle"] as const).map((value) => (
                <HudButton
                  key={value}
                  label={
                    value === "two"
                      ? "Two legs"
                      : value === "three"
                        ? "Three legs"
                        : "Waddle"
                  }
                  style={{flex:1, minWidth:0, paddingHorizontal:8}}
                  disabled={!canControl}
                  primary={stance === value}
                  selected={stance === value}
                  onPress={() => void action(() => session.setStance(value))}
                />
              ))}
              </View>
              <PopupSensors kind="stance" snapshot={snapshot}/>
            </View>
          )}
          {sheet === "safety" && (
            <>
              <HudText style={{ lineHeight: 24 }}>
                Use STOP to end the current activity and disable driving. If
                wheel stopping fails, wheel drive stays disabled. Dome, stance,
                sounds and lights remain available while connected.
              </HudText>
              <HudText style={{ lineHeight: 24 }}>
                Switching apps or browser tabs stops the current activity without
                disconnecting the droid; returning to Mech does not restart it.
              </HudText>
              <HudText style={{ lineHeight: 24 }}>
                Keep the droid in view with clear space around it, because an
                unresponsive browser page can delay stopping.
              </HudText>
              <HudText style={{ lineHeight: 24 }}>
                Wheel calibration is optional and can correct reversed driving
                directions.
              </HudText>
            </>
          )}
        </Sheet>
      )}
    </>
  );
}
