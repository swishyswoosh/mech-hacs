import {streamFields} from '../../core/index.ts';
import {LOCAL_JSON_MAX_BYTES,localTextBytes} from '../../core/localJson.ts';
import type {TelemetryRecording,RecordingSelectionMarker} from '../../core/telemetryEvents.ts';
export type SensorExportPart={name:string;text:string;bytes:number};
type Capture=Pick<TelemetryRecording,'records'|'dropped'|'recording'>;
/** Freeze an export snapshot without stopping capture. Each part is independently
 * valid JSON; saving another part always requires another explicit user action. */
export function prepareSensorExports(recording:Capture,maxBytes=LOCAL_JSON_MAX_BYTES):SensorExportPart[]{
 if(!Number.isInteger(maxBytes)||maxBytes<=0||maxBytes>LOCAL_JSON_MAX_BYTES)throw new Error('Recording export limit must be between 1 and 2,000,000 UTF-8 bytes.');
 const capturedAt=Date.now(),totalRecords=recording.records.length;
 const selection=recording.records.find((record):record is RecordingSelectionMarker=>record.type==='recording-selection');
 const metadata={schema:'r2-local-sensor-recording-v2',snapshotId:`r2-${capturedAt}-${totalRecords}`,capturedAt,recordingAtSnapshot:recording.recording,totalRecords,requestedIntervalMs:selection?.requestedIntervalMs??null,selectedFields:selection?.fields??null,units:'raw wire floats; locator/velocity APK presentation multiplies by 100; processorTemperature is processor estimate degrees C',eventIdPolicy:'monotonic per port instance; timestamps may repeat; ID gaps are counted',droppedEvents:recording.dropped,fields:streamFields};
 // The largest possible index/count uses at least as many digits as every real
 // part header, so each completed file stays within its native bridge limit.
 const bound=Math.max(1,totalRecords),headerBytes=localTextBytes(JSON.stringify({...metadata,part:{number:bound,count:bound,firstRecordIndex:bound,lastRecordIndex:bound},records:[]}));
 if(headerBytes>maxBytes)throw new Error(`Recording metadata exceeds the ${maxBytes.toLocaleString('en-US')}-byte file limit.`);
 const chunks:Array<{texts:string[];first:number;last:number}>=[];
 let texts:string[]=[],bodyBytes=0,first=0;
 for(let index=0;index<totalRecords;index++){
  const text=JSON.stringify(recording.records[index]),bytes=localTextBytes(text);
  if(headerBytes+bytes>maxBytes)throw new Error(`Record ${index+1} exceeds the ${maxBytes.toLocaleString('en-US')}-byte file limit. No export files were written; the recording remains in memory.`);
  if(texts.length&&headerBytes+bodyBytes+1+bytes>maxBytes){chunks.push({texts,first,last:index-1});texts=[];bodyBytes=0;first=index;}
  bodyBytes+=bytes+(texts.length?1:0);texts.push(text);
 }
 if(texts.length||!chunks.length)chunks.push({texts,first,last:totalRecords-1});
 return chunks.map((chunk,index)=>{
  const part={number:index+1,count:chunks.length,firstRecordIndex:chunk.first,lastRecordIndex:chunk.last};
  const prefix=JSON.stringify({...metadata,part});const text=prefix.slice(0,-1)+',"records":['+chunk.texts.join(',')+']}';
  const bytes=localTextBytes(text);
  if(bytes>maxBytes)throw new Error(`Export part ${index+1} exceeds the ${maxBytes.toLocaleString('en-US')}-byte limit. No export files were written.`);
  return {name:`r2-sensor-${capturedAt}-part-${index+1}-of-${chunks.length}.json`,text,bytes};
 });
}
export async function saveSensorExportPart(part:SensorExportPart,save:(name:string,text:string)=>Promise<void>):Promise<void>{
 const bytes=localTextBytes(part.text);
 if(bytes>LOCAL_JSON_MAX_BYTES)throw new Error('Recording export exceeds the 2,000,000 UTF-8 byte file limit. No save picker was opened.');
 await save(part.name,part.text);
}
export type SavedSensorCapture={records:TelemetryRecording['records'];count:number};
/** Merely requesting another session never mutates an unsaved recording. */
export function startSensorRecording(recording:TelemetryRecording,state:string,allowDiscard=false,saved?:SavedSensorCapture):boolean{
 if(recording.recording)throw new Error('Stop the current recording before starting another.');
 const unsaved=recording.records.length>0&&(!saved||saved.records!==recording.records||saved.count<recording.records.length);
 if(unsaved&&!allowDiscard)return false;
 recording.start(state);return true;
}
