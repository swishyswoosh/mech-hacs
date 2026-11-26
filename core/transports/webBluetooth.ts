import type { BleTransport, CharacteristicRef } from "../index.ts";

export const DEFAULT_SERVICES = [
  "00010001-574f-4f20-5370-6865726f2121",
  "00020001-574f-4f20-5370-6865726f2121",
];

export function parseServiceUuids(text: string): string[] {
  const services = [
    ...new Set(
      text
        .split(/[\s,]+/)
        .filter(Boolean)
        .map((s) => s.toLowerCase()),
    ),
  ];
  if (!services.length) {
    throw new Error("Enter the actual containing service UUIDs before choosing a droid.");
  }
  if (
    services.some((s) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s))
  ) {
    throw new Error("Each service must be a full 128-bit UUID.");
  }
  return services;
}

/** Browser permissions require containing service UUIDs, unlike native discovery. */
export class BrowserBleTransport implements BleTransport {
  private static sessionDroids = new Map<string, BluetoothDevice>();
  private device: BluetoothDevice;
  private characteristics = new Map<string, BluetoothRemoteGATTCharacteristic>();
  private tail: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private disposed = false;
  private disconnectPromise?: Promise<void>;
  private connecting = new Set<Promise<BluetoothRemoteGATTServer>>();
  private cleanups = new Set<() => void>();
  private subscriptions = new Map<BluetoothRemoteGATTCharacteristic, Set<() => void>>();

  constructor(device: BluetoothDevice) {
    this.device = device;
  }

  get droid(): { id: string; name: string } {
    return { id: this.device.id, name: this.device.name || "Unnamed Bluetooth droid" };
  }

