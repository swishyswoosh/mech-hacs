import {BATTERY_PROFILING_KEY} from '../app/session/BatteryProfiling.ts';
import type {BatteryProfilingStorage} from '../app/session/BatteryProfiling.ts';
export function browserBatteryProfilingStorage(storage:Pick<Storage,'getItem'|'setItem'>,locks?:Pick<LockManager,'request'>):BatteryProfilingStorage {
 const key=`r2.${BATTERY_PROFILING_KEY}`;
 return {load:()=>storage.getItem(key),save:async(value,expected)=>{
  const write=()=>{if(storage.getItem(key)!==expected)throw Error('Battery profiling data changed in another session');storage.setItem(key,value);};
  if(locks)await locks.request(key,write);else write();
 }};
}
