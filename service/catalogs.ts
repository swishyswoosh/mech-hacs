import {libraryItems} from '../app/library/catalog.ts';
import {lightPreset,selectedLightCommand} from '../app/library/lights.ts';
import type {LightPreset} from '../app/library/lights.ts';
import {readLightPresets} from '../app/library/lightPresets.ts';
import type {PreferenceStore} from '../app/session/types.ts';
import {exampleDeviceLights,parseDeviceLightFile} from '../core/deviceLightFiles.ts';
import {compileNordicInlineLedRecipe} from '../core/ramRecipe.ts';

export type CatalogEffect='audio'|'lights'|'motion';
export interface CatalogItem {
  id:string;name:string;available:boolean;effects:CatalogEffect[];
  reason?:string;group?:string;duration_ms?:number;firmware_id?:number;sector?:number;
  completion:'ack';required_resources:string[];
}
export const MOTION_UNAVAILABLE='Remote transport motion safety has not been validated. Motion and unknown or mixed effects are unavailable.';
export const LIGHT_SETTING_CHANNELS=['front_dome_red','front_dome_green','front_dome_blue','rear_dome_red','rear_dome_green','rear_dome_blue','readouts','projector'] as const;
const builtinPresets:LightPreset[]=['Idle','Alert','Party','Off'];
export const DEVICE_LIGHT_PROTOCOL_ID='protocol-device-lights';

export function deviceLightProtocol(preferences:PreferenceStore){
  return parseDeviceLightFile(preferences.load('device.light-recipe.v1')??JSON.stringify(exampleDeviceLights));
}

export function catalog(kind:string,preferences:PreferenceStore):{items:CatalogItem[]} {
  if(kind==='sounds'||kind==='animations')return{items:libraryItems.filter(item=>!item.lightEffect&&item.kind===(kind==='sounds'?'sound':'animation')).map(item=>({
    id:item.key,name:item.name,group:item.category,firmware_id:item.id,...(item.sector===undefined?{}:{sector:item.sector}),
    available:item.kind==='sound',effects:item.kind==='sound'?['audio']:['audio','lights','motion'],
    required_resources:item.kind==='sound'?['audio']:['audio','lights','drive','dome','stance','behavior'],
    completion:'ack',...(item.kind==='animation'?{reason:MOTION_UNAVAILABLE}:{}),
  }))};
  if(kind==='light_presets'){
    const saved=readLightPresets(key=>preferences.load(key));
    if(saved.error)throw Error(saved.error);
    return{items:[...builtinPresets.map(name=>({id:`preset-${name.toLowerCase()}`,name})),...saved.presets.filter(p=>!builtinPresets.some(name=>p.id===`preset-${name.toLowerCase()}`))].map(p=>({id:p.id,name:p.name,available:true,effects:['lights'],required_resources:['lights'],completion:'ack'}))};
  }
  if(kind==='protocols'){
    const recipe=deviceLightProtocol(preferences),compiled=compileNordicInlineLedRecipe(recipe);
    return{items:[{id:DEVICE_LIGHT_PROTOCOL_ID,name:recipe.name,available:true,effects:['lights'],required_resources:['lights'],completion:'ack',duration_ms:compiled.durationMs,reason:'Requires Nordic 7.0.101; verified before execution. Schedule duration and cleanup ACK do not prove physical completion.'}]};
  }
  if(kind==='paths')return{items:preferences.load('automation.path.v1')===null?[]:[{id:'path-saved',name:'Saved path',available:false,effects:['motion'],required_resources:['drive','stance'],completion:'ack',reason:MOTION_UNAVAILABLE}]};
  throw Error('Unknown catalog kind');
}

export function lightCommand(parameters:Record<string,unknown>,preferences:PreferenceStore){
  if(Object.keys(parameters).some(key=>!['preset_id','settings'].includes(key))||(parameters.preset_id===undefined)===(parameters.settings===undefined))throw Error('Choose exactly one light preset_id or settings object');
  if(parameters.preset_id!==undefined){
    if(typeof parameters.preset_id!=='string')throw Error('Light preset_id must be a string');
    const builtin=builtinPresets.find(name=>`preset-${name.toLowerCase()}`===parameters.preset_id);
    if(builtin)return selectedLightCommand(lightPreset(builtin),Array(8).fill(true));
    const saved=readLightPresets(key=>preferences.load(key));if(saved.error)throw Error(saved.error);
    const preset=saved.presets.find(p=>p.id===parameters.preset_id);if(!preset)throw Error('Unknown light preset');
    return selectedLightCommand(preset.values,preset.selected);
  }
  const settings=parameters.settings;
  if(!settings||typeof settings!=='object'||Array.isArray(settings))throw Error('Light settings must be a channel object');
  const values=Array<number>(8).fill(0),selected=Array<boolean>(8).fill(false);
  for(const [key,value] of Object.entries(settings)){
    const index=LIGHT_SETTING_CHANNELS.findIndex(channel=>channel===key);
    if(index<0||typeof value!=='number'||!Number.isInteger(value)||value<0||value>255)throw Error('Unknown light channel or brightness outside 0..255');
    values[index]=value;selected[index]=true;
  }
  return selectedLightCommand(values,selected);
}
