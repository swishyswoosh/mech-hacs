import type { SafetyState } from "../session/types.ts";
export type Route =
  | "launch"
  | "home"
  | "cockpit"
  | "sounds"
  | "animations"
  | "lights"
  | "paths"
  | "experiences"
  | "settings"
  | "depot";
export type Destination = { panel: string; subpage?: string; group?: string };
export const destinations: Partial<Record<Route, Destination>> = {
  paths: { panel: "Paths & Patrol" },
  cockpit: { panel: "Fine Control", subpage: "Drive" },
  sounds: { panel: "Actions", group: "Sounds" },
  animations: { panel: "Actions", group: "Emote" },
  lights: { panel: "Fine Control", subpage: "Lights" },
  experiences: { panel: "Experiences" },
  settings: { panel: "Settings" },
  depot: { panel: "Diagnostics" },
};
/** Route changes cannot replace the transport or bypass an in-flight service exit. */
export class Navigator {
  route: Route = "launch";
  private busy = false;
  private generation = 0;
  private epoch = -1;
  private readyEpoch = -1;
  private state = "disconnected";
  private listeners = new Set<() => void>();
  private actions: {
    release: () => Promise<void>;
    leaveService: () => Promise<void>;
    onRoute?: (route: Route) => void;
  };
  constructor(actions: Navigator["actions"]) {
    this.actions = actions;
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.route;
  private publish(route: Route) {
    this.route = route;
    this.actions.onRoute?.(route);
    for (const listener of this.listeners) listener();
  }
  async go(route: Route): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    const generation = ++this.generation;
    try {
      await this.actions.release();
      if (generation !== this.generation) return false;
      // Service state, not only the visible route, determines whether exit is necessary.
      await this.actions.leaveService();
      if (generation !== this.generation) return false;
      this.publish(route);
      return true;
    } finally {
      this.busy = false;
    }
  }
  connection(state: string, epoch: number) {
    const changed = this.state !== state || this.epoch !== epoch;
    const newReady = ["ready", "paused"].includes(state) && this.readyEpoch !== epoch;
    if (newReady) this.readyEpoch = epoch;
    this.state = state;
    this.epoch = epoch;
    if (newReady) {
      this.generation++;
      this.publish("home");
    } else if (
      changed &&
      ["disconnected", "sleeping", "awaiting-restart"].includes(state)
    ) {
      this.generation++;
      this.publish("launch");
    }
  }
}
export function statusLabel(state: SafetyState, activity: string): string {
  switch (state) {
    case "ready-disarmed":
      return "READY";
    case "armed":
      return "ARMED";
    case "busy":
      return `BUSY${activity ? " · " + activity.toUpperCase() : ""}`;
    case "paused":
      return "PAUSED";
    case "stopping":
      return "STOPPING";
    case "failed":
      return "ERROR";
    case "connecting":
      return "CONNECTING";
    default:
      return "OFFLINE";
  }
}
