/* ==========================================================================
   LearnLog — service worker
   Caches the app shell so LearnLog keeps working with no network at all.
   IndexedDB (skills, categories, settings, photos/videos) is completely
   separate from this cache — updating the cache here never touches or
   clears the user's saved data.

   To ship an update: bump CACHE_VERSION below. Old caches are removed on
   activate; IndexedDB is left untouched.
   ========================================================================== */

const CACHE_VERSION = "learnlog-v5";

const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./css/style.css",
  "./js/db.js",
  "./js/app.js",
  "./icons/icon.svg",
  "./icons/icon-maskable.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-180.png",
  "./icons/icon-maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) =>
        Promise.all(
          PRECACHE_URLS.map((url) =>
            cache.add(url).catch(() => {
              // Ignore individual missing assets (e.g. icons not yet generated)
              // so one 404 doesn't block the whole install.
            })
          )
        )
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // never intercept cross-origin

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;

      return fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => {
          // Offline and not cached — for navigations, fall back to the app shell.
          if (request.mode === "navigate") {
            return caches.match("./index.html");
          }
          return new Response("", { status: 408, statusText: "Offline" });
        });
    })
  );
});
