import type {Command} from '../index.ts';
/** Renew the manual-source lease only for actual wheel demand, never read/idle heartbeats. */
export function isManualDemand(command:Command):boolean {
 if(command.did!==0x16)return false;
 if(command.cid===7)return command.data[0]>0;
 if(command.cid===8)return command.data[0]>0||command.data[1]>0;
 if(command.cid===1)return command.data[1]>0||command.data[3]>0;
 return false;
}
/** A protocol-acknowledged zero ends the source lease; failed zero commands retain it. */
export async function withManualIdleAcknowledgment<T>(command:Command,execute:()=>Promise<T>,idle:()=>void):Promise<T>{
 const result=await execute();
 if(command.did===0x16&&[1,7,8].includes(command.cid)&&!isManualDemand(command))idle();
 return result;
}
