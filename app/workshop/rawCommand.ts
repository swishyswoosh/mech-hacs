import { validateCommand } from "../../core/gates.ts";
import type { Command } from "../../core/protocol.ts";
function byte(text: string) {
  if (!/^(?:0x)?[\da-f]{1,2}$/i.test(text))
    throw new Error("Use one hex byte (00–ff) per value.");
  return parseInt(text.replace(/^0x/i, ""), 16);
}
/** Raw entry never grants service-session access or bypasses validated command encoders. */
export function rawConsoleCommand(
  did: string,
  cid: string,
  payload: string,
): Command {
  const data = payload.trim()
    ? payload
        .trim()
        .split(/[\s,]+/)
        .map(byte)
    : [];
  const command = {
    did: byte(did.trim()),
    cid: byte(cid.trim()),
    data: Uint8Array.from(data),
  };
  validateCommand(command);
  if (command.did === 0x16 && [0x01, 0x07, 0x08].includes(command.cid)) {
    throw new Error(
      "Use the bounded pulses in Advanced drive for drive actuator commands.",
    );
  }
  return command;
}

export const buildRawCommand = rawConsoleCommand;
/** The screen calls this handler before any manual arming/execution callback. */
export async function sendRawConsoleCommand(
  access: { ready: boolean; execute: (command: Command) => Promise<unknown> },
  did: string,
  cid: string,
  payload: string,
) {
  if (!access.ready)
    throw new Error("Resume the ready droid before sending commands.");
  const command = rawConsoleCommand(did, cid, payload);
  return access.execute(command);
}
