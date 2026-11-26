import {arcade} from './drive.ts';
import {commands} from './commands.ts';
import type {Command} from './protocol.ts';
export type PulseDirection='Forward'|'Reverse'|'Turn Left'|'Turn Right';
export const pulseDirections:PulseDirection[]=['Forward','Reverse','Turn Left','Turn Right'];
/** A separate accessible-mode cap never inherits a high joystick setting. */
export function accessiblePulseCommand(direction:PulseDirection,percent=10,continuousCap=100):Command{
 if(!Number.isInteger(percent)||percent<0||percent>25)throw new Error('Accessible pulse speed must be an integer from 0 to 25 percent.');
 if(!Number.isFinite(continuousCap)||continuousCap<0||continuousCap>100)throw new Error('Invalid continuous speed cap.');
 const vector=({Forward:[0,1],Reverse:[0,-1],'Turn Left':[-1,0],'Turn Right':[1,0]} as const)[direction];if(!vector)throw new Error('Unknown pulse direction.');
 const [left,right]=arcade(vector[0],vector[1],Math.min(percent,continuousCap)/100);
 return commands.tank(Math.floor(Math.abs(left)*255),Math.floor(Math.abs(right)*255),(left<0?8:0)|(right<0?16:0));
}
/** One executor, one deadline. Repeated accessibility activation never queues
 * another command or extends the active executor's lifetime. */
export class AccessiblePulseRunner {
 private controller?:AbortController;
 get active(){return !!this.controller;}
 async start(direction:PulseDirection,percent:number,continuousCap:number,execute:(command:Command,signal:AbortSignal)=>Promise<void>){
  if(this.controller)throw new Error('Pulse already active; repeated activation ignored.');
  const command=accessiblePulseCommand(direction,percent,continuousCap),controller=new AbortController();this.controller=controller;
  try{await execute(command,controller.signal);}finally{if(this.controller===controller)this.controller=undefined;}
 }
 cancel(replacement=false){this.controller?.abort(replacement?'replacement-barrier':undefined);}
}

export function repeatedPulseKey(key:string,repeat:boolean){return repeat&&(key==='Enter'||key===' '||key==='Spacebar');}
