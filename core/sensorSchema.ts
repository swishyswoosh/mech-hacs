import { commands } from './commands.ts';
import type { Command, Packet } from './protocol.ts';
import { streamFields, selectedFields } from './sensors.ts';
import type { SensorSession } from './sensorSession.ts';
export interface SensorConsumerRequest {
  fields: string[];
  intervalMs: number;
}
export interface SensorSchema {
  standardMask: number;
  extendedMask: number;
  fieldNames: string[];
  requestedIntervalMs: number;
  intervalMs: number;
  estimatedBytesPerSecond: number;
  adapted: boolean;
}
export interface SensorSchemaPort {
  stopStream(): Promise<void>;
  /** Stops motion and replaces GATT, returning a monotonically fresh transport identity. */
  reconnectStopped(): Promise<number | string>;
  execute(command: Command): Promise<Packet>;
  onFailure?(): Promise<void>;
  check?(): void;
}
const known = new Map(streamFields.map(field => [field.name, field]));
/** Policy budget, not a measured radio guarantee: 6000/s leaves >5500/s of the
 * 115200-baud8N1 ceiling for control/query traffic. BLE may require less. */
export const DEFAULT_SENSOR_BUDGET = 6000;
function budgetValue(value: number) {
  if (!Number.isFinite(value) || value < 1 || value > DEFAULT_SENSOR_BUDGET) throw new Error('Sensor bandwidth budget must be 1..6000 bytes/sec (control reserve retained)');
  return value;
}
export function sensorSchemaFor(requests: Iterable<SensorConsumerRequest>, budget = DEFAULT_SENSOR_BUDGET): SensorSchema | null {
  budgetValue(budget);
  const names = new Set<string>();
  let requested = Infinity;
  for (const request of requests) {
    if (!Number.isFinite(request.intervalMs) || request.intervalMs <= 0) throw new Error('Sensor interval must be positive');
    if (!Array.isArray(request.fields)) throw new Error('Sensor fields must be an array');
    for (const name of request.fields) {
      if (!known.has(name)) throw new Error(`Unknown sensor field: ${name}`);
      names.add(name);
    }
    if (request.fields.length) requested = Math.min(requested, request.intervalMs);
  }
  if (!names.size) return null;
  let standardMask = 0,
    extendedMask = 0;
  for (const name of names) {
    const field = known.get(name)!;
    if (field.set === 'standard')
      standardMask = (standardMask | 2 ** field.bit) >>> 0;
    else
      extendedMask = (extendedMask | 2 ** field.bit) >>> 0;
  }
  // Maximum escaping for flags+optional route addresses+checksum and all floats,
  // frame delimiters, then 3-byte ATT overhead per 20-byte transport chunk.
  const encoded = 2 * (4 * names.size + 7) + 2,
    frameBytes = encoded + 3 * Math.ceil(encoded / 20);
  const intervalMs = Math.max(Math.min(65535, Math.max(2, Math.ceil(requested))), Math.ceil(frameBytes * 1000 / budget));
  if (intervalMs > 65535) throw new Error('Sensor request exceeds the sustainable interval or bandwidth range');
  return {
    standardMask,
    extendedMask,
    fieldNames: selectedFields(standardMask, extendedMask).map(f => f.name),
    requestedIntervalMs: requested,
    intervalMs,
    estimatedBytesPerSecond: frameBytes * 1000 / intervalMs,
    adapted: intervalMs !== requested
  };
}
function checkReply(packet: Packet, cid: number, length: number) {
  if (packet.did !== 24 || packet.cid !== cid || !(packet.flags & 1) || packet.error || packet.data.length !== length) throw new Error('Sensor schema readback identity/status/length mismatch');
  return new DataView(packet.data.buffer, packet.data.byteOffset, packet.data.byteLength);
}
/** R2 firmware clears the standard mask when interval is zero. The active
 * readback must still exactly match before any samples can be decoded.
 * Decode stays disabled until both masks and the restarted interval are ACKed/read back. */
