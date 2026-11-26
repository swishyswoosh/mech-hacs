import type {Packet} from './protocol.ts';
import {decodeRecoveredNotification,recoveredNotificationText} from './recoveredControls.ts';
import type {RecoveredNotification} from './recoveredControls.ts';
/** API-v2 event mappings. Unknown IDs remain raw packets. */
export type DroidNotification=
 | RecoveredNotification
 | {type:'battery-state';value:number;label:string}
 | {type:'leg-complete';action:number;label:string}
 | {type:'will-sleep'}
 | {type:'did-sleep'};
const battery=['Charged','Charging','Not charging','OK','Low','Critical','Reserved','Unused'];
const leg=['Unknown','Three legs','Two legs','Waddle','Transitioning'];
export function decodeNotification(packet:Packet):DroidNotification|undefined{
 // Matching normal command replies must never be misidentified as physical events.
 if((packet.flags&1)||packet.error)return;
 const d=packet.data;
 if(packet.did===0x13&&packet.cid===6&&d.length===1)return{type:'battery-state',value:d[0],label:battery[d[0]]??`Unknown (${d[0]})`};
 if(packet.did===0x17&&packet.cid===0x26&&d.length===1)return{type:'leg-complete',action:d[0],label:leg[d[0]]??`Unknown (${d[0]})`};
 if(packet.did===0x13&&packet.cid===0x19&&d.length===0)return{type:'will-sleep'};
 if(packet.did===0x13&&packet.cid===0x1a&&d.length===0)return{type:'did-sleep'};
 return decodeRecoveredNotification(packet);
}
export function notificationText(event:DroidNotification):string{
 switch(event.type){case'battery-state':return`Battery: ${event.label}`;case'leg-complete':return`Leg action complete: ${event.label}`;case'will-sleep':return'Droid will sleep';case'did-sleep':return'Droid did sleep';default:return recoveredNotificationText(event);}
}
