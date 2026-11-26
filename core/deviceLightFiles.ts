import {compileNordicInlineLedRecipe} from './ramRecipe.ts';
import type {NordicInlineLedRecipe} from './ramRecipe.ts';
export interface DeviceLightFile extends NordicInlineLedRecipe {version:1;name:string}
export const exampleDeviceLights:DeviceLightFile={version:1,name:'Blue fade',frames:[{atMs:0,controls:[0,0,255,0,0,255,0,0],transitionMs:500},{atMs:1500,controls:[0,0,0,0,0,0,0,0],transitionMs:500}]};
export function parseDeviceLightFile(text:string):DeviceLightFile{
 if(text.length>50000)throw new Error('Light protocol file exceeds 50 KB');
 const value=JSON.parse(text);
 if(!value||value.version!==1||typeof value.name!=='string'||!value.name.trim()||value.name.length>120||Object.keys(value).some(k=>!['version','name','frames'].includes(k)))throw new Error('Expected version 1, name and light frames');
 compileNordicInlineLedRecipe({frames:value.frames});
 return {version:1,name:value.name,frames:value.frames.map((f:any)=>({...f,controls:[...f.controls]}))};
}
