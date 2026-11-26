import type { BleTransport, CharacteristicRef } from '../controller.ts';
const endpoint = 'http://127.0.0.1:5180';
export const DESKTOP_DROID_ID = 'desktop:last';
export type DesktopDroid = { id: string; name: string };
const encode = (bytes: Uint8Array) => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''));
const decode = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
/** Local CoreBluetooth transport; the same shared controller performs every
 * initialization, response match, capability check, and motion gate. */
export class DesktopBleTransport implements BleTransport {
    droid?: DesktopDroid;
    private discovered?: CharacteristicRef[];
    private disconnecting?: Promise<void>;
    private session = '';
    private events?: EventSource;
    private closed = false;
    private generation = 0;
    private listeners = new Map<string, Set<(bytes: Uint8Array) => void>>();
    private tail: Promise<unknown> = Promise.resolve();
    private onDisconnect: () => void;
    private constructor(onDisconnect: () => void) {
        this.onDisconnect = onDisconnect;
    }
    static async droidStatus(): Promise<{ available: boolean; droid?: DesktopDroid }> {
        if (!['127.0.0.1', 'localhost'].includes(globalThis.location?.hostname ?? '')) return { available: false };
        try {
            const response = await fetch(endpoint + '/status', { signal: AbortSignal.timeout(800) });
            const body = await response.json();
            // Existing bridge processes retain their legacy wire format until next launch.
            const identity = body.droid ?? body.robot;
            const droid =
                identity && typeof identity.id === 'string' && typeof identity.name === 'string'
                    ? { id: identity.id, name: identity.name }
                    : undefined;
            return { available: response.ok && body.available === true, ...(droid ? { droid } : {}) };
        } catch {
            return { available: false };
        }
    }
    static async available() {
        return (await this.droidStatus()).available;
    }
    static async attach(onDisconnect: () => void) {
        const transport = new DesktopBleTransport(onDisconnect);
        const response = await fetch(endpoint + '/session', { method: 'POST', signal: AbortSignal.timeout(10000) });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Desktop Bluetooth unavailable');
        transport.session = body.session;
        try {
            await new Promise<void>((resolve, reject) => {
                const events = (transport.events = new EventSource(endpoint + '/events?session=' + encodeURIComponent(transport.session)));
                const timer = setTimeout(() => {
                    reject(new Error('Desktop Bluetooth event stream timed out'));
                }, 5000);
                events.onmessage = (event) => {
                    const message = JSON.parse(event.data);
                    if (message.event === 'ready') {
                        clearTimeout(timer);
                        resolve();
                    } else if (
                        ['droid', 'robot'].includes(message.event) &&
                        typeof message.id === 'string' &&
                        typeof message.name === 'string'
                    ) {
                        transport.droid = { id: message.id, name: message.name };
                    } else if (message.event === 'disconnected') {
                        clearTimeout(timer);
                        reject(new Error('Desktop Bluetooth connection lost'));
                        transport.lost();
                    } else if (message.event === 'notification') {
                        for (const listener of transport.listeners.get(message.key) ?? []) listener(decode(message.data));
                    }
                };
                events.onerror = () => {
                    clearTimeout(timer);
                    reject(new Error('Desktop Bluetooth connection lost'));
                    transport.lost();
                };
            });
            await transport.discover();
            const status = await this.droidStatus();
            if (transport.closed) throw new Error('Desktop Bluetooth connection lost');
            if (status.droid) transport.droid = status.droid;
            return transport;
        } catch (error) {
            await transport.disconnect();
            throw error;
        }
    }
    private lost() {
        if (this.closed) return;
        this.closed = true;
        this.events?.close();
        this.listeners.clear();
        this.onDisconnect();
    }
    private async rpc<T>(method: string, args: Record<string, unknown> = {}, closing = false): Promise<T> {
        if (this.closed && !closing) throw new Error('Desktop Bluetooth connection closed');
        const response = await fetch(endpoint + '/rpc?session=' + encodeURIComponent(this.session), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ method, ...args }),
            signal: AbortSignal.timeout(10000),
        });
        const body = await response.json();
        // A successful HTTP reply may arrive after the event stream has reported loss.
        if (this.closed && !closing) throw new Error('Desktop Bluetooth connection closed');
        if (!response.ok || body.error) throw new Error(body.error || 'Desktop Bluetooth operation failed');
        return body.result as T;
    }
    private serial<T>(operation: () => Promise<T>) {
        const generation = this.generation;
        const work = this.tail.then(() => {
            if (this.closed || generation !== this.generation) throw new Error('Desktop Bluetooth operation canceled');
            return operation();
        });
        this.tail = work.catch(() => {});
        return work;
    }
    discover() {
        return this.serial(async () => this.discovered ?? (this.discovered = await this.rpc<CharacteristicRef[]>('discover')));
    }
    read(ref: CharacteristicRef) {
        return this.serial(async () => decode(await this.rpc<string>('read', { ref })));
    }
    write(ref: CharacteristicRef, data: Uint8Array, _withResponse: boolean) {
        return this.serial(() => this.rpc<void>('write', { ref, data: encode(data) }));
    }
    async subscribe(ref: CharacteristicRef, listener: (bytes: Uint8Array) => void) {
        const key = `${ref.service}/${ref.characteristic}`;
        await this.serial(async () => {
            let listeners = this.listeners.get(key);
            if (listeners) {
                listeners.add(listener);
                return;
            }
            listeners = new Set([listener]);
            this.listeners.set(key, listeners);
            try {
                await this.rpc<void>('subscribe', { ref });
            } catch (error) {
                this.listeners.delete(key);
                throw error;
            }
        });
        let subscribed = true;
        return () => {
            if (!subscribed) return;
            subscribed = false;
            const listeners = this.listeners.get(key);
            listeners?.delete(listener);
            if (listeners && !listeners.size) {
                this.listeners.delete(key);
                void this.serial(() => this.rpc<void>('unsubscribe', { ref })).catch(() => {});
            }
        };
    }
    emergencyWrite(ref: CharacteristicRef, frames: Uint8Array[]) {
        this.generation++;
        return this.serial(() => this.rpc<void>('emergency', { ref, frames: frames.map(encode) }));
    }
    priorityWrite(ref: CharacteristicRef, frames: Uint8Array[]) {
        return this.emergencyWrite(ref, frames);
    }
    disconnect(): Promise<void> {
        if (this.disconnecting) return this.disconnecting;
        if (this.closed) return Promise.resolve();
        this.closed = true;
        this.generation++;
        this.listeners.clear();
        // Every caller waits for the same native cleanup before releasing ownership.
        this.disconnecting = (async () => {
            try {
                await this.rpc('disconnect', {}, true);
            } finally {
                this.events?.close();
            }
        })();
        return this.disconnecting;
    }
}
