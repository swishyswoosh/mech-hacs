import type {AppSnapshot} from '../session/types.ts';
/** The queried head position is in degrees; the raw stream field is not a substitute. */
export function observedDomeDegrees(snapshot:AppSnapshot|undefined,now=Date.now()):number|undefined{
 if(!snapshot||!['ready','paused'].includes(snapshot.state))return;
 const reading=snapshot.cockpitReadings?.['dome.degrees'];
 return reading&&now-reading.at<=15000&&Number.isFinite(reading.value)?reading.value:undefined;
}
export function formatDomeDegrees(value:number|undefined):string{
 if(value===undefined||!Number.isFinite(value))return '—';
 const rounded=Math.abs(value)<.05?0:value;
 return `${rounded>0?'+':''}${rounded.toFixed(1).replace('-','−')}°`;
}
