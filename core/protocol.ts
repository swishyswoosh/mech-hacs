/** Sphero API v2 framing. BLE notifications are a stream, not packet boundaries. */
export interface Command {did:number;cid:number;data:Uint8Array}
export interface Packet extends Command {flags:number;seq:number;target?:number;source?:number;error?:number}
export function uint(value:number,max=255):number {if(!Number.isInteger(value)||value<0||value>max)throw new RangeError(`Expected integer 0..${max}`);return value;}
export function encodePacket(p:Packet):Uint8Array {
 const body=[uint(p.flags)];
 if(p.flags&0x10)body.push(uint(p.target!)); if(p.flags&0x20)body.push(uint(p.source!));
 body.push(uint(p.did),uint(p.cid),uint(p.seq));if(p.flags&1)body.push(uint(p.error??0));body.push(...p.data);
 body.push((~body.reduce((a,b)=>a+b,0))&255);
 return Uint8Array.from([0x8d,...body.flatMap(b=>b===0x8d?[0xab,0x05]:b===0xd8?[0xab,0x50]:b===0xab?[0xab,0x23]:[b]),0xd8]);
}
export class PacketDecoder {
 private body:number[]=[];private active=false;private escaped=false;
 reset(){this.body=[];this.active=false;this.escaped=false;}
 push(bytes:Uint8Array):Packet[]{
  const packets:Packet[]=[];
  for(let b of bytes){
   if(b===0x8d){this.body=[];this.active=true;this.escaped=false;continue;}
   if(!this.active)continue;
   if(b===0xd8){if(!this.escaped){const p=this.finish();if(p)packets.push(p);}this.reset();continue;}
   if(this.escaped){const value=({5:0x8d,80:0xd8,35:0xab} as Record<number,number>)[b];if(value===undefined){this.reset();continue;}b=value;this.escaped=false;}
   else if(b===0xab){this.escaped=true;continue;}
   this.body.push(b);if(this.body.length>65536)this.reset();
  }return packets;
 }
 private finish():Packet|undefined {
  const b=this.body;if(b.length<5||(b.reduce((a,v)=>a+v,0)&255)!==255)return;
  let i=0;const flags=b[i++],target=flags&16?b[i++]:undefined,source=flags&32?b[i++]:undefined;
  if(b.length<i+4+(flags&1?1:0))return;
  const did=b[i++],cid=b[i++],seq=b[i++],error=flags&1?b[i++]:undefined;
  return {flags,...(target!==undefined?{target}:{}),...(source!==undefined?{source}:{}),did,cid,seq,...(error!==undefined?{error}:{}),data:Uint8Array.from(b.slice(i,-1))};
 }
}
