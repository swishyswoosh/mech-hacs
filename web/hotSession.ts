import type { ControllerSession } from '../app/session/ControllerSession.ts';

type HotEvents = { on(event: string, listener: () => void | Promise<void>): unknown };
/** Cancel reload events without holding Vite's serialized message queue.
 * A synchronous listener throw aborts Vite's notifyListeners before it reaches
 * Promise.allSettled; returning a rejected promise would NOT prevent reload.
 * This contract is tested against the installed Vite client implementation. */
export function protectHotSession(hot: HotEvents, session: ControllerSession, focused = () => !document.hidden && document.hasFocus()) {
  const disconnected = () => session.store.getSnapshot().state === 'disconnected';
  hot.on('vite:beforeUpdate', () => session.handleWindowBlur(true));
  hot.on('vite:afterUpdate', async () => {
    if (focused()) await session.handleWindowFocus();
  });
  const cancelReload = () => {
    if (disconnected()) return;
    session.handleWindowBlur(true);
    console.info('Controller reload cancelled: droid connection retained; later UI updates remain available.');
    const error=new Error('Reload cancelled while the droid session is retained.');
    error.name='RetainedSessionReload';
    throw error;
  };
  hot.on('vite:beforeFullReload', cancelReload);
  hot.on('vite:ws:disconnect', cancelReload);
}
