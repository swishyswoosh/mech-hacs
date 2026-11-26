import type {SensorSnapshot} from '../../core/sensorSession.ts';
import {sensorFreshnessMs} from '../../core/sensorSession.ts';
export function attitudeNote(sensor:SensorSnapshot|undefined,connected:boolean,now=Date.now()):string|null {
 if(!connected||sensor?.status!=='streaming'||sensor.sampleAt===undefined||now-sensor.sampleAt>sensorFreshnessMs(sensor.intervalMs))return null;
 const axes=['pitch','roll','yaw'];
 if(axes.some(axis=>!Number.isFinite(sensor.values[`attitude.${axis}`])))return null;
 return axes.map(axis=>{
  const value=sensor.values[`attitude.${axis}`];
  const fixed=(Math.abs(value)<0.05?0:value).toFixed(1).replace('-','−');
  return `${axis} ${fixed}°`;
 }).join(' · ');
}
