/* Renewonomics Service Worker
 *
 * Caching strategy is tuned for a NEWS app, where stale content is worse than
 * a slightly slower load:
 *
 *   • App shell (HTML pages, icons, manifest) → stale-while-revalidate:
 *       serve the cached copy instantly, then refresh the cache in the
 *       background so the next visit is up to date. Gives an app-like instant
 *       open without trapping users on old markup.
 *
 *   • API calls (/.netlify/functions/api/*) → network-first:
 *       always try the live network so articles, stats, and feeds are fresh.
 *       Only fall back to cache when offline, so the app still opens on a
 *       train/plane and shows the last-seen content.
 *
 *   • Everything else (fonts, images) → cache-first with network fallback.
 *
 * Bump CACHE_VERSION whenever the shell changes so old caches are purged.
 */

const CACHE_VERSION = 'rn-v55';
const SHELL_CACHE   = `${CACHE_VERSION}-shell`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

// Core app shell — precached on install so the app opens offline.
const SHELL_ASSETS = [
  '/feed.html',
  '/champions.html',
  '/impact.html',
  '/products.html',
  '/profile.html',
  '/index.html',
  '/manifest.json',
  '/icons/logo-mark.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon-v2.png',
];

// ── INSTALL ─────────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS).catch(() => {
        // If any single asset 404s we don't want install to fail outright;
        // cache what we can individually.
        return Promise.all(SHELL_ASSETS.map(url =>
          cache.add(url).catch(() => null)
        ));
      }))
      .then(() => self.skipWaiting())
  );
});

// ── ACTIVATE ────────────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => !k.startsWith(CACHE_VERSION)).map((k) => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

// ── FETCH ───────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle GET; let POST/PATCH/DELETE (admin writes, auth) hit network directly.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never cache cross-origin third-party calls (Google fonts CDN is fine to
  // cache-first, but auth/analytics should pass through). We scope SW caching
  // to same-origin + Google Fonts only.
  const sameOrigin = url.origin === self.location.origin;
  const isGoogleFonts = /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);

  // 1. API calls → network-first (fresh news/stats, offline fallback)
  if (sameOrigin && url.pathname.includes('/.netlify/functions/api')) {
    event.respondWith(networkFirst(request));
    return;
  }

  // 2. App shell HTML → stale-while-revalidate
  if (sameOrigin && (request.mode === 'navigate' || url.pathname.endsWith('.html'))) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  // 3. Same-origin static assets + Google Fonts → cache-first
  if (sameOrigin || isGoogleFonts) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // 4. Everything else → straight to network
});

// ── STRATEGIES ──────────────────────────────────────────────────────────────

async function networkFirst(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  try {
    const fresh = await fetch(request);
    // Cache successful API responses so we can serve them offline next time
    if (fresh && fresh.status === 200) cache.put(request, fresh.clone());
    return fresh;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    // Last resort: an empty JSON so the page's fetch().catch() handles gracefully
    return new Response(JSON.stringify({ offline: true }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  const networkFetch = fetch(request).then((fresh) => {
    if (fresh && fresh.status === 200) cache.put(request, fresh.clone());
    return fresh;
  }).catch(() => null);
  // Serve cached immediately if we have it; otherwise wait for network.
  return cached || networkFetch || fetch(request);
}

async function cacheFirst(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.status === 200) cache.put(request, fresh.clone());
    return fresh;
  } catch {
    return cached || Response.error();
  }
}

// Allow the page to tell a waiting SW to activate immediately (used after an update).
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
