import type {Command,Packet} from './protocol.ts';

// Nordic 7.0.101 has a NULL 12/27 handler. Its original zero-argument shell
// handler reads the same mode manager without invoking a mode transition.
const query=Uint8Array.from([112,108,97,121,109,111,100,101,0]);
export const playModeShellQuery=():Command=>({did:0x10,cid:0x02,data:query.slice()});
export const isPlayModeShellQuery=(c:Command):boolean=>c.did===0x10&&c.cid===0x02&&c.data.length===query.length&&c.data.every((byte,index)=>byte===query[index]);
export type PlayModeShellReading={type:'play-mode';mode:number;source:'nordic-shell'};
export interface PlayModeShellIO {
 /** Must return the controller's sequence-correlated successful command reply. */
 command(command:Command):Promise<Packet>;
 /** Subscribe to the existing decoded API stream, without changing BLE notifications. */
 subscribe(listener:(packet:Packet)=>void):()=>void;
}

export class PlayModeShellReader {
 private busy=false;
 private uncertain=false;
 private cancelActive?:()=>void;
 /** Call only when the transport session is replaced, never to retry a timeout. */
 reset():void{this.cancelActive?.();this.uncertain=false;}
 read(io:PlayModeShellIO,options:{timeoutMs?:number;signal?:AbortSignal}={}):Promise<PlayModeShellReading>{
  if(this.busy)return Promise.reject(new Error('Play-mode read already in progress'));
  if(this.uncertain)return Promise.reject(new Error('Play-mode read requires a new connection after an incomplete shell response'));
  if(options.signal?.aborted)return Promise.reject(new Error('Play-mode read cancelled'));
  const timeoutMs=options.timeoutMs??3000;
  if(!Number.isFinite(timeoutMs)||timeoutMs<=0)return Promise.reject(new Error('Invalid play-mode read timeout'));
  this.busy=true;
  return new Promise((resolve,reject)=>{
   let done=false,sent=false,acknowledged=false,reading:PlayModeShellReading|undefined;
   let unsubscribe=()=>{};
   const finish=(error?:Error)=>{
    if(done)return;done=true;clearTimeout(timer);unsubscribe();options.signal?.removeEventListener('abort',abort);
    this.busy=false;this.cancelActive=undefined;if(error&&sent)this.uncertain=true;
    if(error)reject(error);else resolve(reading!);
   };
   const abort=()=>finish(new Error('Play-mode read cancelled'));
   const timer=setTimeout(()=>finish(new Error('Play-mode read timed out')),timeoutMs);
   this.cancelActive=abort;options.signal?.addEventListener('abort',abort,{once:true});
   try{unsubscribe=io.subscribe(packet=>{
    if(done||!sent||(packet.flags&1)||packet.error||packet.did!==0x10||packet.cid!==0x03||packet.seq!==255)return;
    const text=Array.from(packet.data,byte=>String.fromCharCode(byte)).join('');
    if(!text.startsWith('Current play mode ID:'))return;
    const match=/^Current play mode ID: (0|[1-9][0-9]?)\n\0$/.exec(text);
    if(!match||Number(match[1])>40){finish(new Error('Malformed play-mode shell response'));return;}
    if(reading){finish(new Error('Malformed duplicate play-mode shell response'));return;}
    reading={type:'play-mode',mode:Number(match[1]),source:'nordic-shell'};
    if(acknowledged)finish();
   });}catch(error){finish(error instanceof Error?error:new Error(String(error)));return;}
   Promise.resolve().then(()=>{
    if(done)return;sent=true;return io.command(playModeShellQuery());
   }).then(packet=>{
    if(done)return;
    if(!packet||(packet.flags&1)===0||packet.did!==0x10||packet.cid!==0x02||packet.error!==0||packet.data.length!==0){finish(new Error('Play-mode shell acknowledgement failed'));return;}
    acknowledged=true;if(reading)finish();
   },error=>finish(error instanceof Error?error:new Error(String(error))));
  });
 }
}