  private static async knownDevices(): Promise<BluetoothDevice[]> {
    if (!globalThis.isSecureContext || !navigator.bluetooth) {
      throw new Error("Use Chrome with Web Bluetooth on HTTPS or localhost.");
    }
    // Chrome configurations without getDevices can still retain a device the user
    // explicitly selected during this page session. GATT enforces its permission.
    if (!navigator.bluetooth.getDevices) return [...this.sessionDroids.values()];
    const devices = await navigator.bluetooth.getDevices();
    this.sessionDroids = new Map(devices.map((device) => [device.id, device]));
    return devices;
  }
  static async authorizedDroids(): Promise<Array<{ id: string; name: string }>> {
    return (await this.knownDevices()).map((device) => ({
      id: device.id,
      name: device.name || "Unnamed Bluetooth droid",
    }));
  }
  static async reconnect(id: string, onDisconnect: () => void): Promise<BrowserBleTransport> {
    const device = (await this.knownDevices()).find((device) => device.id === id);
    if (!device) {
      throw new Error(
        "This droid is no longer authorized. Use Choose droid to grant access again.",
      );
    }
    return this.attach(device, onDisconnect);
  }
  private static attach(device: BluetoothDevice, onDisconnect: () => void): BrowserBleTransport {
    device.addEventListener("gattserverdisconnected", onDisconnect);
    const transport = new BrowserBleTransport(device);
    transport.cleanups.add(() =>
      device.removeEventListener("gattserverdisconnected", onDisconnect),
    );
    return transport;
  }
  static async choose(services: string[], onDisconnect: () => void): Promise<BrowserBleTransport> {
    if (!globalThis.isSecureContext || !navigator.bluetooth) {
      throw new Error("Use Chrome with Web Bluetooth on HTTPS or localhost.");
    }
    const device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [...new Set([...DEFAULT_SERVICES, ...services])],
    });
    this.sessionDroids.set(device.id, device);
    return this.attach(device, onDisconnect);
  }
  private serial<T>(operation: (guard: () => void) => Promise<T>): Promise<T> {
    const generation = this.generation;
    const guard = () => {
      if (this.disposed || generation !== this.generation) {
        throw new Error("Operation canceled by emergency STOP or disconnect.");
      }
    };
    const next = this.tail.then(() => {
      guard();
      return operation(guard);
    });
    this.tail = next.catch(() => {});
    return next;
  }
  private lookup(ref: CharacteristicRef) {
    const characteristic = this.characteristics.get(`${ref.service}/${ref.characteristic}`);
    if (!characteristic) throw new Error(`Characteristic unavailable: ${ref.characteristic}`);
    return characteristic;
  }
  private guardDiscovery(
    generation: number,
    server?: BluetoothRemoteGATTServer,
    closeLateConnection = false,
  ) {
    if (this.disposed || generation !== this.generation) {
      if (closeLateConnection) {
        server?.disconnect();
        this.device.gatt?.disconnect();
      }
      throw new Error("Bluetooth discovery canceled by disconnect.");
    }
  }
  async discover(): Promise<CharacteristicRef[]> {
    const generation = this.generation;
    return this.serial(async () => {
      this.guardDiscovery(generation);
      const pending = this.device.gatt?.connect();
      if (!pending) throw new Error("No GATT server.");
      this.connecting.add(pending);
      let server: BluetoothRemoteGATTServer;
      try {
        server = await pending;
      } finally {
        this.connecting.delete(pending);
      }
      // Only a late connect can establish a new GATT link after teardown. Late
      // service/characteristic results must be ignored without touching a newer link.
      this.guardDiscovery(generation, server, true);
      const services = await server.getPrimaryServices();
      this.guardDiscovery(generation, server);
      this.characteristics.clear();
      const refs: CharacteristicRef[] = [];
      for (const service of services) {
        const characteristics = await service.getCharacteristics();
        this.guardDiscovery(generation, server);
        for (const characteristic of characteristics) {
          const ref = {
            service: service.uuid.toLowerCase(),
            characteristic: characteristic.uuid.toLowerCase(),
          };
          refs.push(ref);
          this.characteristics.set(`${ref.service}/${ref.characteristic}`, characteristic);
        }
      }
      return refs;
    });
  }
  read(ref: CharacteristicRef): Promise<Uint8Array> {
    return this.serial(async (guard) => {
      const value = await this.lookup(ref).readValue();
      guard();
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
    });
  }
  write(ref: CharacteristicRef, bytes: Uint8Array, withResponse: boolean): Promise<void> {
    return this.serial(async (guard) => {
      const characteristic = this.lookup(ref);
      for (let offset = 0; offset < bytes.length; offset += 20) {
        const chunk = new Uint8Array(bytes.slice(offset, offset + 20));
        if (withResponse || offset + 20 >= bytes.length)
          await characteristic.writeValueWithResponse(chunk);
        else await characteristic.writeValueWithoutResponse(chunk);
        // Native writes cannot be canceled. A stale completion cannot advance the
        // chunk sequence or report success after STOP/disconnect supersedes it.
        guard();
      }
    });
  }
  subscribe(ref: CharacteristicRef, callback: (bytes: Uint8Array) => void): Promise<() => void> {
    return this.serial(async (guard) => {
      const characteristic = this.lookup(ref);
      let subscribers = this.subscriptions.get(characteristic);
      const firstSubscriber = !subscribers;
      if (!subscribers) {
        subscribers = new Set();
        this.subscriptions.set(characteristic, subscribers);
      }
      let active = true;
      const listener = (event: Event) => {
        if (!active || this.disposed) return;
        const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
        if (value)
          callback(new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice());
      };
      const cleanup = () => {
        if (!active) return false;
        active = false;
        characteristic.removeEventListener("characteristicvaluechanged", listener);
        this.cleanups.delete(cleanup);
        subscribers.delete(cleanup);
        if (!subscribers.size) this.subscriptions.delete(characteristic);
        return true;
      };
      const stopWhenUnused = () => {
        void this.serial(async () => {
          if (!this.subscriptions.has(characteristic) && this.device.gatt?.connected) {
            await characteristic.stopNotifications();
          }
        }).catch(() => {});
      };
      characteristic.addEventListener("characteristicvaluechanged", listener);
      subscribers.add(cleanup);
      // Cleanup exists before native startup yields, so disconnect can remove the
      // listener while startNotifications is still pending.
      this.cleanups.add(cleanup);
      let started = false;
      try {
        if (firstSubscriber) {
          await characteristic.startNotifications();
          started = true;
        }
        guard();
      } catch (error) {
        cleanup();
        if (started && !this.disposed) stopWhenUnused();
        throw error;
      }
      return () => {
        // Each unsubscribe owns its listener; repeats cannot stop a replacement.
        if (cleanup()) stopWhenUnused();
      };
    });
  }
  async priorityWrite(ref: CharacteristicRef, frames: Uint8Array[]): Promise<void> {
    return this.emergencyWrite(ref, frames);
  }

  async emergencyWrite(ref: CharacteristicRef, frames: Uint8Array[]): Promise<void> {
    this.generation++;
    return this.serial(async (guard) => {
      const characteristic = this.lookup(ref);
      for (const frame of frames) {
        for (let offset = 0; offset < frame.length; offset += 20) {
          await characteristic.writeValueWithResponse(
            new Uint8Array(frame.slice(offset, offset + 20)),
          );
          guard();
        }
      }
    });
  }
  disconnect(): Promise<void> {
    // Repeated teardown shares the original close without touching a replacement link.
    this.disconnectPromise ??= this.close();
    return this.disconnectPromise;
  }

  private async close(): Promise<void> {
    this.disposed = true;
    this.generation++;
    for (const cleanup of [...this.cleanups]) cleanup();
    this.characteristics.clear();
    this.device.gatt?.disconnect();
    // A browser may finish connect() after disconnect(). Ownership remains held
    // until the pending connect settles and its late link is closed.
    await Promise.allSettled([...this.connecting]);
    this.device.gatt?.disconnect();
  }
}
