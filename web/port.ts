import { DroidSession } from "../app/session/DroidSession.ts";
import { DESKTOP_DROID_ID, DesktopBleTransport } from "../core/transports/desktopBridge.ts";
import { BrowserBleTransport, parseServiceUuids } from "../core/transports/webBluetooth.ts";
import type { ConnectionOwnership } from "./ownershipLock.ts";
import { BrowserConnectionLock } from "./ownershipLock.ts";
import { browserBatteryProfilingStorage } from "./batteryStorage.ts";
import { browserPreferenceStorage } from "./preferenceStorage.ts";
/** Browser wiring only. All control state and safety work lives in DroidSession. */
export class WebPort extends DroidSession {
  // A physical droid can be authorized through both Chrome and the desktop
  // bridge. Deduplication preserves the currently selected transport ID.
  // This method also replaces discovery on retained sessions after a hot update;
  // no constructor, permission revocation or transport replacement is needed.
  override async authorizedDroids() {
    const [droids, desktop] = await Promise.all([
      BrowserBleTransport.authorizedDroids().catch(() => []),
      DesktopBleTransport.droidStatus(),
    ]);
    if (!desktop.available) return droids;
    const native = {
      id: DESKTOP_DROID_ID,
      name: `${desktop.droid?.name ?? "Find R2"} (Desktop Bluetooth)`,
    };
    const hardwareName = desktop.droid?.name.trim().toUpperCase();
    const matches = /^D2-[0-9A-F]{4}$/.test(hardwareName ?? "")
      ? droids.filter((droid) => droid.name.trim().toUpperCase() === hardwareName)
      : [];
    // Generic aliases and ambiguous names do not establish a shared identity.
    if (matches.length !== 1) return [...droids, native];
    const match = matches[0];
    const selected = this.store.getSnapshot().connection.droidId === match.id ? match : native;
    return droids.map((droid) => (droid.id === match.id ? selected : droid));
  }
  constructor(
    options: {
      disconnectStopTimeoutMs?: number;
      attitudeTelemetry?: boolean;
      ownership?: ConnectionOwnership;
    } = {},
  ) {
    super({
      attitudeTelemetry: options.attitudeTelemetry ?? false,
      disconnectStopTimeoutMs: options.disconnectStopTimeoutMs,
      initialDetail:
        globalThis.isSecureContext && globalThis.navigator?.bluetooth
          ? "Choose a droid to begin."
          : "Web Bluetooth requires Chrome on HTTPS or localhost.",
      batteryProfilingStorage: browserBatteryProfilingStorage(
        {
          getItem: (key) => localStorage.getItem(key),
          setItem: (key, value) => localStorage.setItem(key, value),
        },
        globalThis.navigator?.locks,
      ),
      preferences: browserPreferenceStorage({
        getItem: (key) => localStorage.getItem(key),
        setItem: (key, value) => localStorage.setItem(key, value),
      }),
      hooks: { ownership: options.ownership ?? new BrowserConnectionLock() },
      factory: {
        validateServices: (services) => parseServiceUuids(services.join(",")),
        open: async ({ services, authorizedId, onDisconnect, selection }) => {
          selection(authorizedId === undefined);
          const transport =
            authorizedId === DESKTOP_DROID_ID
              ? await DesktopBleTransport.attach(onDisconnect)
              : authorizedId === undefined
                ? await BrowserBleTransport.choose(services, onDisconnect)
                : await BrowserBleTransport.reconnect(authorizedId, onDisconnect);
          const droid =
            transport instanceof BrowserBleTransport
              ? transport.droid
              : {
                  id: authorizedId,
                  name:
                    transport instanceof DesktopBleTransport
                      ? (transport.droid?.name ?? "R2 (Desktop Bluetooth)")
                      : undefined,
                };
          return {
            transport,
            ...droid,
            hardwareId: transport instanceof DesktopBleTransport ? transport.droid?.id : undefined,
          };
        },
      },
    });
  }
}
