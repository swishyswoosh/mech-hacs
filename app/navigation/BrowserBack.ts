interface BackHost {
  history: {
    state: unknown;
    pushState(value: unknown, title: string, url?: string): void;
  };
  addEventListener(type: "popstate", listener: () => void): void;
  removeEventListener(type: "popstate", listener: () => void): void;
}
/** A browser back gesture stays in this document, so it cannot close the comlink. */
export function installHomeBack(host: BackHost, home: () => void) {
  const guard = () => host.history.pushState({ r2ControllerGuard: true }, "");
  if (
    !(host.history.state as { r2ControllerGuard?: boolean } | null)
      ?.r2ControllerGuard
  )
    guard();
  const back = () => {
    guard();
    home();
  };
  host.addEventListener("popstate", back);
  return () => host.removeEventListener("popstate", back);
}
