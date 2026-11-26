import type {Command,BleTransport,CharacteristicRef} from '../index.ts';
import {toBase64,fromBase64} from './base64.ts';
import {PacketDecoder} from '../index.ts';
import {isManualDemand} from './manualDemand.ts';
export interface NativeBridge {
 manualHeartbeat():void|Promise<void>;
 discover():Promise<CharacteristicRef[]>;
 read(service:string,uuid:string):Promise<string>;
 write(service:string,uuid:string,value:string,response:boolean,pulseOwner:string,driveOwner:string):Promise<void>;
 subscribe(service:string,uuid:string):Promise<void>;
 priorityWrite(service:string,uuid:string,value:string):Promise<void>;
 emergencyWrite(service:string,uuid:string,value:string):Promise<void>;
 disconnect():Promise<void>;
}
export interface NotificationEvents {
 addListener(name:'R2BleNotification',callback:(event:{service:string;uuid:string;value:string})=>void):{remove():void};
}
/** Retains the actual service mapping; never selects a characteristic by UUID alone. */
export class AndroidTransportCore implements BleTransport {
 private refs:CharacteristicRef[]=[];
 private outbound=new PacketDecoder();
 private pulseHooks?:{beforeWrite(command:Command,ref:CharacteristicRef):Promise<string|undefined>};
 setPulseHooks(hooks:{beforeWrite(command:Command,ref:CharacteristicRef):Promise<string|undefined>}){this.pulseHooks=hooks;}
 private sourceHooks?:{beforeWrite(command:Command):Promise<void>;stopAll():void};
 setSourceHooks(hooks:{beforeWrite(command:Command):Promise<void>;stopAll():void}){this.sourceHooks=hooks;}
 private driveSource="";
 setDriveSource(id:string){this.driveSource=id;}
 clearDriveSource(id?:string){if(id===undefined||this.driveSource===id)this.driveSource="";}
 private native:NativeBridge;
 private events:NotificationEvents;
 constructor(native:NativeBridge,events:NotificationEvents){this.native=native;this.events=events;}
 async discover():Promise<CharacteristicRef[]> {this.outbound.reset();this.refs=await this.native.discover();return this.refs;}
 reference(uuid:string):CharacteristicRef {const ref=this.refs.find(r=>r.characteristic.toLowerCase()===uuid.toLowerCase());if(!ref)throw new Error(`Characteristic not discovered: ${uuid}`);return ref;}
 async read(ref:CharacteristicRef){return fromBase64(await this.native.read(ref.service,ref.characteristic));}
 async write(ref:CharacteristicRef,bytes:Uint8Array,response:boolean){
  // Capture ownership before asynchronous hooks: old frames must never borrow a new lease.
  const owner=this.driveSource;let driveOwner="",pulseOwner="";
  for(const packet of this.outbound.push(bytes)){
   await this.sourceHooks?.beforeWrite(packet);
   pulseOwner=await this.pulseHooks?.beforeWrite(packet,ref)??"";
   if(isManualDemand(packet)){
    driveOwner=pulseOwner?"":owner;
    if(!driveOwner)await this.native.manualHeartbeat();
   }
  }
  await this.native.write(ref.service,ref.characteristic,toBase64(bytes),response,pulseOwner,driveOwner);
 }
 async subscribe(ref:CharacteristicRef,callback:(data:Uint8Array)=>void){
  const subscription=this.events.addListener('R2BleNotification',({service,uuid,value})=>{
   if(service.toLowerCase()===ref.service.toLowerCase()&&uuid.toLowerCase()===ref.characteristic.toLowerCase())callback(fromBase64(value));
  });
  try{await this.native.subscribe(ref.service,ref.characteristic);}catch(error){subscription.remove();throw error;}
  return()=>subscription.remove();
 }
 async priorityWrite(ref:CharacteristicRef,frames:Uint8Array[]){await this.native.priorityWrite(ref.service,ref.characteristic,toBase64(Uint8Array.from(frames.flatMap(frame=>Array.from(frame)))));}
 async emergencyWrite(ref:CharacteristicRef,frames:Uint8Array[]){await this.native.emergencyWrite(ref.service,ref.characteristic,toBase64(Uint8Array.from(frames.flatMap(frame=>Array.from(frame)))));}
 async disconnect(){this.clearDriveSource();this.sourceHooks?.stopAll();this.outbound.reset();this.refs=[];await this.native.disconnect();}
}
