/** Registration is passive: no skipWaiting, claim, reload, or restored commands. */
export function registerControllerPwa(): void {
  if (!(import.meta as ImportMeta & { env: { PROD: boolean } }).env.PROD || !('serviceWorker' in navigator) || !isSecureContext) return;
  void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
}
