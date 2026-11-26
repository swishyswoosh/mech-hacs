import {commands,ResourceConflictError} from './index.ts';
import type {Command} from './index.ts';
export function integerValue(value:string,min:number,max:number){const n=Number(value);if(!value.trim()||!Number.isInteger(n)||n<min||n>max)throw new Error(`Enter an integer from ${min} to ${max}.`);return n;}
export function selectedLightCommand(values:string[],selected:boolean[]){if(values.length!==8||selected.length!==8)throw new Error('Eight LED channels required.');const mask=selected.reduce((sum,on,i)=>sum+(on?2**i:0),0);if(!mask)throw new Error('Select at least one channel.');return commands.leds(mask,values.flatMap((value,i)=>selected[i]?[integerValue(value,0,255)]:[]));}
export function headingCommand(speed:string,heading:string){const angle=integerValue(heading,-2147483648,2147483647);return commands.drive(integerValue(speed,0,255),((angle%360)+360)%360);}
export function readFloatResponse(response:unknown){const data=(response as {data?:Uint8Array})?.data;if(!(data instanceof Uint8Array)||data.length!==4)throw new Error('Expected exactly four response bytes.');const value=new DataView(data.buffer,data.byteOffset,4).getFloat32(0,false);if(!Number.isFinite(value))throw new Error('Droid returned non-finite position.');return value;}

/** The release deadline starts with the intent, independently of ACK latency.
 * Aborting for a replacement only revokes this timer: its caller owns the stop barrier. */
export function boundedDrive(execute:()=>Promise<unknown>,release:()=>Promise<void>,stop:()=>Promise<void>,options:{signal?:AbortSignal;durationMs?:number}={}):Promise<void>{
 const {signal,durationMs=200}=options;
 if(signal?.aborted)return Promise.resolve();
 return new Promise<void>((resolve,reject)=>{
  let finished=false,timer:ReturnType<typeof setTimeout>|undefined;
  const finish=(error?:unknown,shouldRelease=true)=>{
   if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);
   if(!shouldRelease){if(error)reject(error);else resolve();return;}
   let released:Promise<void>;
   try{released=release();}catch(releaseError){released=Promise.reject(releaseError);}
   void released.then(()=>{if(error)reject(error);else resolve();},async releaseError=>{await stop().catch(()=>{});reject(releaseError);});
  };
  const cancel=()=>finish(undefined,signal?.reason!=='replacement-barrier');
  signal?.addEventListener('abort',cancel,{once:true});
  timer=setTimeout(()=>finish(),durationMs);
  try{void execute().catch(error=>finish(error,!(error instanceof ResourceConflictError)));}catch(error){finish(error,!(error instanceof ResourceConflictError));}
 });
}
export async function applyReplacement(port:{replaceSources?:()=>Promise<void>;armMotion:()=>void;execute:(command:Command)=>Promise<unknown>},command:Command,current:()=>boolean){
 if(!port.replaceSources)throw new Error('Source replacement is unavailable.');
 await port.replaceSources();
 if(!current())throw new Error('Source replacement canceled by newer input or STOP.');
 // A replacement never replays transient movement demand.
 if(command.did===0x16)return;
 port.armMotion();await port.execute(command);
}

/** Native owns the fixed deadline and resolves after its zero write handling.
 * JS only forwards early cancellation; it never substitutes a renewable timer. */
export async function nativeBoundedDrive(pulse:()=>Promise<void>,release:()=>Promise<void>,stop:()=>Promise<void>,signal:AbortSignal){
 if(signal.aborted)return;
 let cleanup=Promise.resolve(),releaseError:unknown;
 const cancel=()=>{if(signal.reason==='replacement-barrier')return;cleanup=(async()=>{try{await release();}catch(error){await stop().catch(()=>{});releaseError=error;}})();};
 signal.addEventListener('abort',cancel,{once:true});
 try{await pulse();}finally{signal.removeEventListener('abort',cancel);await cleanup;if(releaseError)throw releaseError;}
}
