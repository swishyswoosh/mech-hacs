import type {
  BleTransport,
  Command,
  CommandAccess,
  Packet,
  R2Controller,
  SensorConsumerRequest,
  SensorSchema,
  ServiceRead,
  ServiceReading,
  ServiceState,
} from "../../core/index.ts";
import type { SensorSnapshot } from "../../core/sensorSession.ts";
import type { TelemetryEvent } from "../../core/telemetryEvents.ts";
import type {BatteryProfilingStorage,BatteryProfilingSummary,BatteryEstimate} from './BatteryProfiling.ts';
export type AppSnapshot = {
  stopFailure?: string;
  preferencesRevision?: number;
  state: string;
  detail: string;
  packets: string[];
  connectionEpoch?: number;
  battery?: string;
  batteryProfiling?:BatteryProfilingSummary;
  batteryEstimate?:BatteryEstimate;
  batteryStateReading?:{value:number;at:number};
  sensors?: SensorSnapshot;
  serviceState?: ServiceState;
  serviceBusy?: boolean;
  sensorPlan?: SensorSchema | null;
  sensorPlanPending?: boolean;
  unsupportedStopModes?: string[];
  cockpitReadings?: Record<string,{value:number;at:number}>;
  cockpitTelemetryStatus?: string;
  cockpitTelemetryBusy?: boolean;
};
export interface ExperienceHandle {
  label: string;
  start(): Promise<void>;
  cancel(): void;
}
export interface AppPort {
  selectBatteryProfilingDevice?(key:string):void;
  armBatteryProfiling?():Promise<void>;
  startBatteryProfileFull?():Promise<void>;
  stopBatteryProfiling?():Promise<void>;
  finishBatteryProfileShutdown?():Promise<void>;
  useBatteryProfile?(id:string):Promise<void>;
  useReportedBatteryState?():Promise<void>;
  exportBatteryProfiling?():Promise<{name:string;text:string;bytes:number}>;
  runDeviceLightRecipe?(recipe:import("../../core/ramRecipe.ts").NordicInlineLedRecipe):Promise<void>;
  stopDeviceLightRecipe?():Promise<void>;
  readPlayMode?(): Promise<number>;
  registerExperience?(id: string, handle: ExperienceHandle): () => void;
  startExperience?(id: string): Promise<void>;
  pulseDrive?(command: Command): Promise<void>;
  pulseAdvancedDrive?(command: Command): Promise<void>;
  setSensorConsumer?(
    id: "visible" | "recording" | "automation",
    request: SensorConsumerRequest | null,
  ): Promise<void>;
  isServiceBusy?(): boolean;
  getServiceState?(): ServiceState;
  beginServiceSession?(): Promise<{ challenge: number; response: number }>;
  enterServiceSession?(): Promise<void>;
  readService?(kind: ServiceRead, index?: number): Promise<ServiceReading>;
  endServiceSession?(): Promise<void>;
  acquireSourceLease?(sourceId: string, drive?: boolean): Promise<void>;
  renewSourceLease?(sourceId: string): void;
  releaseSourceLease?(sourceId: string): void;
  importLocalJsonFiles?(): Promise<Array<{ name: string; text: string }>>;
  exportLocalJson?(name: string, text: string): Promise<void>;
  importLocalJson?(): Promise<string>;
  hashLocalText?(text: string): Promise<{ sha256: string; bytes: number }>;
  startSensors?(): Promise<void>;
  stopSensors?(): Promise<void>;
  armMotion(): void;
  connect(services: string[]): Promise<void>;
  disconnect(): Promise<void>;
  authorizedDroids?(): Promise<Array<{ id: string; name: string }>>;
  reconnectDroid?(id: string, services: string[]): Promise<void>;
  execute(command: Command, access?: CommandAccess): Promise<unknown>;
  replaceSources?(): Promise<void>;
  stop(): Promise<void>;
  releaseDrive(): Promise<void>;
  subscribe(listener: (snapshot: AppSnapshot) => void): () => void;
  subscribeEvents?(listener: (event: TelemetryEvent) => void): () => void;
  loadPreference(key: string): string | null;
  savePreference(key: string, value: string): void | Promise<void>;
}

