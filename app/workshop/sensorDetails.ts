import {integerValue} from '../../core/controlValues.ts';
import type {SensorReading} from '../../core/index.ts';
export function collisionDraftBytes(values:string[]){if(values.length!==6)throw new Error('Enter exactly six collision configuration bytes.');return values.map((value,index)=>integerValue(value,0,index===0?3:255));}
export function sensorReadingText(reading:SensorReading){switch(reading.kind){case'adc':return `Shoulder raw ADC ${reading.shoulder}; head raw ADC ${reading.head}`;case'encoders':return `Left encoder: ${reading.counter0}; right encoder: ${reading.counter1} (signed raw counters)`;case'stall':return `Shoulder stall-recovery hold: ${reading.held?'reported held':'reported not held'} (raw ${reading.raw})`;case'temperature':return `ST processor temperature estimate: ${reading.celsius} °C`;}}

export function collisionFieldLabel(index:number){return index===0?'Collision mode byte 0 (0–3)':`Collision configuration byte ${index} (0–255)`;}
