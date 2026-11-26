import {animations} from '../../core/catalogs.ts';
export function animationsInGroup(group:string,search='') {
 const catalogGroup=group==='Movie'?'WWM':group;
 return animations.filter(animation=>animation.group===catalogGroup&&animation.name.toLowerCase().includes(search.toLowerCase()));
}
export {batteryResponse} from '../session/compatibility.ts';
