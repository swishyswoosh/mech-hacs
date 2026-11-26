export type NavigationEntry={panel:string;subpage:string};
export const panelNames=['Actions','Fine Control','Sensors','Sequences','Paths & Patrol','Experiences','Droid','Diagnostics','Settings'] as const;
export function panelForKey(panel:string,key:string):string|undefined{
 const index=panelNames.indexOf(panel as typeof panelNames[number]);if(index<0)return;
 if(key==='Home')return panelNames[0];if(key==='End')return panelNames[panelNames.length-1];
 if(key==='ArrowRight')return panelNames[(index+1)%panelNames.length];if(key==='ArrowLeft')return panelNames[(index+panelNames.length-1)%panelNames.length];
}
export function androidBackTarget(state:NavigationEntry&{menu:boolean;confirmation:boolean},history:NavigationEntry[]):{kind:'confirmation'|'menu'|'exit'}|{kind:'subpage';subpage:string}|{kind:'panel';entry:NavigationEntry}{
 if(state.confirmation)return {kind:'confirmation'};
 if(state.menu)return {kind:'menu'};
 if(state.panel==='Fine Control'&&state.subpage!=='Drive')return {kind:'subpage',subpage:'Drive'};
 if(history.length)return {kind:'panel',entry:history[history.length-1]};
 if(state.panel!=='Droid')return {kind:'panel',entry:{panel:'Droid',subpage:'Drive'}};
 return {kind:'exit'};
}
export function experienceBackTarget(state:{page:string;launched:boolean;selected:boolean}):'hotspot'|'explorer'|'page'|'panel'{
 if(state.page!=='Virtual Environments')return 'panel';
 if(state.selected)return 'hotspot';
 if(state.launched)return 'explorer';
 return 'page';
}
