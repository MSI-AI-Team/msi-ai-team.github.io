/* Let's Read service worker: once something has played or shown, it works offline.
   - App shell (index.html + the built JS/CSS it names): cached at install, so the very
     first visit is enough to open the app offline.
   - Pictures, songs, music, voice clips, fonts: cache first. Media is fetched whole (no
     Range) so a 206 partial response is never what gets cached.
   - The clip manifest and word timings: network first (they change when content grows).
   - Never cache an HTML page under an asset URL. Old caches are deleted on activate. */
const CACHE = 'letsread-v5'; // (page loads skip the HTTP cache since 2026-11-23) v5: every song rewritten and re-sung (2026-11-23): the song files keep their names, so phones must drop the old ones
const CACHE_FIRST = [/^\/art\//, /^\/books\//, /^\/songs\//, /^\/music\//, /^\/audio\/(?!manifest|timings)/, /^\/api\/tts/, /^\/assets\//, /\.(?:woff2?|ttf)$/];
const NETWORK_FIRST = [/^\/audio\/manifest\.json$/, /^\/audio\/timings\.json$/];
const MEDIA = /^\/(songs|music|audio)\//;
// the pictures were all redrawn (soft 3D, 2026-11-26) under the same names: drop the old ones once,
// keeping the songs and voice clips (a phone offline would otherwise have to fetch them all again)
const PICTURES = '/__pictures-soft3d-1';

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    (async () => {
      const c = await caches.open(CACHE);
      const shell = ['/manifest.webmanifest', '/icon-192.png', '/icon-boot.webp', '/audio/manifest.json', '/audio/timings.json', '/music/map.mp3'];
      try {
        // the page itself is the one just fetched past every cache, so it and the files it names
        // agree (c.add('/') went through the HTTP cache and could keep a 10-minute-old page)
        const html = await (await fetch('/', { cache: 'no-store' })).text();
        await c.put('/', new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }));
        for (const m of html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) shell.push(m[1]);
      } catch {
        /* offline install: cache what we can */
      }
      await Promise.all(shell.map((u) => c.add(new Request(u, { cache: 'reload' })).catch(() => undefined)));
    })(),
  );
});

self.addEventListener('activate', (e) =>
  e.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
      const c = await caches.open(CACHE);
      if (!(await c.match(PICTURES))) {
        for (const r of await c.keys()) if (/^\/(art|books)\//.test(new URL(r.url).pathname)) await c.delete(r);
        await c.put(PICTURES, new Response('1'));
      }
      await self.clients.claim();
    })(),
  ),
);

async function cacheFirst(req, url) {
  const c = await caches.open(CACHE);
  const key = MEDIA.test(url.pathname) ? url.href : req;
  const hit = await c.match(key);
  if (hit) return hit;
  // media: ask for the WHOLE file (a Range request would give a 206 the cache cannot store)
  const res = await fetch(MEDIA.test(url.pathname) ? new Request(url.href) : req);
  const type = res.headers.get('content-type') || '';
  if ((res.ok && res.status === 200 && !type.includes('text/html')) || res.type === 'opaque') c.put(key, res.clone());
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const isFont = /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
  if (sameOrigin && NETWORK_FIRST.some((r) => r.test(url.pathname))) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          // copy BEFORE handing it on: once the page has read the body, clone() throws
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req)),
    );
    return;
  }
  if ((sameOrigin && CACHE_FIRST.some((r) => r.test(url.pathname))) || isFont) {
    e.respondWith(cacheFirst(req, url));
    return;
  }
  if (sameOrigin && req.mode === 'navigate') {
    e.respondWith(
      // past the HTTP cache: GitHub Pages says max-age=600, which kept phones on the old app for 10 minutes
      fetch(new Request(req.url, { cache: 'no-cache', credentials: 'same-origin' }))
        .then((res) => {
          // keep this page for offline. Copy it BEFORE handing it on: cloned later, the body was
          // already read, the copy threw, and phones opened offline on the page cached at install
          // (2026-11-23: an emulator ran today's build online and a build two releases old offline).
          // Only the app page itself: privacy.html must never be what opens offline.
          if (res.ok && (url.pathname === '/' || url.pathname === '/index.html')) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put('/', copy));
          }
          return res;
        })
        .catch(() => caches.match('/')),
    );
  }
});
