import { commands } from './commands.ts';
import { decodeSensors, streamFields } from './sensors.ts';
import type { Packet, Command } from './protocol.ts';
import type { SensorSchema } from './sensorSchema.ts';
export const ALL_STANDARD = streamFields.filter(field => field.set === 'standard').reduce((mask, field) => (mask | 2 ** field.bit) >>> 0, 0);
export const ALL_EXTENDED = streamFields.filter(field => field.set === 'extended').reduce((mask, field) => (mask | 2 ** field.bit) >>> 0, 0);
export interface SensorSnapshot {
  status: string;
  sampleAt?: number;
  values: Record<string, number>;
  invalid: number;
  intervalMs: number;
  schemaEpoch: number;
  standardMask?: number;
  extendedMask?: number;
  fieldNames?: string[];
  requestedIntervalMs?: number;
  adapted?: boolean;
}
export class SensorSession {
  snapshot: SensorSnapshot = {
    status: 'not streaming',
    values: {},
    invalid: 0,
    intervalMs: 50,
    schemaEpoch: 0
  };
  private active = false;
  private masks = {
    standardMask: ALL_STANDARD,
    extendedMask: ALL_EXTENDED
  };
  reset(status = 'stale · disconnected') {
    this.active = false;
    this.snapshot = {
      ...this.snapshot,
      status
    };
  }
  enable(schema?: SensorSchema) {
    this.masks = {
      standardMask: schema?.standardMask ?? ALL_STANDARD,
      extendedMask: schema?.extendedMask ?? ALL_EXTENDED
    };
    this.active = true;
    this.snapshot = {
      status: 'streaming · awaiting sample',
      values: {},
      invalid: 0,
      intervalMs: schema?.intervalMs ?? 50,
      schemaEpoch: this.snapshot.schemaEpoch + 1,
      ...this.masks,
      ...(schema ? {
        fieldNames: [...schema.fieldNames],
        requestedIntervalMs: schema.requestedIntervalMs,
        adapted: schema.adapted
      } : {})
    };
  }
  /** Rate changes with the same verified masks retain samples and decoder epoch. */
  setIntervalMs(intervalMs: number) {
    this.snapshot = {
      ...this.snapshot,
      intervalMs,
      requestedIntervalMs: intervalMs,
      adapted: false
    };
  }
  accept(packet: Packet, now = Date.now()): boolean {
    if (!this.active || packet.did !== 0x18 || packet.cid !== 2 || packet.flags & 1) return false;
    try {
      const values = decodeSensors(packet.data, this.masks.standardMask, this.masks.extendedMask);
      if (Object.values(values).some(value => !Number.isFinite(value))) throw new Error('Non-finite sensor sample');
      this.snapshot = {
        ...this.snapshot,
        status: 'streaming',
        sampleAt: now,
        values
      };
    } catch {
      this.snapshot = {
        ...this.snapshot,
        invalid: this.snapshot.invalid + 1
      };
    }
    return true;
  }
}

/** Installation requires a stopped prior stream and a replaced transport session.
 * 18/01 and 18/0d response layouts: command-gap-st65.json, handlers fec0/ff24. */
export async function installSensorSchema(execute: (command: Command) => Promise<Packet>): Promise<void> {
  await execute(commands.extendedStreaming(ALL_EXTENDED));
  const extended = await execute(commands.getExtendedStreaming());
  if (extended.data.length !== 4 || new DataView(extended.data.buffer, extended.data.byteOffset, 4).getUint32(0, false) !== ALL_EXTENDED) throw new Error('Extended stream-mask readback mismatch.');
  await execute(commands.streaming(50, 0, ALL_STANDARD));
  const standard = await execute(commands.getStreaming());
  if (standard.data.length !== 7 || new DataView(standard.data.buffer, standard.data.byteOffset, 7).getUint16(0, false) !== 50 || standard.data[2] !== 0 || new DataView(standard.data.buffer, standard.data.byteOffset, 7).getUint32(3, false) !== ALL_STANDARD) throw new Error('Standard stream-mask readback mismatch.');
}

/** Streaming freshness follows the applied interval, never a pending request. */
export function sensorFreshnessMs(intervalMs: number) {
  return Math.max(500, 3 * intervalMs);
}
