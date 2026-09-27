/* ═══════════════════════════════════════════════════════════
   Account Tracker — Service Worker
   Strategy:
   - App Shell & CDN libraries → Cache First (fast load, offline)
   - HTML page → Network First (fresh updates)
   - Firebase APIs (auth/firestore) → Network Only (never cache)
   - Google Fonts → Stale While Revalidate
   ═══════════════════════════════════════════════════════════ */

const CACHE_VERSION = 'v1.0.0';
const CACHE_SHELL   = `at-shell-${CACHE_VERSION}`;
const CACHE_CDN     = `at-cdn-${CACHE_VERSION}`;
const CACHE_FONTS   = `at-fonts-${CACHE_VERSION}`;
const CACHE_RUNTIME = `at-runtime-${CACHE_VERSION}`;

/* App shell — precached on install */
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json'
];

/* CDN libraries used by the app — cached on first use */
const CDN_HOSTS = [
  'www.gstatic.com',
  'cdnjs.cloudflare.com'
];

/* Font hosts */
const FONT_HOSTS = [
  'fonts.googleapis.com',
  'fonts.gstatic.com'
];

/* Never cache these (auth/firestore/realtime) */
const BYPASS_HOSTS = [
  'firestore.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
  'firebaseio.com',
  'firebasestorage.googleapis.com',
  'firebaseinstallations.googleapis.com'
];

/* ── INSTALL ─────────────────────────────────────────────── */
self.addEventListener('install', (event) => {
  console.log('[SW] Installing', CACHE_VERSION);
  event.waitUntil(
    caches.open(CACHE_SHELL)
      .then((cache) => cache.addAll(SHELL_ASSETS).catch(err => {
        console.warn('[SW] Precache partial failure:', err);
      }))
      .then(() => self.skipWaiting())
  );
});

/* ── ACTIVATE ────────────────────────────────────────────── */
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating', CACHE_VERSION);
  const KEEP = [CACHE_SHELL, CACHE_CDN, CACHE_FONTS, CACHE_RUNTIME];
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.map((name) => {
          if (!KEEP.includes(name)) {
            console.log('[SW] Deleting old cache:', name);
            return caches.delete(name);
          }
        })
      ))
      .then(() => self.clients.claim())
  );
});

/* ── FETCH ───────────────────────────────────────────────── */
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only handle GET
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 1) Firebase APIs → Network Only (never cache)
  if (BYPASS_HOSTS.some(h => url.hostname.includes(h))) {
    return; // let browser handle normally
  }

  // 2) Firebase SDK / CDN libraries → Cache First
  if (CDN_HOSTS.some(h => url.hostname.includes(h))) {
    event.respondWith(cacheFirst(req, CACHE_CDN));
    return;
  }

  // 3) Google Fonts → Stale While Revalidate
  if (FONT_HOSTS.some(h => url.hostname.includes(h))) {
    event.respondWith(staleWhileRevalidate(req, CACHE_FONTS));
    return;
  }

  // 4) Navigation requests (HTML) → Network First
  if (req.mode === 'navigate' ||
      (req.headers.get('accept') || '').includes('text/html')) {
    event.respondWith(networkFirst(req, CACHE_SHELL));
    return;
  }

  // 5) Same-origin static assets → Cache First w/ runtime
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(req, CACHE_RUNTIME));
    return;
  }

  // 6) Anything else → Network with cache fallback
  event.respondWith(
    fetch(req).catch(() => caches.match(req))
  );
});

/* ── STRATEGIES ──────────────────────────────────────────── */

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const resp = await fetch(req);
    if (resp && (resp.ok || resp.type === 'opaque')) {
      cache.put(req, resp.clone()).catch(() => {});
    }
    return resp;
  } catch (err) {
    // Offline fallback
    const fallback = await cache.match(req);
    if (fallback) return fallback;
    return new Response('Offline — resource not cached', {
      status: 503,
      statusText: 'Offline',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const resp = await fetch(req);
    if (resp && resp.ok) {
      cache.put(req, resp.clone()).catch(() => {});
    }
    return resp;
  } catch (err) {
    const cached = await cache.match(req);
    if (cached) return cached;
    // Fallback to cached shell root
    const root = await cache.match('./index.html');
    if (root) return root;
    return new Response('<h1>Offline</h1><p>কোনো ইন্টারনেট সংযোগ নেই</p>', {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const fetchPromise = fetch(req)
    .then((resp) => {
      if (resp && (resp.ok || resp.type === 'opaque')) {
        cache.put(req, resp.clone()).catch(() => {});
      }
      return resp;
    })
    .catch(() => cached);
  return cached || fetchPromise;
}

/* ── MESSAGE ─────────────────────────────────────────────── */
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data === 'CLEAR_CACHE') {
    caches.keys().then((names) =>
      Promise.all(names.map((n) => caches.delete(n)))
    ).then(() => {
      event.source && event.source.postMessage({ type: 'CACHE_CLEARED' });
    });
  }
});