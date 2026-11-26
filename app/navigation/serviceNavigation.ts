import type {ServiceState} from '../../core/index.ts';
type ServiceExitPort={getServiceState?:()=>ServiceState;isServiceBusy?:()=>boolean;endServiceSession?:()=>Promise<void>;stop:()=>Promise<void>;disconnect:()=>Promise<void>};
/** No panel/menu transition commits until the service workflow has ended. A
 * locked published snapshot is insufficient while begin/entry is still pending. */
export async function leaveDiagnostics(port:ServiceExitPort,fallback:{state?:ServiceState;busy?:boolean}={}):Promise<void>{
 const state=port.getServiceState?.()??fallback.state??'locked',busy=port.isServiceBusy?.()??fallback.busy??false;
 if(state==='locked'&&!busy)return;
 try{
  if(!port.endServiceSession)throw new Error('Service exit operation is unavailable');
  await port.endServiceSession();
  if((port.getServiceState&&port.getServiceState()!=='locked')||port.isServiceBusy?.())throw new Error('Service access remains active after exit');
 }catch(error){
  const failures:string[]=[];
  try{await port.stop();}catch(stopError){failures.push(`STOP: ${String(stopError)}`);}
  try{await port.disconnect();}catch(disconnectError){failures.push(`disconnect: ${String(disconnectError)}`);}
  throw new Error(`Service exit failed: ${error instanceof Error?error.message:String(error)}. STOP and disconnect cleanup attempted; droid/service state remains unconfirmed.${failures.length?' '+failures.join('; '):''} Navigation was held; retry after checking the connection.`);
 }
}
