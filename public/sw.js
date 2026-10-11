/* Whiteboard Alive service worker: once the page has been opened online, a reload keeps working when the
 * venue Wi-Fi drops (phones throw background tabs away, so "keep the tab open" is not enough).
 *
 * Served from /whiteboard-alive/sw.js, so the scope is /whiteboard-alive/. Registered by src/sw-register.ts.
 *
 * What is cached and how (same origin, GET only):
 *
 *   request                              strategy
 *   -----------------------------------  ---------------------------------------------------------------
 *   page (navigate)                      network-first (4 s), cache only when the network fails or stalls
 *   assets/*.js, assets/*.css            network-first (4 s), cache only when the network fails or stalls
 *   opencv.js, examples/*                stale-while-revalidate: cache answers at once, refreshed behind
 *   anything else on this origin         stale-while-revalidate
 *   other origins (Gemini, Google Fonts) untouched: the browser fetches them as if there were no worker
 *
 * Install pre-fills the cache with the page, every hashed asset the page references (read from the HTML, the
 * names change on each deploy), opencv.js and the example gallery. A new deploy wins over the cache because
 * HTML and assets are network-first; opencv.js / examples pick the new version up one load later.
 *
 * Bump CACHE_VERSION to throw every cached file away (old caches are deleted on activate).
 *
 * EMERGENCY OFF SWITCH
 *   Replace this whole file with the three lines below and deploy. Every browser fetches sw.js again on its
 *   next visit, so this unregisters the worker and drops the caches on every device. The page then loads
 *   straight from the network as before.
 *
 *     self.addEventListener('install', () => self.skipWaiting());
 *     self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.map((k) => caches.delete(k)))).then(() => self.registration.unregister())));
 *     // (nothing else: no fetch handler)
 *
 *   One device only: open the page with ?sw=0 (handled by src/sw-register.ts).
 */

const CACHE_VERSION = 2;
const CACHE_PREFIX = 'whiteboard-alive-';
const CACHE = `${CACHE_PREFIX}v${CACHE_VERSION}`;

/** How long network-first waits before answering from the cache (the fetch keeps going to refresh the cache). */
const NETWORK_TIMEOUT_MS = 4000;

/** Files under public/ that the gallery needs offline. Keep in step with public/examples/ and src/examples.ts. */
const PRECACHE_EXAMPLES = [
  'examples/fingerprints.json',
  'examples/collision-gen-01-thumb.jpg',
  'examples/collision-gen-01.jpg',
  'examples/collision-gen-01.json',
  'examples/incline-gen-01-thumb.jpg',
  'examples/incline-gen-01.jpg',
  'examples/incline-gen-01.json',
  'examples/lever-gen-01-thumb.jpg',
  'examples/lever-gen-01.jpg',
  'examples/lever-gen-01.json',
  'examples/pendulum-gen-01-thumb.jpg',
  'examples/pendulum-gen-01.jpg',
  'examples/pendulum-gen-01.json',
  'examples/projectile-gen-01-thumb.jpg',
  'examples/projectile-gen-01.jpg',
  'examples/projectile-gen-01.json',
  'examples/pulley-gen-01-thumb.jpg',
  'examples/pulley-gen-01.jpg',
  'examples/pulley-gen-01.json',
  'examples/pulley-gen-03-thumb.jpg',
  'examples/pulley-gen-03.jpg',
  'examples/pulley-gen-03.json',
  'examples/roll-gen-02-thumb.jpg',
  'examples/roll-gen-02.jpg',
  'examples/roll-gen-02.json',
  'examples/spring-gen-01-thumb.jpg',
  'examples/spring-gen-01.jpg',
  'examples/spring-gen-01.json',
];

/** Absolute URL of a file next to this worker (the scope root). */
const scoped = (path) => new URL(path, self.location.href).href;
const PAGE = scoped('./');
const MATCH = { ignoreVary: true };

// ---------------------------------------------------------------------------------------------------------------
// Install: fill the cache. Page + assets + opencv.js must all succeed (otherwise install fails and the browser
// retries on the next visit). Examples are best effort so one missing file cannot switch offline support off.

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);

      const page = await fetch(new Request(PAGE, { cache: 'no-cache' }));
      if (!page.ok) throw new Error(`[sw] precache: page answered ${page.status}`);
      const html = await page.clone().text();
      await cache.put(PAGE, page);

      const assets = new Set();
      for (const m of html.matchAll(/\b(?:src|href)=["']([^"']*\/assets\/[^"']+)["']/g)) {
        const u = new URL(m[1], self.location.href);
        if (u.origin === self.location.origin) assets.add(u.href);
      }
      await cache.addAll([...assets, scoped('opencv.js')]);

      const results = await Promise.allSettled(PRECACHE_EXAMPLES.map((p) => cache.add(scoped(p))));
      const failed = PRECACHE_EXAMPLES.filter((_, i) => results[i].status === 'rejected');
      if (failed.length) console.warn('[sw] precache skipped (not found):', failed.join(', '));
      console.log(`[sw] ${CACHE}: page, ${assets.size} assets, opencv.js, ${PRECACHE_EXAMPLES.length - failed.length} example files cached`);

      await self.skipWaiting();
    })(),
  );
});

