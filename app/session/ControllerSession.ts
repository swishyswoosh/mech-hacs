import type {AppPort, SessionSnapshot, LocalSource} from './types.ts';
import type {Command, CommandAccess} from '../../core/index.ts';
import type {ManualMotionLease} from './ManualMotion.ts';
/** The shared UI contract. Direct BLE and the authoritative network service
 * implement this interface independently; screens never require a BLE owner. */
export interface SnapshotSource {
 getSnapshot():SessionSnapshot;
 subscribe(listener:()=>void):()=>void;
}
export interface ControllerSession extends AppPort {
 readonly mode?:'remote';
 readonly motionAvailable?:boolean;
 readonly store:SnapshotSource;
 readonly manualMotion:ManualMotionLease;
 authorizedDroids():Promise<Array<{id:string;name:string}>>;
 reconnectDroid(id:string,services:string[]):Promise<void>;
 executeManual(command:Command,access?:CommandAccess):Promise<unknown>;
 executeLightFrame?(command:Command, current?:()=>boolean):Promise<unknown>;
 assertManualSource(command:Command):void;
 handleWindowBlur(hidden:boolean):void;
 handleWindowFocus():Promise<void>;
 suspend():void;
 registerCancel(cancel:()=>void):()=>void;
 cancelLocalSources():void;
 requestLocalStart(source:LocalSource):Promise<void>;
 confirmSourceStart():void;
 cancelSourceStart():void;
 reportSource(source:LocalSource,label:string):void;
 replaceSources():Promise<void>;
 drive(x:number,y:number,speed?:number):void;
 setDriveSpeed(speed:number):void;
 release():Promise<void>;
 setDome(degrees:number):Promise<unknown>;
 setStance(stance:'two'|'three'|'waddle'):Promise<unknown>;
 validateWheels(epoch?:number):void;
 pulseDrive(command:Command):Promise<void>;
 pulseAdvancedDrive(command:Command):Promise<void>;
 stop(preserveConnection?:boolean):Promise<void>;
 sleep():Promise<void>;
 startSensors():Promise<void>;
 stopSensors():Promise<void>;
 ensureAttitudeTelemetry?():Promise<void>;
 observeCockpitTelemetry():()=>void;
 getServiceState():import('../../core/index.ts').ServiceState;
 isServiceBusy():boolean;
 subscribeEvents:NonNullable<AppPort['subscribeEvents']>;
}