export interface PreferenceStore {
  load(key: string): string | null;
  save(key: string, value: string): void | Promise<void>;
}
export interface ConnectionOwnership {
  acquire(): Promise<void>;
  release(): void;
}
export interface TransportRequest {
  services: string[];
  authorizedId?: string;
  onDisconnect: () => void;
  check: () => void;
  selection: (open: boolean) => void;
}
export interface TransportConnection {
  transport: BleTransport;
  id?: string;
  name?: string;
  hardwareId?:string;
}
export interface TransportFactory {
  open(request: TransportRequest): Promise<TransportConnection>;
  validateServices?(services: string[]): string[];
  authorizedDroids?(): Promise<Array<{ id: string; name: string }>>;
  cancel?(): void;
  restart?(connection: TransportConnection, check: () => void): Promise<void>;
}
export interface CompatibilityReport {
  warnings: string[];
  battery?: string;
  detail?: string;
}
export interface SessionHooks {
  configureDeviceRamStop?():Promise<void>;
  ownership?: ConnectionOwnership;
  attach?(controller: R2Controller): void;
  prepare?(
    controller: R2Controller,
    check: () => void,
  ): Promise<CompatibilityReport>;
  beforeResume?(controller: R2Controller): Promise<void>;
  state?(state: string): void;
  packet?(packet: Packet): void;
  assertReady?(): void;
  beforeArm?(): void;
  arm?(): void;
  beforeExecute?(command: Command, access: CommandAccess): Promise<void>;
  execute?(command: Command, send: () => Promise<Packet>): Promise<Packet>;
  cancelSources?(): void;
  beforeReplace?(): Promise<void>;
  releaseDrive?(send: () => Promise<void>): Promise<void>;
  pulse?(command: Command, advanced: boolean): Promise<void>;
  disconnectOnStop?: boolean;
  acquireSourceLease?(id: string, drive?: boolean): Promise<void>;
  renewSourceLease?(id: string): void;
  releaseSourceLease?(id: string): void;
  importLocalJson?(): Promise<string>;
  importLocalJsonFiles?(): Promise<Array<{ name: string; text: string }>>;
  exportLocalJson?(name: string, text: string): Promise<void>;
  hashLocalText?(text: string): Promise<{ sha256: string; bytes: number }>;
}
export interface SessionOptions {
  attitudeTelemetry?: boolean;
  factory: TransportFactory;
  preferences: PreferenceStore;
  batteryProfilingStorage?:BatteryProfilingStorage;
  hooks?: SessionHooks;
  disconnectStopTimeoutMs?: number;
  initialDetail?: string;
}
export type SafetyState =
  | "disconnected"
  | "connecting"
  | "ready-disarmed"
  | "armed"
  | "busy"
  | "paused"
  | "stopping"
  | "failed";
export interface ConnectionSnapshot {
  state: string;
  droidName?: string;
  droidId?: string;
  battery?: string;
  epoch: number;
}
export interface SafetySnapshot {
  state: SafetyState;
  motionArmed: boolean;
  wheelsValidated: boolean;
  canControl: boolean;
}
export type LocalSource = "automation" | "experience";
export interface ActivitySnapshot {
  source: "manual" | LocalSource | null;
  label: string;
  sources: Record<LocalSource, string>;
  pendingStart?: string;
}
export interface TelemetrySnapshot {
  sensors?: SensorSnapshot;
  observedDomeAngle?: number;
  packets: string[];
}
export interface SessionSnapshot extends AppSnapshot {
  connection: ConnectionSnapshot;
  safety: SafetySnapshot;
  activity: ActivitySnapshot;
  telemetry: TelemetrySnapshot;
}
