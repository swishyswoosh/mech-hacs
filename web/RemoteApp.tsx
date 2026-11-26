import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ControllerApp } from '../app/App.tsx';
import type { RemoteSession } from './remoteSession.ts';

type ViewScope = {
    port: RemoteSession;
    active: boolean;
    action: number;
};

/** Remote authentication and droid selection wrap the shared controller screens. */
export function RemoteApp({ port, ControllerComponent, homeAssistant = false }: {
    port: RemoteSession;
    ControllerComponent: typeof ControllerApp;
    homeAssistant?: boolean;
}) {
    const snapshot = useSyncExternalStore(port.store.subscribe, port.store.getSnapshot);
    const [status, setStatus] = useState<'loading' | 'login' | 'ready'>('loading');
    const [token, setToken] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [droids, setDroids] = useState<Array<{ id: string; name: string }>>([]);
    const [selected, setSelected] = useState('');
    const view = useRef<ViewScope | undefined>(undefined);

    const beginAction = () => {
        const scope = view.current;
        if (!scope?.active || scope.port !== port) return;
        const action = ++scope.action;
        return () => scope.active && view.current === scope && scope.action === action;
    };
    const load = async (current: () => boolean) => {
        await port.initialize();
        if (!current()) return;
        const items = await port.authorizedDroids();
        if (!current()) return;
        setDroids(items);
        if (items.length) {
            const retainedId = port.store.getSnapshot().connection.droidId;
            const next = items.find(droid => droid.id === retainedId) ?? items[0];
            await port.selectDroid(next.id);
            if (!current()) return;
            setSelected(next.id);
        }
        setStatus('ready');
        port.start();
    };
    const loadFailed = (current: () => boolean, error: unknown) => {
        if (!current()) return;
        setError(String(error));
        setStatus('login');
    };
    useEffect(() => {
        const scope: ViewScope = { port, active: true, action: 0 };
        view.current = scope;
        setStatus('loading');
        setError('');
        setBusy(false);
        setToken('');
        setDroids([]);
        setSelected('');
        const current = beginAction()!;
        void load(current).catch(error => loadFailed(current, error));
        return () => {
            // Only this view's continuations expire; the retained session owns its connection.
            scope.active = false;
        };
    }, [port]);

    const login = async (event: React.FormEvent) => {
        event.preventDefault();
        const current = beginAction();
        if (!current) return;
        setBusy(true);
        setError('');
        try {
            await port.login(token);
            if (!current()) return;
            setToken('');
            await load(current);
        } catch (error) {
            if (current()) setError(String(error));
        } finally {
            if (current()) setBusy(false);
        }
    };
    const retry = () => {
        const current = beginAction();
        if (!current) return;
        setStatus('loading');
        setError('');
        void load(current).catch(error => loadFailed(current, error));
    };
    const selectDroid = async (id: string) => {
        const current = beginAction();
        if (!current) return;
        setError('');
        try {
            await port.selectDroid(id);
            if (current()) setSelected(id);
        } catch (error) {
            if (current()) setError(String(error));
        }
    };
    const logout = async () => {
        const current = beginAction();
        if (!current) return;
        setBusy(true);
        try {
            const note = await port.logout();
            if (current()) setError(note ?? '');
        } catch (error) {
            if (current()) setError(String(error));
        } finally {
            if (current()) {
                setBusy(false);
                setStatus('login');
            }
        }
    };

    if (status === 'loading')
        return <main style={{ padding: 24 }}>Connecting to {homeAssistant ? 'Home Assistant' : 'local service'}…</main>;
    if (status === 'login' && homeAssistant)
        return <main style={{ padding: 24 }}>
            <h1>Home Assistant connection unavailable</h1>
            <p role="alert">{error}</p>
            <button onClick={retry}>Retry connection</button>
        </main>;
    if (status === 'login')
        return <main style={{
            maxWidth: 420, margin: '10vh auto', padding: 24, color: '#eee', fontFamily: 'sans-serif'
        }}>
            <h1>Mech local service</h1>
            <p>Sign in to use your enrolled droids.</p>
            <form onSubmit={login} style={{ display: 'grid', gap: 12 }}>
                <label htmlFor="service-token">Service access token</label>
                <input id="service-token" type="password" autoComplete="current-password"
                    value={token} onChange={event => setToken(event.target.value)} required
                    style={{ padding: 12, fontSize: 16 }}/>
                <button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
            </form>
            {error && <p role="alert">{error}</p>}
        </main>;
    return <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
        <div style={{
            display: 'flex', gap: 12, alignItems: 'center', padding: '4px 12px',
            background: '#171c25', color: '#ddd', font: '12px sans-serif', flexWrap: 'wrap'
        }}>
            <span>{homeAssistant ? 'Home Assistant' : 'Local service'}{port.motionAvailable ? '' : ' · motion unavailable'}</span>
            {droids.length > 1 && <label>Selected droid <select value={selected} disabled={busy}
                onChange={event => void selectDroid(event.target.value)}>
                {droids.map(droid => <option key={droid.id} value={droid.id}>{droid.name}</option>)}
            </select></label>}
            {!homeAssistant && <button disabled={busy} onClick={() => void logout()}>Sign out</button>}
            {error && <span role="alert">{error}</span>}
        </div>
        {droids.length
            ? <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}><ControllerComponent key={snapshot.connection.droidId} port={port}/></div>
            : <main style={{ padding: 24 }}>No enrolled droids are available for this account.</main>}
    </div>;
}
