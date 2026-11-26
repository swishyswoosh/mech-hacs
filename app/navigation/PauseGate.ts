import type { ControllerSession } from "../session/ControllerSession.ts";
/** A safety gate: successful focus-stop completion restores fresh input, never motion. */
export class PauseGate {
  private held = false;
  private listeners = new Set<() => void>();
  private session: ControllerSession;
  private unsubscribe: () => void;
  constructor(session: ControllerSession) {
    this.session = session;
    const observe = () => {
      const snapshot = session.store.getSnapshot();
      if (snapshot.state === "paused" || snapshot.state === "failed") this.set(true);
      else if (snapshot.safety.canControl || ["disconnected", "sleeping"].includes(snapshot.state)) this.set(false);
    };
    this.unsubscribe = session.store.subscribe(observe);
    observe();
  }
  private set(value: boolean) {
    if (this.held === value) return;
    this.held = value;
    for (const listener of this.listeners) listener();
  }
  getSnapshot = () => this.held;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  async resume() {
    await this.session.handleWindowFocus();
    if (!this.session.store.getSnapshot().safety.canControl)
      throw new Error(
        "STOP has not completed successfully. Controls remain paused.",
      );
    this.set(false);
  }
  dispose() {
    this.unsubscribe();
    this.listeners.clear();
  }
}

const pauseKey = Symbol.for("r2-controller.ui-pause-gate");
/** The owner is the live session, never the mounted React tree or hot module. */
export function pauseGateFor(session: ControllerSession): PauseGate {
  const owner = session as ControllerSession & Record<symbol, PauseGate | undefined>;
  const previous = owner[pauseKey];
  // Replace only the UI observer when its module changes. The ControllerSession,
  // transport, pending stop and motion-arm state remain owned by the session.
  if (previous && Object.getPrototypeOf(previous) !== PauseGate.prototype) {
    previous.dispose();
    owner[pauseKey] = undefined;
  }
  return owner[pauseKey] ?? (owner[pauseKey] = new PauseGate(session));
}
