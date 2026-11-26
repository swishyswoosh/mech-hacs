import {commands} from './commands.ts';
import {sensorSchemaFor,installPlannedSensorSchema} from './sensorSchema.ts';
import {responseView,decodeSensorReading} from './service.ts';
import type {Command,Packet} from './protocol.ts';
export const cockpitSchema=sensorSchemaFor([{fields:['attitude.pitch','attitude.roll','attitude.yaw','accelerometer.x','accelerometer.y','accelerometer.z','rawGyroscope.x','rawGyroscope.y','rawGyroscope.z','processorTemperature'],intervalMs:1000}])!;
export const cockpitQueryIntervals=[5000,10000,5000,5000,60000,60000];
export const cockpitQueries=[commands.encoderCounts,commands.adc,commands.getHead,commands.getLeg,commands.battery,commands.temperature];
/** Only the known 3-float attitude stream can be expanded in place. Its old
 * packets cannot decode as the new 10-float stream. Arbitrary same-width schema
 * replacements still require the existing explicit schema-manager workflow. */
export async function expandCockpitStream(execute:(c:Command)=>Promise<Packet>,disable:()=>void){
 const standard=responseView(await execute(commands.getStreaming()),24,1,7);
 const extended=responseView(await execute(commands.getExtendedStreaming()),24,13,4).getUint32(0);
 const mask=standard.getUint32(3),interval=standard.getUint16(0);
 const knownAttitude=mask===0x70000&&extended===0;
 const knownCockpit=mask===cockpitSchema.standardMask&&extended===cockpitSchema.extendedMask;
 const stopped=interval===0&&mask===0&&extended===0;
 if(!knownAttitude&&!knownCockpit&&!stopped)throw Error('Existing custom sensor stream retained');
 disable();
 await execute(commands.streaming(0,0,mask));
 const stoppedReply=responseView(await execute(commands.getStreaming()),24,1,7);
 if(stoppedReply.getUint16(0)!==0)throw Error('Sensor stream did not stop');
 await installPlannedSensorSchema(execute,cockpitSchema);
}
export function decodeCockpitReading(p:Packet):Record<string,number>{
 if(p.did===24&&p.cid===8){const r=decodeSensorReading('adc',p);if(r.kind==='adc')return{'shoulder.adc':r.shoulder,'dome.adc':r.head};}
 if(p.did===24&&p.cid===9){const r=decodeSensorReading('encoders',p);if(r.kind==='encoders')return{'encoder.0':r.counter0,'encoder.1':r.counter1};}
 if(p.did===17&&p.cid===14){const r=decodeSensorReading('temperature',p);if(r.kind==='temperature')return{'processor.celsius':r.celsius};}
 if(p.did===19&&p.cid===3)return{'battery.volts':responseView(p,19,3,2).getUint16(0)/100};
 if(p.did===23&&[20,22].includes(p.cid)){
  const value=responseView(p,23,p.cid,4).getFloat32(0);
  if(!Number.isFinite(value))throw Error('Position reading must be finite');
  return{[p.cid===20?'dome.degrees':'stance.position']:value};
 }
 throw Error('Unsupported cockpit readback');
}

/** Changing only the interval preserves packet layout, so no transport replacement
 * is needed. Verify ownership of both masks before writing and read the rate back. */
export async function setCockpitStreamInterval(execute:(c:Command)=>Promise<Packet>,intervalMs:number){
 const standard=responseView(await execute(commands.getStreaming()),24,1,7);
 const extended=responseView(await execute(commands.getExtendedStreaming()),24,13,4);
 if(!standard.getUint16(0)||standard.getUint8(2)!==0||standard.getUint32(3)!==cockpitSchema.standardMask||extended.getUint32(0)!==cockpitSchema.extendedMask)throw Error('Existing custom sensor stream retained');
 await execute(commands.streaming(intervalMs,0,cockpitSchema.standardMask));
 const result=responseView(await execute(commands.getStreaming()),24,1,7);
 if(result.getUint16(0)!==intervalMs||result.getUint8(2)!==0||result.getUint32(3)!==cockpitSchema.standardMask)throw Error('Sensor interval readback mismatch');
}
