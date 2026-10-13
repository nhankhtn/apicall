// Minimal service worker: makes the app installable. No offline cache; pages always come from
// the network (navigations revalidated) and /api/* is never touched.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  const request = event.request.mode === 'navigate' ? new Request(event.request, { cache: 'no-cache' }) : event.request;
  event.respondWith(fetch(request));
});
