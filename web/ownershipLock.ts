export interface ConnectionOwnership {acquire():Promise<void>;release():void}
export interface BrowserLockManager {request(name:string,options:{mode:'exclusive';ifAvailable:true},callback:(lock:unknown|null)=>Promise<void>):Promise<unknown>}
/** Origin-wide Web Lock; the browser releases it automatically when its tab closes. */
export class BrowserConnectionLock implements ConnectionOwnership {
 private manager:()=>BrowserLockManager|undefined;
 private releaseHeld?:()=>void;
 private pending?:Promise<void>;
 private activeRequest?:Promise<unknown>;
 private generation=0;
 constructor(manager:()=>BrowserLockManager|undefined=()=>navigator.locks){this.manager=manager;}
 acquire():Promise<void>{
  if(this.releaseHeld)return Promise.resolve();
  if(this.pending)return this.pending;
  const manager=this.manager();if(!manager)return Promise.reject(new Error('Exclusive browser control is unavailable. Use Chrome with Web Locks on HTTPS or localhost.'));
  const generation=this.generation;
  const previous=this.activeRequest;
  const pending=(async()=>{
   // A released Web Lock is not available until its callback has fully returned.
   if(previous)await previous.catch(()=>{});
   if(generation!==this.generation)throw new Error('Connection ownership canceled.');
   await new Promise<void>((resolve,reject)=>{
    const request=manager.request('r2-controller-ble',{mode:'exclusive',ifAvailable:true},async lock=>{
     if(!lock){reject(new Error('Another tab owns droid control. Disconnect in that tab, then choose the droid here.'));return;}
     if(generation!==this.generation){reject(new Error('Connection ownership canceled.'));return;}
     await new Promise<void>(release=>{this.releaseHeld=release;resolve();});
     this.releaseHeld=undefined;
    });
    this.activeRequest=request;
    void request.then(()=>{if(this.activeRequest===request)this.activeRequest=undefined;},error=>{if(this.activeRequest===request)this.activeRequest=undefined;reject(error);});
   });
  })();
  this.pending=pending;void pending.then(()=>{if(this.pending===pending)this.pending=undefined;},()=>{if(this.pending===pending)this.pending=undefined;});return pending;
 }
 release(){this.generation++;const release=this.releaseHeld;this.releaseHeld=undefined;release?.();}
}
