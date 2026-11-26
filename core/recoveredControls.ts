import type {Command,Packet} from './protocol.ts';

/** Firmware command encoders and strict reply/notification decoders. */
const command=(did:number,cid:number,data:number[]=[]):Command=>({did,cid,data:Uint8Array.from(data)});
const booleanByte=(enabled:boolean):number=>{if(typeof enabled!=='boolean')throw new TypeError('Expected boolean');return enabled?1:0;};
export const recoveredCommands={
 startIdleLedAnimation:()=>command(0x1a,0x19),
 getPlayMode:()=>command(0x12,0x27),
 getTrophyMode:()=>command(0x17,0x2e),
 getDroidInteractionMode:()=>command(0x17,0x30),
 // Notification registration requires a Boolean byte followed by zero padding.
 enablePlayModeNotifications:(enabled=true)=>command(0x12,0x02,[booleanByte(enabled),0]),
 gyroMaxNotifications:(enabled:boolean)=>command(0x18,0x0f,[booleanByte(enabled)]),
 accelerometerActivityNotifications:(enabled:boolean)=>command(0x18,0x19,[booleanByte(enabled)]),
 gyroActivityNotifications:(enabled:boolean)=>command(0x18,0x1c,[booleanByte(enabled)]),
};

/** Integrate at the existing command gate; unknown commands remain subject to its policy. */
export function validateRecoveredCommand(c:Command):boolean{
 if(c.did===0x12&&c.cid===0x02){
  if(c.data.length!==2)throw new Error('Command payload length mismatch');
  if(c.data[0]>1||c.data[1]!==0)throw new Error('Invalid play-mode notification boolean/padding');
  return true;
 }
 const empty=(c.did===0x1a&&c.cid===0x19)||(c.did===0x12&&c.cid===0x27)||(c.did===0x17&&[0x2e,0x30].includes(c.cid));
 const boolean=c.did===0x18&&[0x0f,0x19,0x1c].includes(c.cid);
 if(!empty&&!boolean)return false;
 if(c.data.length!==(boolean?1:0))throw new Error('Command payload length mismatch');
 if(boolean&&c.data[0]>1)throw new Error('Invalid boolean');
 return true;
}

export type RecoveredReadback=
 | {type:'play-mode';mode:number}
 | {type:'trophy-mode'|'droid-interaction-mode';enabled:boolean;raw:number};
/** The caller supplies a sequence-correlated reply; status and payload shape are checked here. */
export function decodeRecoveredReadback(p:Packet):RecoveredReadback|undefined{
 if(!(p.flags&1)||p.error!==0)return;
 if(p.did===0x12&&p.cid===0x27&&p.data.length===2)return{type:'play-mode',mode:(p.data[0]<<8)|p.data[1]};
 if(p.did===0x17&&[0x2e,0x30].includes(p.cid)&&p.data.length===1){
  // Any nonzero byte means enabled; preserve the raw value.
  return{type:p.cid===0x2e?'trophy-mode':'droid-interaction-mode',enabled:p.data[0]!==0,raw:p.data[0]};
 }
}

export type RecoveredNotification=
 | {type:'play-mode-changed';mode:number}
 | {type:'gyro-max';flags:number;axes:string[];unknownFlags:number}
 | {type:'accelerometer-activity'}
 | {type:'gyro-activity'};
const gyroAxes=['+X','-X','+Y','-Y','+Z','-Z'];
/** Event IDs come from constructor registration, not neighboring command IDs. */
export function decodeRecoveredNotification(p:Packet):RecoveredNotification|undefined{
 if((p.flags&1)||p.error)return;
 if(p.did===0x12&&p.cid===0x28&&p.data.length===2)return{type:'play-mode-changed',mode:(p.data[0]<<8)|p.data[1]};
 if(p.did!==0x18)return;
 if(p.cid===0x10&&p.data.length===1){const flags=p.data[0];return{type:'gyro-max',flags,axes:gyroAxes.filter((_,index)=>flags&(1<<index)),unknownFlags:flags&0xc0};}
 if(p.cid===0x1a&&p.data.length===0)return{type:'accelerometer-activity'};
 if(p.cid===0x1d&&p.data.length===0)return{type:'gyro-activity'};
}
export function recoveredNotificationText(event:RecoveredNotification):string{
 switch(event.type){
  case'play-mode-changed':return`Play mode changed: ${event.mode}`;
  case'gyro-max':return`Gyroscope limit: ${event.axes.join(', ')||'no known axes'} · flags 0x${event.flags.toString(16).padStart(2,'0')}`;
  case'accelerometer-activity':return'Accelerometer activity detected';
  case'gyro-activity':return'Gyroscope activity detected';
 }
}
