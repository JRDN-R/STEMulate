const CACHE_PREFIX = "stemulate-shell-";
const CACHE_NAME = `${CACHE_PREFIX}8932a39df4e8e338`;
const BUILD_ASSETS = [
  "./assets/firebase-BXxUg_ZN.js",
  "./assets/index-DmXOKwV0.css",
  "./assets/index-TxHGerV5.js",
  "./assets/musicAi-BK6T9ZzK.js"
];
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./stemulate-logo.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
];
const PRECACHE_URLS = [...new Set([...APP_SHELL, ...BUILD_ASSETS])];
const STATIC_DESTINATIONS = new Set(["script", "style", "image", "font", "manifest"]);

function scopedUrl(path) {
  return new URL(path, self.registration.scope).href;
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(PRECACHE_URLS.map((path) => new Request(scopedUrl(path), { cache: "reload" })));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

async function navigationResponse(request) {
  try {
    return await fetch(request);
  } catch {
    const cache = await caches.open(CACHE_NAME);
    return (await cache.match(request, { ignoreSearch: true }))
      || (await cache.match(scopedUrl("./index.html")))
      || Response.error();
  }
}

async function staticResponse(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (event.request.mode === "navigate") {
    event.respondWith(navigationResponse(event.request));
    return;
  }
  if (STATIC_DESTINATIONS.has(event.request.destination)) {
    event.respondWith(staticResponse(event.request));
  }
});
