import { requestId } from './requestId.ts';
/** Same-origin parent HA websocket bridge. Credentials never enter this frame. */
export function createHomeAssistantTransport(host: Window = window) {
    const origin = host.location.origin,
        parent = host.parent;
    if (parent === host) throw Error('Open this controller from the Home Assistant Mech panel.');
    type Pending = { resolve: (response: Response) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
    const pending = new Map<string, Pending>();
    const polls = new Set<ReturnType<typeof setInterval>>();
    let closed = false;
    const receive = (event: MessageEvent) => {
        if (event.origin !== origin || event.source !== parent || event.data?.type !== 'mech:response') return;
        const item = pending.get(event.data.id);
        if (!item) return;
        pending.delete(event.data.id);
        clearTimeout(item.timer);
        const value = event.data.response;
        if (!value || !Number.isInteger(value.status) || value.status < 200 || value.status > 599) {
            item.reject(Error('Invalid Home Assistant response'));
            return;
        }
        try {
            // Fetch forbids response bodies for these status codes, even if HA supplies one.
            const body = [204, 205, 304].includes(value.status) ? null : JSON.stringify(value.body);
            item.resolve(new Response(body, { status: value.status, headers: { 'Content-Type': 'application/json' } }));
        } catch {
            item.reject(Error('Invalid Home Assistant response'));
        }
    };
    host.addEventListener('message', receive);
    const fetcher: typeof fetch = async (input, init = {}) => {
        if (closed) throw Error('Home Assistant bridge closed');
        const url = new URL(input instanceof Request ? input.url : String(input), origin);
        const prefix = '/mech/api/v1/';
        if (url.origin !== origin || !url.pathname.startsWith(prefix) || url.search || url.hash)
            throw Error('Invalid Home Assistant request origin or path');
        const method = init.method ?? 'GET';
        if (!['GET', 'POST', 'PUT'].includes(method)) throw Error('Unsupported Home Assistant request method');
        const headers = new Headers(init.headers),
            key = headers.get('Idempotency-Key');
        const request = {
            path: url.pathname.slice(prefix.length),
            method,
            ...(key ? { key } : {}),
            ...(init.body === undefined ? {} : { body: JSON.parse(String(init.body)) }),
        };
        const id = requestId();
        return await new Promise<Response>((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(Error('Home Assistant request timed out; operation was not replayed.'));
            }, 45000);
            pending.set(id, { resolve, reject, timer });
            parent.postMessage({ type: 'mech:request', id, request }, origin);
        });
    };
    return {
        fetch: fetcher,
        // Cached HA reads only. Polling neither starts discovery nor touches the droid.
        subscribeChanges: (changed: () => void) => {
            if (closed) return () => {};
            const timer = setInterval(changed, 1000);
            polls.add(timer);
            return () => {
                clearInterval(timer);
                polls.delete(timer);
            };
        },
        close: () => {
            closed = true;
            for (const timer of polls) clearInterval(timer);
            polls.clear();
            host.removeEventListener('message', receive);
            for (const item of pending.values()) {
                clearTimeout(item.timer);
                item.reject(Error('Home Assistant bridge closed'));
            }
            pending.clear();
        },
    };
}
