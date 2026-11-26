/** Encode ST 7.1.86 animator records without transmitting them. */
export type RamRecord=
 | {type:'audio';sector:number}
 | {type:'stance';action:number}
 | {type:'head';degrees:number;transitionMs:number}
 | {type:'relative-heading';degrees:number;transitionMs:number}
 | {type:'speed';speed:number;transitionMs:number}
 // These are the eight module15 control slots. Their mapping to
 // individual LEDs is unproven; do not silently map Recipe lights to them.
 | {type:'led-controls';values:number[];transitionMs:number};
export interface RamFrame {atMs:number;records:RamRecord[]}
export interface RamRecipe {slot:number;frames:RamFrame[]}
export interface CompiledRamRecipe {
 bytes:Uint8Array;slot:number;frames:number;durationMs:number;
 physicalExecutionVerified:false;
}
export const ramRecipeAvailability=Object.freeze({
 uploadEnabled:false,executionEnabled:false,
 reason:'Device-RAM upload changes the firmware’s built-in animation selector to five RAM slots. A connection-preserving reset of that mode has not been recovered; upload and execution remain disabled.',
});
function number(value:unknown,min:number,max:number,label:string,integer=false):number {
 if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max||(integer&&!Number.isInteger(value)))throw new Error(`${label} must be ${integer?'an integer ':''}${min}..${max}.`);
 return value;
}
const u16=(value:number)=>[value>>>8,value&255];
function f32(value:number):number[]{const bytes=new Uint8Array(4);new DataView(bytes.buffer).setFloat32(0,value,false);return Array.from(bytes);}
function encodeRecord(record:RamRecord):{id:number;bytes:number[];duration:number} {
 if(!record||typeof record!=='object')throw new Error('A typed module record is required.');
 const transition=()=>number('transitionMs'in record?record.transitionMs:undefined,1,65535,'Transition milliseconds',true);
 switch(record.type){
 case'audio':return{id:7,bytes:u16(number(record.sector,0,65535,'Audio sector',true)).concat(0),duration:0};
 case'stance':return{id:13,bytes:[number(record.action,0,3,'Stance action',true)],duration:0};
 case'head':{const duration=transition();return{id:14,bytes:[...f32((number(record.degrees,-160,180,'Head degrees')+160)/340),...u16(duration)],duration};}
 case'led-controls':{
  const duration=number(record.transitionMs,80,65535,'LED transition milliseconds',true);
  if(!Array.isArray(record.values)||record.values.length!==8)throw new Error('Exactly eight LED control values required.');
  return{id:15,bytes:[...record.values.map(value=>number(value,0,255,'LED control',true)),...u16(duration)],duration};
 }
 // Heading and speed use conservative encoder bounds, not claimed firmware
 // acceptance limits. Heading is relative, unlike ordinary drive recipes.
 case'relative-heading':{const duration=transition();return{id:17,bytes:[...f32(number(record.degrees,-180,180,'Relative heading degrees')),...u16(duration)],duration};}
 case'speed':{const duration=transition();return{id:19,bytes:[number(record.speed,-127,127,'Signed drive speed',true)&255,...u16(duration)],duration};}
 default:throw new Error('Unsupported RAM module record.');
 }
}
/** Compile explicitly authored device frames. This is not a lossless compiler
 * for the controller's Recipe type: absolute heading, audio stop time, event
 * waits, nested built-ins and LED channel semantics differ or are unproven.
 * Audio/stance records are discrete triggers; durationMs bounds the firmware
 * schedule, not audio playback or completion of physical movement.
 */
export function compileRamRecipe(recipe:RamRecipe):CompiledRamRecipe {
 if(!recipe||typeof recipe!=='object')throw new Error('A RAM protocol is required.');
 const slot=number(recipe.slot,0,4,'RAM slot',true);
 if(!Array.isArray(recipe.frames)||recipe.frames.length<1||recipe.frames.length>99)throw new Error('A RAM protocol requires 1..99 frames.');
 const bytes:number[]=[0,slot];let previous=-1,durationMs=0;
 for(const frame of recipe.frames){
  if(!frame||typeof frame!=='object')throw new Error('A RAM frame is required.');
  const at=number(frame.atMs,0,65535,'Frame milliseconds',true);
  if(previous===-1&&at!==0)throw new Error('First RAM frame must start at zero.');
  if(at<=previous)throw new Error('Frame timestamps must be strictly increasing.');previous=at;
  if(!Array.isArray(frame.records)||!frame.records.length||frame.records.length>6)throw new Error('Each frame requires 1..6 typed module records.');
  const records=frame.records.map(encodeRecord).sort((a,b)=>a.id-b.id);
  if(new Set(records.map(record=>record.id)).size!==records.length)throw new Error('Duplicate module in RAM frame.');
  bytes.push(0xff,...u16(at));
  for(const record of records){
   number(at+record.duration,0,65535,'Frame end milliseconds',true);
   // Module13's parser does not update global schedule duration (unlike the
   // other five modules). A later stance alone would never become eligible.
   if(record.id!==13)durationMs=Math.max(durationMs,at+record.duration);
   bytes.push(record.id,...record.bytes);
  }
 }
 bytes.push(0xfe);
 if(previous>durationMs)throw new Error('A stance frame cannot extend the firmware schedule; add a supported timed module covering it.');
 if(bytes.length>1000)throw new Error('Encoded RAM bundle exceeds 1000 bytes.');
 return{bytes:Uint8Array.from(bytes),slot,frames:recipe.frames.length,durationMs,physicalExecutionVerified:false};
}

