/* Deliberately cache only passive offline help and install assets.
 * The live controller document, bundles and bridge traffic stay network-only.
 * Waiting updates never claim or reload a running Bluetooth controller. */
const cacheName = 'r2-install-v1';
const passiveAssets = ['/offline.html', '/r2-icon.svg', '/manifest.webmanifest'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(passiveAssets)));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key.startsWith('r2-install-') && key !== cacheName).map(key => caches.delete(key)),
  )));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/offline.html')));
  } else if (passiveAssets.includes(url.pathname)) {
    event.respondWith(fetch(request).catch(() => caches.match(url.pathname)));
  }
});
