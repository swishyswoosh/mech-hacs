import {NativeModules,NativeEventEmitter} from 'react-native';
import type {ExternalInputMode,ExternalInputSample} from '../../core/externalInput.ts';
export async function startExternalInput(mode:ExternalInputMode,onSample:(sample:ExternalInputSample)=>void,onRevoke:(reason:string)=>void):Promise<()=>void>{
 const bridge=NativeModules.R2ExternalInput;if(!bridge?.start||!bridge?.stop)throw new Error('Native external input module is unavailable in this build.');
 const events=new NativeEventEmitter(bridge);let stopped=false;
 const subscription=events.addListener('R2ExternalInputSample',(payload:object)=>{const event=payload as ExternalInputSample|{kind:'revoked';reason:string};if(stopped)return;if(event.kind==='revoked'){stop();onRevoke(event.reason);}else onSample(event.kind==='gamepad'?{...event,deviceId:String(event.deviceId)}:event);});
 const stop=()=>{if(stopped)return;stopped=true;subscription.remove();void bridge.stop().catch(()=>{});};
 try{await bridge.start(mode);}catch(error){stop();throw error;}
 return stop;
}
