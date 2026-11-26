export type AutomationOwnerPanel='Sequences'|'Paths & Patrol';
export function runningSourceIndicators(sources:{automation:string;experience:string},automationPanel:AutomationOwnerPanel){return ([{key:'automation',label:sources.automation,panel:automationPanel},{key:'experience',label:sources.experience,panel:'Experiences'}] as const).filter(item=>!!item.label);}
