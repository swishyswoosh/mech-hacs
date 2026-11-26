import {validateNordicInlineLedPayload} from './ramRecipe.ts';
import type {Command} from './protocol.ts';
export type Resource='drive'|'dome'|'stance'|'lights'|'audio'|'behavior';
const all:Resource[]=['drive','dome','stance','lights','audio','behavior'];
export class ResourceConflictError extends Error {
 readonly owners:string[];readonly requested:string;
 constructor(owners:string[],requested:string){super(`Stop/replace required: ${requested} conflicts with ${owners.join(', ')}`);this.name='ResourceConflictError';this.owners=owners;this.requested=requested;}
}
export function commandClaim(c:Command):{owner:string;resources:Resource[]}|undefined{
 if(c.did===22&&[1,7,8].includes(c.cid)){if(c.data.every(v=>v===0))return;return{owner:'manual drive',resources:['drive','stance']};}
 if(c.did===23){
  if(c.cid===26&&validateNordicInlineLedPayload(c.data).kind==='schedule')return{owner:'device-RAM lights',resources:['lights']};
  if(c.cid===5)return{owner:'built-in animation',resources:all};
  if(c.cid===15)return{owner:'manual dome',resources:['dome']};
  if(c.cid===21||(c.cid===13&&c.data[0]!==0))return{owner:'manual stance',resources:['stance','drive']};
  if([10,45,47].includes(c.cid)&&c.data[0]!==0)return{owner:`behavior ${c.cid}`,resources:all};
  if(c.cid===41&&c.data[0]!==0)return{owner:'head tracking',resources:['dome','behavior']};
 }
 if(c.did===26&&c.cid===7)return{owner:'audio playback',resources:['audio']};
 if(c.did===26&&[14,25].includes(c.cid))return{owner:'manual lights',resources:['lights']};
}
/** Conservative ownership: notification semantics are not guessed to release resources. */
export class ResourceArbiter {
 private held=new Map<Resource,string>();
 private stationaryStance?:number;
 /** Static LED values can remain set. Every retained actuator/program owner
  * is conservatively busy until the existing acknowledged release path. */
 get hasOngoingActivity(){return [...this.held.values()].some(owner=>owner!=='manual lights');}
 get pendingStationaryStance(){return this.stationaryStance;}
 constructor(){this.reset();}
 reset(){this.stationaryStance=undefined;this.held=new Map(all.map(resource=>[resource,'unknown firmware sources']));}
 confirmDeviceLightsReleased(){for(const [resource,owner] of this.held)if(owner==='device-RAM lights')this.held.delete(resource);}
 clear(){this.stationaryStance=undefined;this.held.clear();}
 confirmStopped(resources:readonly Resource[]){for(const resource of resources)this.held.delete(resource);if(resources.includes('stance'))this.stationaryStance=undefined;}
 /** Only a matching, fresh GetLegAction reply can finish a finite stance. */
 confirmStationaryStance(action:number){
  if(this.stationaryStance===undefined||action!==this.stationaryStance)return;
  for(const [resource,owner] of this.held)if(owner==='manual stance')this.held.delete(resource);
  this.stationaryStance=undefined;
 }
 conflicts(c:Command):ResourceConflictError|undefined{
  const claim=commandClaim(c);if(!claim)return;
  const owners=[...new Set(claim.resources.flatMap(r=>{const owner=this.held.get(r);return owner&&(owner!==claim.owner||owner==='built-in animation')?[owner]:[];}))];
  return owners.length?new ResourceConflictError(owners,claim.owner):undefined;
 }
 accept(c:Command){
  // Called only after a successful matching droid response; never release a
  // different or unknown owner merely because a stop was requested.
  let released:string|undefined;
  if(c.did===23&&c.cid===43)released='built-in animation';
  else if(c.did===26&&c.cid===10)released='audio playback';
  else if(c.did===22&&[1,7,8].includes(c.cid)&&c.data.every(v=>v===0))released='manual drive';
  else if(c.did===23&&c.cid===13&&c.data[0]===0)released='manual stance';
  else if(c.did===23&&[10,45,47].includes(c.cid)&&c.data[0]===0)released=`behavior ${c.cid}`;
  else if(c.did===23&&c.cid===41&&c.data[0]===0)released='head tracking';
  if(released)for(const [resource,owner] of this.held)if(owner===released)this.held.delete(resource);
  const claim=commandClaim(c);if(claim)for(const resource of claim.resources)this.held.set(resource,claim.owner);
  if(released==='manual stance'||(claim?.resources.includes('stance')&&claim.owner!=='manual stance'))this.stationaryStance=undefined;
  if(claim?.owner==='manual stance')this.stationaryStance=c.cid===13&&[1,2].includes(c.data[0])?c.data[0]:undefined;
 }
}