export async function installPlannedSensorSchema(execute: (command: Command) => Promise<Packet>, schema: SensorSchema): Promise<void> {
  await execute(commands.extendedStreaming(schema.extendedMask));
  const ext = checkReply(await execute(commands.getExtendedStreaming()), 13, 4);
  if (ext.getUint32(0, false) !== schema.extendedMask) throw new Error('Extended stream-mask readback mismatch');
  await execute(commands.streaming(0, 0, schema.standardMask));
  const disabled = checkReply(await execute(commands.getStreaming()), 1, 7);
  if (disabled.getUint16(0, false) !== 0 || disabled.getUint8(2) !== 0 || ![0, schema.standardMask].includes(disabled.getUint32(3, false))) throw new Error(`Stopped stream readback: interval ${disabled.getUint16(0, false)}, count ${disabled.getUint8(2)}, mask ${disabled.getUint32(3, false)}; expected interval 0, count 0, mask ${schema.standardMask}`);
  await execute(commands.streaming(schema.intervalMs, 0, schema.standardMask));
  const active = checkReply(await execute(commands.getStreaming()), 1, 7);
  if (active.getUint16(0, false) !== schema.intervalMs || active.getUint8(2) !== 0 || active.getUint32(3, false) !== schema.standardMask) throw new Error('Active standard stream-mask readback mismatch');
}
/** Requests update desired state only. Reconcile is an explicit stopped reconnect
 * operation, since Web Bluetooth may require a foreground device chooser. */
export class SensorSchemaManager {
  private consumers = new Map<string, SensorConsumerRequest>();
  private budget = DEFAULT_SENSOR_BUDGET;
  private generation = 0;
  private applying = false;
  private epoch?: number | string;
  private current: SensorSchema | null = null;
  private desiredRevision = 0;
  readonly session: SensorSession;
  constructor(session: SensorSession) {
    this.session = session;
  }
  get revision() {
    return this.desiredRevision;
  }
  get plan() {
    return sensorSchemaFor(this.consumers.values(), this.budget);
  }
  get installed() {
    return this.current ? {
      ...this.current,
      fieldNames: [...this.current.fieldNames]
    } : null;
  }
  get pending() {
    return JSON.stringify(this.plan) !== JSON.stringify(this.current);
  }
  request(id: string, request: SensorConsumerRequest) {
    if (!id.trim()) throw new Error('Sensor consumer ID is required');
    const next = new Map(this.consumers);
    next.set(id, {
      fields: [...request.fields],
      intervalMs: request.intervalMs
    });
    sensorSchemaFor(next.values(), this.budget);
    this.consumers = next;
    this.changed();
  }
  release(id: string) {
    if (this.consumers.delete(id)) this.changed();
  }
  setBandwidthBudget(value: number) {
    budgetValue(value);
    sensorSchemaFor(this.consumers.values(), value);
    this.budget = value;
    this.changed();
  }
  /** Measured control/query pressure can reduce the available sensor budget; no auto-restart. */
  reportAvailableBandwidth(value: number) {
    this.setBandwidthBudget(Math.min(this.budget, value));
  }
  private changed() {
    this.desiredRevision++;
    if (this.applying) this.session.reset('stale · schema changed during setup');
  }
  cancel(status = 'stale · sensor subscription cancelled') {
    this.generation++;
    this.current = null;
    this.session.reset(status);
  }
  async reconcile(port: SensorSchemaPort): Promise<SensorSchema | null> {
    if (this.applying) throw new Error('Sensor schema installation already in progress');
    const schema = this.plan,
      revision = this.desiredRevision,
      generation = ++this.generation;
    this.applying = true;
    this.current = null;
    this.session.reset('stale · installing requested schema');
    const check = () => {
      port.check?.();
      if (generation !== this.generation || revision !== this.desiredRevision) throw new Error('Sensor schema changed or installation cancelled');
    };
    const execute = async (command: Command) => {
      check();
      const reply = await port.execute(command);
      check();
      return reply;
    };
    try {
      check();
      await port.stopStream();
      check();
      if (!schema) {
        this.session.reset('stopped · no sensor consumers');
        return null;
      }
      const epoch = await port.reconnectStopped();
      check();
      if ((typeof epoch === 'number' ? !Number.isSafeInteger(epoch) || epoch < 0 : typeof epoch !== 'string' || !epoch.length) || epoch === this.epoch) throw new Error('Fresh sensor transport epoch required');
      this.epoch = epoch;
      await installPlannedSensorSchema(execute, schema);
      check();
      this.current = schema;
      this.session.enable(schema);
      return this.installed;
    } catch (error) {
      this.current = null;
      this.session.reset('stale · schema setup failed or cancelled');
      await port.onFailure?.().catch(() => {});
      throw error;
    } finally {
      this.applying = false;
    }
  }
}
