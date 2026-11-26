import type {SnapshotSource} from './ControllerSession.ts';
import type {SessionSnapshot} from './types.ts';

/** Presentation only: control and watchdog code always reads the unbatched store. */
export class SessionPresentation {
  private store: SnapshotSource;
  private snapshot: SessionSnapshot;
  private listeners = new Set<() => void>();
  private unsubscribe?: () => void;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(store: SnapshotSource) { this.store=store;this.snapshot=store.getSnapshot(); }
  getSnapshot = () => this.listeners.size ? this.snapshot : this.store.getSnapshot();
  private flush = () => {
    clearTimeout(this.timer);this.timer=undefined;
    const next=this.store.getSnapshot();
    if(next===this.snapshot)return;
    this.snapshot=next;
    for(const listener of this.listeners)listener();
  };
  private changed = () => {
    const next=this.store.getSnapshot();
    const telemetry=new Set(['packets','sensors','cockpitReadings','telemetry']);
    const keys=new Set([...Object.keys(next),...Object.keys(this.snapshot)]);
    const urgent=[...keys].some(key=>!telemetry.has(key)&&!Object.is(next[key as keyof SessionSnapshot],this.snapshot[key as keyof SessionSnapshot]));
    if(urgent)this.flush();
    else if(!this.timer)this.timer=setTimeout(this.flush,1000);
  };
  subscribe = (listener: () => void) => {
    if(!this.listeners.size){this.snapshot=this.store.getSnapshot();this.unsubscribe=this.store.subscribe(this.changed);}
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if(!this.listeners.size){this.unsubscribe?.();this.unsubscribe=undefined;clearTimeout(this.timer);this.timer=undefined;}
    };
  };
}

const presentations=new WeakMap<SnapshotSource,SessionPresentation>();
export function presentationFor(store:SnapshotSource){
  let view=presentations.get(store);
  if(!view){view=new SessionPresentation(store);presentations.set(store,view);}
  return view;
}
