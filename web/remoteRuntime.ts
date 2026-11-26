/// <reference types="vite/client" />
import { RemoteSession } from "./remoteSession.ts";
import { protectHotSession } from "./hotSession.ts";
import { createHomeAssistantTransport } from "./homeAssistantTransport.ts";
/** HMR replaces views while preserving the client identity, release barrier,
 * cookie session, SSE subscription and confirmed preference revision. */
const haMode = new URLSearchParams(location.search).get("ha") === "1";
const bridge = haMode && !import.meta.hot?.data.port ? createHomeAssistantTransport() : undefined;
export const port: RemoteSession =
  import.meta.hot?.data.port ??
  new RemoteSession(
    bridge
      ? {
          base: new URL("/mech/api/v1/", location.origin).href,
          fetch: bridge.fetch,
          subscribeChanges: bridge.subscribeChanges,
        }
      : {},
  );
if (import.meta.hot?.data.port) {
  Object.setPrototypeOf(port, RemoteSession.prototype);
  port.adoptRetainedState();
}
if (!import.meta.hot?.data.port) {
  window.addEventListener("blur", () => port.handleWindowBlur(document.hidden));
  window.addEventListener("focus", () => void port.handleWindowFocus().catch(() => {}));
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) port.handleWindowBlur(true);
    else void port.handleWindowFocus().catch(() => {});
  });
  window.addEventListener("pagehide", () => port.suspend());
}
if (import.meta.hot) {
  import.meta.hot.data.port = port;
  protectHotSession(import.meta.hot, port);
  import.meta.hot.accept();
}
