import {streamFields} from '../../core/index.ts';
export const sensorPages=['Motion','Pose & Odometry','Articulation','Power & Health','Unresolved','All Fields','Events','Recording'] as const;
export function sensorView(page:string,search:string){
 const kind=page==='Events'?'events':page==='Recording'?'recording':'fields';
 const fields=kind!=='fields'?[]:streamFields.filter(field=>{
  if(page==='Motion')return /acceler|[gG]yro/.test(field.name);
  if(page==='Pose & Odometry')return /quaternion|attitude|locator|velocity|^speed$|scaledSpeed|coreTime/.test(field.name);
  if(page==='Articulation')return field.name==='headAngle';
  if(page==='Power & Health')return field.name==='processorTemperature';
  if(page==='Unresolved')return field.name.startsWith('internal.');
  return field.name.toLowerCase().includes(search.toLowerCase());
 });
 return {kind,fields};
}
