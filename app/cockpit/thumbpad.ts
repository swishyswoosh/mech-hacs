/** Pointer identity and its initial contact point are captured until release. */
export class CapturedThumbpad {
 pointer?:number;
 private origin:[number,number]=[0,0];
 begin(pointer:number,x:number,y:number):[number,number]|undefined{if(this.pointer!==undefined)return;this.pointer=pointer;this.origin=[x,y];return [0,0];}
 move(pointer:number,x:number,y:number,radius:number):[number,number]|undefined{if(this.pointer!==pointer||!Number.isFinite(radius)||radius<=0)return;return[(x-this.origin[0])/radius,(this.origin[1]-y)/radius];}
 end(pointer:number){if(this.pointer!==pointer)return false;this.cancel();return true;}
 cancel(){this.pointer=undefined;this.origin=[0,0];}
}