export interface NordicInlineLedFrame {atMs:number;controls:number[];transitionMs:number}
export interface NordicInlineLedRecipe {frames:NordicInlineLedFrame[]}
export interface CompiledNordicInlineLedRecipe extends CompiledRamRecipe {
 firmware:'Nordic 7.0.101';
 command:{did:0x17;cid:0x1a;data:Uint8Array};
 cancelCommand:{did:0x17;cid:0x1a;data:Uint8Array};
}
/** Nordic 7.0.101 registers its inline animator locally with LED module15
 * only. This command replaces its pending/running schedule without entering
 * the ST upload17/06 mode. Controls are the eight firmware slots,
 * not a mapping from Recipe LED channels. Do not convert other Recipe steps.
 *
 * Callers must verify the firmware, serialize ownership with built-ins/direct
 * LEDs, and deliver cancelCommand during STOP before enabling this path.
 * ACK means queued: the firmware provides no deferred parser-result packet
 * in inline mode. durationMs is a schedule bound, not physical verification;
 * LED transitions additionally depend on the firmware main-loop cadence.
 */
export function compileNordicInlineLedRecipe(recipe:NordicInlineLedRecipe):CompiledNordicInlineLedRecipe {
 if(!recipe||!Array.isArray(recipe.frames))throw new Error('An inline LED protocol requires frames.');
 const frames:RamFrame[]=recipe.frames.map(frame=>{
  if(!frame||typeof frame!=='object'||!Array.isArray(frame.controls))throw new Error('Each inline LED frame requires eight raw LED controls.');
  if(Object.keys(frame).some(key=>!['atMs','controls','transitionMs'].includes(key)))throw new Error('Inline LED frames accept only atMs, controls and transitionMs; other protocol actions are unsupported.');
  return{atMs:frame.atMs,records:[{type:'led-controls',values:frame.controls,transitionMs:frame.transitionMs}]};
 });
 const compiled=compileRamRecipe({slot:0,frames});
 return{...compiled,firmware:'Nordic 7.0.101',
  command:{did:0x17,cid:0x1a,data:compiled.bytes.slice()},
  // Original handler clears running immediately. Parsing this valid empty
  // frame erases future records while retaining the current LED values.
  cancelCommand:{did:0x17,cid:0x1a,data:Uint8Array.of(0,0,0xff,0,0,0xfe)},
 };
}

/** The transport gate must call this for every 17/1a request. The native
 * parser has no safe generic raw-input contract; accept only our bounded
 * canonical LED schedule or the separately proven cancellation frame. */
export function validateNordicInlineLedPayload(data:Uint8Array):{kind:'schedule'|'cancel';durationMs:number} {
 if(!(data instanceof Uint8Array))throw new Error('Inline LED payload must be bytes.');
 const cancel=[0,0,0xff,0,0,0xfe];
 if(data.length===cancel.length&&cancel.every((value,index)=>data[index]===value))return{kind:'cancel',durationMs:0};
 if(data.length<17||data.length>1000||(data.length-3)%14!==0||data[0]!==0||data[1]!==0||data[data.length-1]!==0xfe)throw new Error('Invalid inline LED schedule.');
 const frames:NordicInlineLedFrame[]=[];
 for(let offset=2;offset<data.length-1;offset+=14){
  if(data[offset]!==0xff||data[offset+3]!==15)throw new Error('Only complete LED module15 frames are supported inline.');
  frames.push({atMs:data[offset+1]*256+data[offset+2],controls:Array.from(data.slice(offset+4,offset+12)),transitionMs:data[offset+12]*256+data[offset+13]});
 }
 const result=compileNordicInlineLedRecipe({frames});
 return{kind:'schedule',durationMs:result.durationMs};
}

/** Exact canonical empty schedule; never enters the ST RAM-slot upload mode. */
export const cancelDeviceLightRecipe=()=>({did:0x17,cid:0x1a,data:Uint8Array.of(0,0,0xff,0,0,0xfe)});

/** Releases Nordic animation LED priority after its >1.5 s idle housekeeping. */
export const releaseDeviceLightPriority=()=>({did:0x17,cid:0x28,data:new Uint8Array()});
