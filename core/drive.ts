export function arcade(x:number,y:number,speed:number):[number,number] {
 if(![x,y,speed].every(Number.isFinite))throw new Error('Invalid drive demand');
 const radius=Math.hypot(x,y);if(radius<=0.08)return[0,0];
 const scale=Math.min(1,(radius-0.08)/0.92)/radius;x*=scale;y*=scale;
 let left=y+x,right=y-x;const divisor=Math.max(1,Math.abs(left),Math.abs(right));
 return [left/divisor*Math.min(1,Math.max(0,speed)),right/divisor*Math.min(1,Math.max(0,speed))];
}
