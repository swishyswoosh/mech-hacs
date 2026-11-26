import {uint} from './protocol.ts';
import type {Command} from './protocol.ts';
import {recoveredCommands} from './recoveredControls.ts';
const cmd=(did:number,cid:number,data:Uint8Array|number[]=[]):Command=>({did,cid,data:Uint8Array.from(data)});
const u16=(n:number)=>{uint(n,65535);return [n>>>8,n&255];};
const u32=(n:number)=>{uint(n,0xffffffff);return [n>>>24,(n>>>16)&255,(n>>>8)&255,n&255];};
const float=(n:number,min:number,max:number)=>{if(!Number.isFinite(n)||n<min||n>max)throw new RangeError(`Expected ${min}..${max}`);const bytes=new Uint8Array(4);new DataView(bytes.buffer).setFloat32(0,n,false);return bytes;};
export const commands={
 ...recoveredCommands,
 adc:()=>cmd(0x18,8),encoderCounts:()=>cmd(0x18,9),stallRecovery:()=>cmd(0x17,39),temperature:()=>cmd(0x11,14),
 collisionConfiguration:(bytes:number[])=>{if(bytes.length!==6)throw new Error('Exactly six collision configuration bytes required');return cmd(0x18,17,bytes.map((v,index)=>uint(v,index===0?3:255)));},
 legNotifications:(enabled:boolean)=>cmd(0x17,42,[+enabled]),/* Firmware reset-path gate; managed SDK name pairing remains qualified. */headResetNotifications:(enabled:boolean)=>cmd(0x17,57,[+enabled]),batteryNotifications:(enabled:boolean)=>cmd(0x13,5,[+enabled]),
 ping:(data=new Uint8Array())=>cmd(0x10,0,data),
 wake:()=>cmd(0x13,0x0d),sleep:()=>cmd(0x13,1),battery:()=>cmd(0x13,3),batteryState:()=>cmd(0x13,4),
 drive:(speed:number,heading:number,flags=0)=>cmd(0x16,7,[uint(speed),...u16(uint(heading,359)),uint(flags)]),
 tank:(magnitude0:number,magnitude1:number,flags=0)=>{if(![0,8,16,24].includes(flags))throw new RangeError('Tank flags must be 0,8,16,24');return cmd(0x16,8,[uint(magnitude0),uint(magnitude1),flags]);},
 stop:()=>cmd(0x16,7,[0,0,0,0]),resetYaw:()=>cmd(0x16,6),
 rawMotors:(leftMode:number,leftSpeed:number,rightMode:number,rightSpeed:number)=>cmd(0x16,1,[uint(leftMode,2),uint(leftSpeed),uint(rightMode,2),uint(rightSpeed)]),
 head:(degrees:number)=>cmd(0x17,15,float(degrees,-160,180)),getHead:()=>cmd(0x17,20),headTracking:(enabled:boolean)=>cmd(0x17,41,[+enabled]),
 getLegAction:()=>cmd(0x17,37),legAction:(action:number)=>cmd(0x17,13,[uint(action,3)]),leg:(position:number)=>cmd(0x17,21,float(position,0,338.70001220703125)),getLeg:()=>cmd(0x17,22),
 animation:(id:number)=>cmd(0x17,5,u16(uint(id,55))),stopAnimation:()=>cmd(0x17,43),
 idleAnimations:(enabled:boolean)=>cmd(0x17,10,[+enabled]),trophy:(enabled:boolean)=>cmd(0x17,45,[+enabled]),droidInteraction:(enabled:boolean)=>cmd(0x17,47,[+enabled]),
 volume:(value:number)=>cmd(0x1a,8,[uint(value)]),getVolume:()=>cmd(0x1a,9),audio:(sector:number,playbackMode=0)=>cmd(0x1a,7,[...u16(sector),uint(playbackMode)]),stopAudio:()=>cmd(0x1a,10),
 leds:(mask:number,values:number[])=>{uint(mask,65535);if(values.length!==mask.toString(2).replaceAll('0','').length)throw new RangeError('One brightness per LED mask bit required');return cmd(0x1a,14,[...u16(mask),...values.map(v=>uint(v))]);},
 streaming:(intervalMs:number,packetCount:number,standardMask:number)=>cmd(0x18,0,[...u16(intervalMs),uint(packetCount),...u32(standardMask)]),
 getStreaming:()=>cmd(0x18,1),getExtendedStreaming:()=>cmd(0x18,13),
 extendedStreaming:(mask:number)=>cmd(0x18,12,u32(mask)),
 identity:(cid:number)=>{if(![0,1,3,6,19,23,28,31,36].includes(cid))throw new Error('Unknown identity selector');return cmd(0x11,cid);},
};
