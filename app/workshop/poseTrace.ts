import type {TelemetryEvent} from '../../core/telemetryEvents.ts';
export type TracePoint={id:number;at:number;x:number;y:number;rawX:number;rawY:number;segment:number};
export type TraceMarker={at:number;kind:'schema-change'|'connection-change'|'local-origin';segment:number};
export class PoseTrace {
 points:TracePoint[]=[];markers:TraceMarker[]=[];segment=0;
 private origin?:{x:number;y:number};private schema?:number;private connected=true;private state='';
 private breakFrame(kind:TraceMarker['kind'],at:number){this.segment++;this.origin=undefined;this.markers=[...this.markers,{at,kind,segment:this.segment}].slice(-100);}
 accept(event:TelemetryEvent){
  if(event.type==='connection'){if(event.state!==this.state){this.state=event.state;this.connected=event.state==='ready';this.breakFrame('connection-change',event.at);}return;}
  if(event.type!=='sample'||!this.connected)return;
  const x=event.values['locator.x'],y=event.values['locator.y'];if(!Number.isFinite(x)||!Number.isFinite(y))return;
  if(this.schema!==undefined&&this.schema!==event.schemaEpoch)this.breakFrame('schema-change',event.at);this.schema=event.schemaEpoch;
  if(!this.origin)this.origin={x,y};this.points=[...this.points,{id:event.id,at:event.at,x:x-this.origin.x,y:y-this.origin.y,rawX:x,rawY:y,segment:this.segment}].slice(-500);
 }
 visible(){return this.points.filter(point=>point.segment===this.segment);}
 resetOrigin(at=Date.now()){const last=this.points.at(-1);this.breakFrame('local-origin',at);if(last)this.origin={x:last.rawX,y:last.rawY};return this.origin;}
}
export function projectTrace(points:TracePoint[],width:number,height:number){if(!points.length)return[];const xs=points.map(p=>p.x),ys=points.map(p=>p.y),minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys),scale=Math.max(0,Math.min(width-32,height-32))/Math.max(maxX-minX,maxY-minY,1);return points.map(point=>({...point,x:width/2+(point.x-(minX+maxX)/2)*scale,y:height/2-(point.y-(minY+maxY)/2)*scale}));}
