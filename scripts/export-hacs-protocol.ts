/** Generate deployment-only data from the audited TypeScript controller. No BLE. */
import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {catalog,lightCommand,deviceLightProtocol,LIGHT_SETTING_CHANNELS,MOTION_UNAVAILABLE} from '../service/catalogs.ts';
import {stopPlan} from '../core/gates.ts';
import {compileNordicInlineLedRecipe,cancelDeviceLightRecipe,releaseDeviceLightPriority} from '../core/ramRecipe.ts';
import {SessionStore} from '../app/session/store.ts';
const preferences={load:(_key:string)=>null,save:(_key:string,_value:string)=>{}};
const command=(c:{did:number;cid:number;data:Uint8Array})=>({...c,data:Array.from(c.data)});
export function protocolData(){
 const catalogs=Object.fromEntries(['sounds','animations','light_presets','protocols','paths'].map(kind=>[kind,catalog(kind,preferences)]));
 const recipe=deviceLightProtocol(preferences),compiled=compileNordicInlineLedRecipe(recipe);
 return {
  schema_version:1,
  session_defaults:new SessionStore({state:'disconnected',detail:'Disconnected.',packets:[]}).getSnapshot(),
  catalogs,light_channels:LIGHT_SETTING_CHANNELS,motion_unavailable:MOTION_UNAVAILABLE,
  presets:Object.fromEntries(catalogs.light_presets.items.map(item=>[item.id,command(lightCommand({preset_id:item.id},preferences))])),
  recipe,recipe_command:command(compiled.command),recipe_duration_ms:compiled.durationMs,
  stop_plan:stopPlan('heading').map(command),cancel_lights:command(cancelDeviceLightRecipe()),release_lights:command(releaseDeviceLightPriority()),
 };
}
const output=new URL('../custom_components/mech/catalog_data.json',import.meta.url);
const content=JSON.stringify(protocolData(),null,2)+'\n';
if(process.argv.includes('--check')){
 if(readFileSync(output,'utf8')!==content)throw Error('HACS catalog data is stale; run node scripts/export-hacs-protocol.ts');
}else if(process.argv[1]===fileURLToPath(import.meta.url))writeFileSync(output,content);
