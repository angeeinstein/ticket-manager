/*
 * Service worker — makes the PWA shell available offline.
 *
 * Shell assets are cached on install and served cache-first so the app launches with no
 * network. API calls (/api/*) are never cached; they go straight to the network and the
 * app falls back to its IndexedDB cache when offline.
 */
const CACHE = "ticket-checker-v1";
const SHELL = [
  "./",
  "index.html",
  "app.js",
  "validity.js",
  "styles.css",
  "manifest.json",
  "icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Never cache API traffic — the app handles offline via IndexedDB itself.
  if (url.pathname.startsWith("/api/")) {
    return; // default network handling
  }

  // Cache-first for the shell; fall back to network and cache new GETs.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((res) => {
          if (event.request.method === "GET" && res.ok && url.origin === self.location.origin) {
            const clone = res.clone();
            caches.open(CACHE).then((c) => c.put(event.request, clone));
          }
          return res;
        })
        .catch(() => cached);
    })
  );
});
