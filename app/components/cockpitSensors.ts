import { observedDomeDegrees,formatDomeDegrees } from '../cockpit/domeReading.ts';
import type {AppSnapshot} from '../session/types.ts';
import {sensorFreshnessMs} from '../../core/sensorSession.ts';
export function cockpitSensorRows(snapshot:AppSnapshot|undefined,now=Date.now()){
 if(!snapshot||!['ready','paused'].includes(snapshot.state))snapshot=undefined;
 const sensor=snapshot?.sensors;
 const fresh=sensor?.status==='streaming'&&sensor.sampleAt!==undefined&&now-sensor.sampleAt<=sensorFreshnessMs(sensor.intervalMs);
 const stream=(key:string)=>fresh&&Number.isFinite(sensor?.values[key])?sensor!.values[key]:undefined;
 const reading=(key:string)=>{const r=snapshot?.cockpitReadings?.[key];return r&&now-r.at<=(['battery.volts','processor.celsius'].includes(key)?120000:15000)&&Number.isFinite(r.value)?r.value:undefined;};
 const number=(n:number|undefined,digits=0)=>n===undefined?'—':(Math.abs(n)<.5*10**(-digits)?0:n).toFixed(digits).replace('-','−');
 const signed=(n:number|undefined,digits=0)=>{const value=number(n,digits);return Number(value)>0?`+${value}`:value;};
 const axes=(prefix:string)=>['x','y','z'].map(axis=>`${axis.toUpperCase()} ${signed(stream(`${prefix}.${axis}`),2)}`).join(' · ')+' raw';
 const dome=observedDomeDegrees(snapshot,now),temp=reading('processor.celsius'),battery=reading('battery.volts');
 return [
  {label:'ACCEL',value:axes('accelerometer')},
  {label:'GYRO',value:axes('rawGyroscope')},
  {label:'WHEELS',value:`Left ${signed(reading('encoder.0'))} · Right ${signed(reading('encoder.1'))}`,hint:'Left and right wheel encoder counts, from the droid’s perspective.'},
  {label:'DOME',value:formatDomeDegrees(dome)},
  {label:'SHOULDER',value:`${number(reading('shoulder.adc'))} ADC · stance ${signed(reading('stance.position'),1)}`},
  {label:'BATTERY',value:battery===undefined?'—':`${number(battery,2)} V`},
  {label:'CPU',value:temp===undefined?'—':`${signed(temp)} °C`},
 ];
}

/** Display-only averaging. Raw store values, recording and control inputs are untouched. */
export class CockpitDisplayWindow {
 private latest?:AppSnapshot;
 private previous?:AppSnapshot['sensors'];
 private identity='';
 private samples:NonNullable<AppSnapshot['sensors']>[]=[];
 private averaged?:NonNullable<AppSnapshot['sensors']>;
 add(snapshot:AppSnapshot|undefined){
  this.latest=snapshot;
  const sensor=snapshot?.sensors;
  const identity=`${snapshot?.connectionEpoch}:${snapshot?.state}:${sensor?.schemaEpoch}:${sensor?.status}`;
  if(identity!==this.identity){this.samples=[];this.averaged=undefined;this.previous=undefined;this.identity=identity;}
  if(sensor!==this.previous&&sensor?.status==='streaming'&&sensor.sampleAt!==undefined){
   this.samples.push(sensor);
   // Bound memory even if a background browser suspends the display timer.
   this.samples=this.samples.filter(s=>s.sampleAt!>=sensor.sampleAt!-1000).slice(-40);
  }
  this.previous=sensor;
 }
 read(now:number):AppSnapshot|undefined{
  const latest=this.latest,sensor=latest?.sensors;if(!latest||!sensor)return latest;
  this.samples=this.samples.filter(s=>s.sampleAt!>now-1000&&s.sampleAt!<=now);
  if(this.samples.length){
   const values={...sensor.values};
   for(const key of Object.keys(values)){
    if(!/^(accelerometer|rawGyroscope|attitude)\./.test(key))continue;
    const numbers=this.samples.map(s=>s.values[key]).filter(Number.isFinite);
    if(!numbers.length)continue;
    values[key]=key.startsWith('attitude.')
     ?Math.atan2(numbers.reduce((sum,n)=>sum+Math.sin(n*Math.PI/180),0),numbers.reduce((sum,n)=>sum+Math.cos(n*Math.PI/180),0))*180/Math.PI
     :numbers.reduce((sum,n)=>sum+n,0)/numbers.length;
   }
   this.averaged={...sensor,values};
  }
  return {...latest,sensors:this.averaged&&this.averaged.sampleAt===sensor.sampleAt?{...sensor,values:this.averaged.values}:sensor};
 }
}

/** Immediately clear on disconnect; never show a sample from a previous connection. */
export function cockpitDisplaySnapshot(live:AppSnapshot|undefined,averaged:AppSnapshot|undefined){
 if(!live||!['ready','paused'].includes(live.state))return undefined;
 return averaged && averaged.connectionEpoch===live.connectionEpoch && ['ready','paused'].includes(averaged.state)?averaged:live;
}