// Activate: drop caches from older versions, take over open pages without waiting for a reload.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n.startsWith(CACHE_PREFIX) && n !== CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

// ---------------------------------------------------------------------------------------------------------------
// Fetch

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // Gemini, Google Fonts: not ours, no respondWith
  if (isDevServerFile(url)) return; // Vite dev server modules (only reachable with ?sw=1 on localhost)
  if (optedOut(request)) return; // a ?sw=0 page is clearing the cache: do not touch it, do not refill it

  if (request.mode === 'navigate') {
    event.respondWith(pageFirst(event));
  } else if (/\/assets\/[^/]+\.(?:js|css)$/.test(url.pathname)) {
    event.respondWith(networkFirst(event, request.url).then((res) => res || Response.error()));
  } else {
    event.respondWith(staleWhileRevalidate(event));
  }
});

/** Vite dev server URLs: never cache, or HMR serves stale modules. */
function isDevServerFile(url) {
  const p = url.pathname;
  return p.includes('/@') || p.includes('/node_modules/') || p.includes('/src/');
}

/** True for the ?sw=0 page itself and everything it loads (same-origin requests carry the page URL as referrer). */
function optedOut(request) {
  try {
    const from = request.mode === 'navigate' ? request.url : request.referrer;
    return !!from && new URL(from).searchParams.get('sw') === '0';
  } catch {
    return false;
  }
}

/** The page: fresh from the network when possible (revalidated, so a new deploy shows up on any navigation). */
async function pageFirst(event) {
  const key = new URL(event.request.url);
  key.search = '';
  key.hash = '';
  const res = await networkFirst(event, key.href, { cache: 'no-cache' }, async (cache) => {
    return (await cache.match(key.href, MATCH)) || (await cache.match(PAGE, MATCH));
  });
  return res ? unredirected(res) : offlinePage();
}

/**
 * Network first. Answers from the cache when the network fails, or when it has not answered within
 * NETWORK_TIMEOUT_MS (Wi-Fi that is "connected" but dead would otherwise hang the page). In the timeout case
 * the fetch keeps running so the cache is fresh next time. Returns undefined when neither side has anything.
 */
async function networkFirst(event, key, init, lookup) {
  const cache = await caches.open(CACHE);
  const req = init ? new Request(event.request, init) : event.request;
  const network = fetch(req).then((res) => {
    if (res.status === 200) event.waitUntil(cache.put(key, res.clone()).catch(() => {}));
    return res;
  });
  const NETWORK_FAILED = Symbol('failed');
  const TIMED_OUT = Symbol('timeout');
  let timer;
  const first = await Promise.race([
    network.catch(() => NETWORK_FAILED),
    new Promise((resolve) => (timer = setTimeout(() => resolve(TIMED_OUT), NETWORK_TIMEOUT_MS))),
  ]);
  clearTimeout(timer);
  if (first !== NETWORK_FAILED && first !== TIMED_OUT) return first;

  const cached = lookup ? await lookup(cache) : await cache.match(key, MATCH);
  if (cached) {
    if (first === TIMED_OUT) event.waitUntil(network.catch(() => {}));
    return cached;
  }
  if (first === TIMED_OUT) return network.catch(() => undefined); // slow network, nothing cached: keep waiting
  return undefined;
}

/** Cache first, refreshed in the background; network when there is nothing cached yet. */
async function staleWhileRevalidate(event) {
  const { request } = event;
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request.url, MATCH);
  const refresh = fetch(request).then((res) => {
    if (res.status === 200) event.waitUntil(cache.put(request.url, res.clone()).catch(() => {}));
    return res;
  });
  if (cached) {
    event.waitUntil(refresh.catch(() => {}));
    return cached;
  }
  return refresh;
}

/** A redirected response may not be used to answer a navigation; re-wrap it so the browser accepts it. */
function unredirected(res) {
  if (!res.redirected) return res;
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

function offlinePage() {
  const html =
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Whiteboard Alive</title></head><body style="margin:0;font-family:system-ui,sans-serif;color:#1f2937;text-align:center;padding:30vh 24px">' +
    '<h1 style="font-size:22px;margin:0 0 8px">You are offline</h1>' +
    '<p style="margin:0;color:#4b5563">Open Whiteboard Alive once while online and it will work offline from then on.</p>' +
    '</body></html>';
  return new Response(html, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
