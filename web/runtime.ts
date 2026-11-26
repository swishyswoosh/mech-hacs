/// <reference types="vite/client" />
import { adoptRetainedDroidSession } from "./retainedDroidSession.ts";
import { protectHotSession } from "./hotSession.ts";
import { WebPort } from "./port.ts";
import { SessionActivity } from "../app/session/Activity.ts";
import { requestId } from "./requestId.ts";
/** Dev UI updates reuse the live session and its original lifecycle listeners. */
export const port: WebPort = import.meta.hot?.data.port ?? new WebPort({ attitudeTelemetry: true });
if (import.meta.hot?.data.port) {
  // Updating methods on the retained instance preserves transport, timers and
  // stores while applying the new session policy to hot UI changes.
  Object.setPrototypeOf(port, WebPort.prototype);
  Object.setPrototypeOf(port.activity, SessionActivity.prototype);
  adoptRetainedDroidSession(port);
  // beforeUpdate/dispose already requested the safety STOP. Adoption waits for
  // that same barrier and refuses a failed stop; it never creates a transport.
  void port
    .adoptControllerRuntimePolicy()
    .catch((error) => console.error("Retained controller policy adoption failed", error));
}
port.enableAttitudeTelemetry();
port.ensureTelemetryPolicy();
port.ensureConnectionMaintenance?.();
if (!import.meta.hot?.data.port) {
  window.addEventListener("blur", () => port.handleWindowBlur(document.hidden));
  window.addEventListener("focus", () => void port.handleWindowFocus());
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) port.handleWindowBlur(true);
    else void port.handleWindowFocus();
  });
  window.addEventListener("pagehide", () => port.suspend());
}
if (import.meta.hot) {
  import.meta.hot.data.port = port;
  protectHotSession(import.meta.hot, port);
  // Development evidence: a new id/epoch exposes replacement instead of hiding
  // it behind a successful reconnect. No transport commands are issued here.
  const id = (import.meta.hot.data.sessionId ??= requestId());
  const report = (event: string) =>
    console.debug(
      "[r2-session]",
      JSON.stringify({
        event,
        id,
        epoch: port.store.getSnapshot().connection.epoch,
        state: port.store.getSnapshot().state,
      }),
    );
  report("runtime");
  import.meta.hot.on("vite:beforeUpdate", () => report("before-update"));
  import.meta.hot.on("vite:afterUpdate", () => report("after-update"));
  import.meta.hot.dispose(() => port.handleWindowBlur(true));
  import.meta.hot.accept();
}
