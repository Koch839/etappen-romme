// Offline-Speicher und Updates für Etappen-Rommé.
// Bei JEDER neuen Version die Versionsnummer erhöhen (und in app.js APP_VERSION).
// Die App merkt die neue Version dann von selbst und bietet „Jetzt aktualisieren“ an.
const VERSION = '1.4.0';
const CACHE = 'etappen-' + VERSION;
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './app.css',
  './manifest.webmanifest',
  './fonts/bungee-latin.woff2',
  './fonts/figtree-latin.woff2',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png'
];

self.addEventListener('install', e => {
  // Alles frisch vom Server holen (nicht aus dem HTTP-Cache), damit die Version zusammenpasst
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' })))));
  // Kein skipWaiting hier: die neue Version wartet, bis der Nutzer „Jetzt aktualisieren“ tippt
});

self.addEventListener('message', e => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('etappen-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // fremde Server nie anfassen
  if (url.pathname.endsWith('/sw.js')) return;

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const key = req.mode === 'navigate' ? './index.html' : req;
    const hit = await cache.match(key, { ignoreSearch: true });
    if (hit) return hit;
    try {
      return await fetch(req);
    } catch (err) {
      if (req.mode === 'navigate') return cache.match('./index.html');
      throw err;
    }
  })());
});
