import {decodeNotification,notificationText} from './notifications.ts';
import type {DroidNotification} from './notifications.ts';
/** Transport-owned events are delivered synchronously, before React can batch display updates. */
export type TelemetryPayload=
 | {type:'packet';wireLog:string}
 | {type:'sample';values:Record<string,number>;intervalMs:number;schemaEpoch:number}
 | {type:'notification';notification:DroidNotification}
 | {type:'connection';state:string;detail:string}
 | {type:'stream-status';status:string;invalid:number;intervalMs:number;schemaEpoch:number}
 | {type:'command';did:number;cid:number;data:number[];phase:'requested'|'acknowledged'|'failed';error?:string};
export type TelemetryEvent=TelemetryPayload&{id:number;at:number};
export class TelemetryEventStream {
 private nextId=0;
 private listeners=new Set<(event:TelemetryEvent)=>void>();
 private now:()=>number;
 constructor(now:()=>number=Date.now){this.now=now;}
 subscribe(listener:(event:TelemetryEvent)=>void){this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
 emit(payload:TelemetryPayload,at=this.now()){
  const event={...payload,id:++this.nextId,at,...(payload.type==='sample'?{values:{...payload.values}}:{}),...(payload.type==='command'?{data:[...payload.data]}:{})} as TelemetryEvent;
  for(const listener of this.listeners)listener(event);
  return event;
 }
}
export type RecordingSelectionMarker={type:'recording-selection';at:number;fields:string[];requestedIntervalMs:number;afterEventId?:number};
export type RecordingMarker=RecordingSelectionMarker|{type:'recording-start'|'recording-stop'|'source-cancellation-request'|'local-trace-origin';at:number;afterEventId?:number;state?:string;locator?:{x:number;y:number}};
export class TelemetryRecording {
 recording=false;
 records:Array<TelemetryEvent|RecordingMarker>=[];
 samples:Array<Extract<TelemetryEvent,{type:'sample'}>>=[];
 dropped=0;
 private lastId?:number;
 accept(event:TelemetryEvent){
  if(this.lastId!==undefined&&event.id<=this.lastId)return;
  if(this.lastId!==undefined&&event.id>this.lastId+1)this.dropped+=event.id-this.lastId-1;
  this.lastId=event.id;
  if(event.type==='sample')this.samples=[...this.samples,event].slice(-120);
  if(this.recording)this.records.push(event);
 }
 start(state:string,at=Date.now()){this.records=[{type:'recording-start',at,state,afterEventId:this.lastId}];this.dropped=0;this.recording=true;}
 stop(at=Date.now()){if(!this.recording)return;this.records.push({type:'recording-stop',at,afterEventId:this.lastId});this.recording=false;}
 markSelection(fields:string[],requestedIntervalMs:number,at=Date.now()){if(this.recording)this.records.push({type:'recording-selection',at,fields:[...fields],requestedIntervalMs,afterEventId:this.lastId});}
 markCancellation(at=Date.now()){if(this.recording)this.records.push({type:'source-cancellation-request',at,afterEventId:this.lastId});}
 markLocalOrigin(locator?:{x:number;y:number},at=Date.now()){if(this.recording)this.records.push({type:'local-trace-origin',at,afterEventId:this.lastId,...(locator?{locator:{...locator}}:{})});}
}

/** The same boundary is used by both clients for each parsed transport packet. */
export function captureTelemetryPacket(stream:TelemetryEventStream,session:{snapshot:{status?:string;invalid:number;values:Record<string,number>;intervalMs:number;schemaEpoch:number};accept:(packet:import('./protocol.ts').Packet,at:number)=>boolean;reset?:(status:string)=>void},packet:import('./protocol.ts').Packet,at=Date.now()){
 const notification=decodeNotification(packet);
 const sleep=notification?.type==='did-sleep'||notification?.type==='will-sleep';
 if(sleep)session.reset?.('stale · droid sleeping');
 const invalid=session.snapshot.invalid,sampleAccepted=session.accept(packet,at),accepted=sampleAccepted||sleep;
 const wireLog=`${new Date(at).toISOString()} · ${packet.did.toString(16)}/${packet.cid.toString(16)} seq ${packet.seq} · ${Array.from(packet.data).map(value=>value.toString(16).padStart(2,'0')).join(' ')}${notification?' · '+notificationText(notification):''}`;
 stream.emit({type:'packet',wireLog},at);
 if(notification)stream.emit({type:'notification',notification},at);
 const sensors=session.snapshot;
 if(sleep)stream.emit({type:'stream-status',status:sensors.status??'stale · droid sleeping',invalid:sensors.invalid,intervalMs:sensors.intervalMs,schemaEpoch:sensors.schemaEpoch},at);
 if(sampleAccepted&&sensors.invalid===invalid)stream.emit({type:'sample',values:sensors.values,intervalMs:sensors.intervalMs,schemaEpoch:sensors.schemaEpoch},at);
 return {wireLog,accepted};
}
