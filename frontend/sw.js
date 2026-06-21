/*
 * Service worker — offline support for the PWA shell.
 *
 * Strategy: NETWORK-FIRST for same-origin shell assets (HTML/JS/CSS). This guarantees a
 * deploy is picked up immediately whenever the phone has connectivity, which avoids the
 * classic "stale app.js against fresh index.html" breakage. When offline we fall back to
 * the cached copy so the app still launches and runs from its IndexedDB data.
 *
 * API calls (/api/*) are never handled here — they go straight to the network and the app
 * handles offline itself via IndexedDB.
 */
const CACHE = "ticket-checker-v14";
const SHELL = [
  "./",
  "index.html",
  "app.js",
  "validity.js",
  "styles.css",
  "manifest.json",
  "icon.svg",
  "icon-192.png",
  "icon-512.png",
  "icon-512-maskable.png",
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
  if (event.request.method !== "GET") return;            // POST/PUT etc. → network
  if (url.pathname.startsWith("/api/")) return;          // API → network (offline via IDB)
  if (url.origin !== self.location.origin) return;       // third-party → default

  // Network-first: fetch fresh, update the cache, fall back to cache when offline.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res && res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, clone));
        }
        return res;
      })
      .catch(() =>
        caches.match(event.request).then((cached) => cached || caches.match("index.html"))
      )
  );
});
