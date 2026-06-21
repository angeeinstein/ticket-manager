/*
 * Service worker — reliable offline support for the installed PWA.
 *
 * Strategy: OFFLINE-FIRST (stale-while-revalidate) for the app shell, so the app
 * cold-launches with no network after one online install. Each shell request is answered
 * from the cache immediately when present, and the cache is refreshed in the background.
 *
 * Cloudflare-Access-safe: we only ever store responses that are same-origin, OK (200) and
 * NOT redirected, so an Access login/redirect page can never overwrite the real shell.
 *
 * /api/* is never handled here — it goes straight to the network; the app handles offline
 * itself via IndexedDB.
 */
const CACHE = "ticket-checker-v21";
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
  "vendor/zxing.js",
];

// Only cache trustworthy responses: same-origin (type "basic"), 200, and not a redirect
// (Cloudflare Access challenges arrive as a redirect / cross-origin page).
function cacheable(res) {
  return res && res.ok && res.type === "basic" && !res.redirected;
}

self.addEventListener("install", (event) => {
  // Resilient precache: store each asset independently so one failure can't abort install.
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      Promise.allSettled(
        SHELL.map((url) =>
          fetch(url, { cache: "no-store" }).then((res) => {
            if (cacheable(res)) return cache.put(url, res.clone());
          })
        )
      )
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET") return;                 // POST/PUT etc. → network
  if (url.pathname.startsWith("/api/")) return;     // API → network (offline via IndexedDB)
  if (url.origin !== self.location.origin) return;  // third-party → default
  // Sign-in navigations bypass the cache so the Cloudflare Access login can render
  // (otherwise the cached shell would hide it and re-auth would be impossible).
  if (url.searchParams.has("auth")) return;

  // Stale-while-revalidate: serve cache first (instant, offline-capable), refresh in bg.
  event.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(req).then((cached) => {
        const network = fetch(req)
          .then((res) => {
            if (cacheable(res)) cache.put(req, res.clone());
            return res;
          })
          .catch(() => null);

        if (cached) {
          network.catch(() => {}); // keep the bg refresh from rejecting unhandled
          return cached;
        }
        // Not cached yet: use the network; if that fails (offline), fall back to the shell.
        return network.then((res) => res || cache.match("index.html"));
      })
    )
  );
});
