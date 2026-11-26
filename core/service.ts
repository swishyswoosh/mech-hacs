import {uint} from './protocol.ts';
import type {Command,Packet} from './protocol.ts';
export type ServiceState='locked'|'readable'|'unlocked';
export type ServiceRead='indexed-tuple'|'test-results'|'connector-id'|'motor-id';
const bytes32=(value:number)=>{uint(value,0xffffffff);return Uint8Array.of(value>>>24,value>>>16,value>>>8,value);};
/** Retained st-cfg-disassembly.txt 0800f210..0800f234; validator call 08007e50..08007e56.
 * Nonzero challenge modulo0xAE529, multiply0x556, add0x24D69; BEu32 on wire.
 * This is a local factory gate, not an account/security credential. */
export function factoryResponse(challenge:number):number{uint(challenge,0xffffffff);if(challenge===0)throw new Error('Zero factory challenge is invalid');return ((challenge%0xae529)*0x556+0x24d69)>>>0;}
export const serviceCommands={
 challenge:():Command=>({did:31,cid:19,data:new Uint8Array()}),
 enter:(challenge:number):Command=>({did:31,cid:20,data:bytes32(factoryResponse(challenge))}),
 exit:():Command=>({did:31,cid:21,data:new Uint8Array()}),
 read:(kind:ServiceRead,index=0):Command=>{const cid={'indexed-tuple':18,'test-results':32,'connector-id':33,'motor-id':35}[kind];if(cid===undefined)throw new Error('Unknown service read');uint(index,1);return{did:31,cid,data:kind==='indexed-tuple'?Uint8Array.of(0,index):new Uint8Array()};},
};
export function responseView(packet:Packet,did:number,cid:number,length:number){if(packet.did!==did||packet.cid!==cid||!(packet.flags&1)||packet.error||packet.data.length!==length)throw new Error('Unexpected response identity, status or payload length');return new DataView(packet.data.buffer,packet.data.byteOffset,packet.data.byteLength);}
export type ServiceReading={kind:'indexed-tuple';index:number;field16:number;field32:number}|{kind:'test-results';results:number;station:number}|{kind:'connector-id'|'motor-id';value:number};
export function decodeServiceReading(kind:ServiceRead,packet:Packet,index=0):ServiceReading{
 const command=serviceCommands.read(kind,index),view=responseView(packet,31,command.cid,kind==='indexed-tuple'?6:kind==='test-results'?3:2);
 if(kind==='indexed-tuple')return{kind,index,field16:view.getUint16(0,false),field32:view.getUint32(2,false)};
 if(kind==='test-results')return{kind,results:view.getUint16(0,false),station:view.getUint8(2)};
 return{kind,value:view.getUint16(0,false)};
}
export type SensorReading={kind:'adc';shoulder:number;head:number}|{kind:'encoders';counter0:number;counter1:number}|{kind:'stall';held:boolean;raw:number}|{kind:'temperature';celsius:number};
export function decodeSensorReading(kind:SensorReading['kind'],packet:Packet):SensorReading{
 const [did,cid,length]=({adc:[24,8,4],encoders:[24,9,4],stall:[23,39,1],temperature:[17,14,4]} as const)[kind];const v=responseView(packet,did,cid,length);
 switch(kind){case'adc':return{kind,shoulder:v.getUint16(0,false),head:v.getUint16(2,false)};case'encoders':return{kind,counter0:v.getInt16(0,false),counter1:v.getInt16(2,false)};case'stall':return{kind,held:v.getUint8(0)!==0,raw:v.getUint8(0)};case'temperature':return{kind,celsius:v.getInt32(0,false)};}
}

/** Read-only normal queries may coexist with service inspection; normal writes may not. */
export function serviceCompatibleQuery(c:Command):boolean{
 const key=[c.did,c.cid].map(v=>v.toString(16).padStart(2,'0')).join('/');
 if(['1f/12','1f/20','1f/21','1f/23'].includes(key))return true;
 return c.data.length===0&&['11/00','11/01','11/03','11/06','11/0e','11/13','11/17','11/1c','11/1f','11/24','12/27','13/03','13/04','17/14','17/16','17/27','17/2e','17/30','18/01','18/0d','18/08','18/09','1a/09'].includes(key);
}
