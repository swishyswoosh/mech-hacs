import type { Command, Packet } from "../../core/index.ts";
import { commands, DroidResponseError } from "../../core/index.ts";
export function batteryResponse(data: Uint8Array): string {
  return data.length
    ? `Battery voltage response: ${Array.from(data)
        .map((v) => v.toString(16).padStart(2, "0"))
        .join(" ")} (raw; no percentage)`
    : "Battery voltage response empty; unavailable";
}
export async function compatibilityProbes(
  probe: (command: Command) => Promise<Packet>,
  check: () => void,
) {
  const warnings: string[] = [];
  let battery: string | undefined;
  for (const command of [
    commands.identity(0),
    commands.identity(3),
    commands.battery(),
    commands.batteryState(),
  ]) {
    check();
    try {
      const response = await probe(command);
      check();
      if (command.did === 0x13 && command.cid === 3)
        battery = batteryResponse(response.data);
    } catch (error) {
      check();
      if (
        error instanceof DroidResponseError &&
        [1, 2, 3].includes(error.packet.error ?? 0)
      ) {
        warnings.push(
          `Optional ${command.did.toString(16)}/${command.cid.toString(16)} unsupported (${error.packet.error})`,
        );
        continue;
      }
      throw error;
    }
  }
  return { warnings, battery };
}
