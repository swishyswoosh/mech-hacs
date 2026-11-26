import type {DroidSession} from '../app/session/DroidSession.ts';
import {SessionStore} from '../app/session/store.ts';

/** One-time schema migration for an already-running pre-rename session.
 * Legacy names stay here because old callbacks and saved connections can outlive
 * a hot update. Never construct a session or touch its transport to rename it. */
export function adoptRetainedDroidSession(session:DroidSession){
 const retained=session as unknown as Record<string,any>;
 for(const [legacy,current] of [['robotName','droidName'],['robotId','droidId']]){
  if(!Object.hasOwn(retained,current))retained[current]=retained[legacy];
  Object.defineProperty(retained,legacy,{configurable:true,get:()=>retained[current],set:value=>{retained[current]=value;}});
 }
 const factory=retained.options.factory;
 factory.authorizedDroids??=factory.authorizedRobots?.bind(factory);
 Object.setPrototypeOf(session.store,SessionStore.prototype);
 retained.publish({});
}
