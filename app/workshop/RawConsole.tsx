import React, { useState } from "react";
import { View } from "react-native";
import {DepotButton as HudButton, DepotPanel as HudPanel, depotLayout} from "./CompactLayout.tsx";
import { HudText } from "../theme/Theme.tsx";
import { Field } from "./Controls.tsx";
import { rawConsoleCommand, sendRawConsoleCommand } from "./rawCommand.ts";
import { requiresMotionArm } from "../../core/gates.ts";
import type { Command } from "../../core/protocol.ts";
export function RawConsole({
  ready,
  execute,
}: {
  ready: boolean;
  execute: (command: Command) => Promise<unknown>;
}) {
  const [did, setDid] = useState("10"),
    [cid, setCid] = useState("00"),
    [data, setData] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [review, setReview] = useState<Command>();
  const validate = () => {
    try {
      const command = rawConsoleCommand(did, cid, data);
      setReview(command);
      setMessage(
        requiresMotionArm(command)
          ? "Validated motion command. Review and send explicitly; source ownership and motion gates remain active."
          : "Validated command. Review and send explicitly.",
      );
    } catch (error) {
      setReview(undefined);
      setMessage(String(error));
    }
  };
  return (
    <HudPanel>
      <HudText kind="heading" style={{ fontSize: 17 }}>
        Raw command console
      </HudText>
      <HudText muted>
        Hex DID, CID and payload. Commands pass the audited allowlist; service
        and unresolved operations stay blocked. Drive actuator packets use the
        bounded Advanced drive controls.
      </HudText>
      <View style={depotLayout.fields}>
        <Field compact
          label="Raw DID hex"
          value={did}
          onChange={(v) => {
            setDid(v);
            setReview(undefined);
          }}
        />
        <Field compact
          label="Raw CID hex"
          value={cid}
          onChange={(v) => {
            setCid(v);
            setReview(undefined);
          }}
        />
      <Field compact
        label="Raw payload hex bytes"
        value={data}
        onChange={(v) => {
          setData(v);
          setReview(undefined);
        }}
      />
      <HudButton label="Validate raw command" onPress={validate} />
      </View>
      {review && (
        <>
          <HudText kind="mono">
            {review.did.toString(16)}/{review.cid.toString(16)} ·{" "}
            {Array.from(review.data, (b) =>
              b.toString(16).padStart(2, "0"),
            ).join(" ") || "no payload"}
          </HudText>
          <HudButton
            label="Send validated raw command"
            caution
            disabled={!ready || busy}
            onPress={() => {
              setBusy(true);
              void sendRawConsoleCommand({ ready, execute }, did, cid, data)
                .then(
                  (value) =>
                    setMessage(`Acknowledged: ${JSON.stringify(value)}`),
                  (error) => setMessage(String(error)),
                )
                .finally(() => setBusy(false));
            }}
          />
        </>
      )}
      <HudText accessibilityLiveRegion="polite" selectable>
        {message}
      </HudText>
    </HudPanel>
  );
}
