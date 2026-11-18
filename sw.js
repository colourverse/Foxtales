// Fox Tales service worker.
// Its only job is a friendly page when someone opens the app with no internet.
// It deliberately doesn't keep copies of the site, so updates always arrive straight away.
// It only handles page loads (and the offline page's picture); messages, files and everything
// else go straight to the network.

const OFFLINE_CACHE = "foxtales-offline-v1";
const OFFLINE_FILES = ["offline.html", "icons/icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(OFFLINE_CACHE).then((cache) => cache.addAll(OFFLINE_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== OFFLINE_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.mode === "navigate") {
    // Pages: always from the network; the offline page only if that fails.
    event.respondWith(fetch(request).catch(() => caches.match("offline.html")));
    return;
  }
  // The offline page's own picture: network first, saved copy if offline.
  const url = new URL(request.url);
  if (url.origin === self.location.origin && OFFLINE_FILES.some((f) => url.pathname.endsWith("/" + f))) {
    event.respondWith(fetch(request).catch(() => caches.match(request, { ignoreSearch: true })));
  }
  // Everything else (messages, files, Supabase) isn't touched.
});
