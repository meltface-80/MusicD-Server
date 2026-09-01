/*
 * MusicD Server — service worker.
 *
 * This exists for ONE reason: an installed home-screen app would not update.
 * iOS holds the shell of a standalone web app hard enough that a correctly
 * updated server kept serving a previous release's interface, and the only way
 * out was deleting the shortcut and adding it again.
 *
 * So the strategy is deliberately the opposite of the usual one. Nothing is
 * pre-cached and nothing is served from cache while the network is reachable:
 * every request for the shell goes to the server with `cache: "reload"`, which
 * bypasses the HTTP cache underneath the worker as well. The cache here is a
 * fallback for being offline, not a performance layer — this is a music server
 * on the same LAN, and the round trip costs nothing worth having a stale
 * interface for.
 *
 * VERSION is injected by the server (see index.js). Its changing is what makes
 * the browser see a new worker at all, which is what triggers the update.
 *
 * Copyright (c) 2026 Music Duck. MIT licensed.
 */

/* eslint-env serviceworker */
const VERSION = "__BUILD_VERSION__";
const CACHE = "musicd-shell-v" + VERSION;

/* Only the app shell. Album art and audio are never cached: art is already
   cached properly by HTTP headers, and audio is fetched by the SPEAKER, not by
   this browser — putting either in here would fill a phone up for nothing. */
const SHELL = ["/", "/app.js", "/style.css", "/sharecard.js", "/icons/wordmark.svg"];

self.addEventListener("install", (event) => {
  /* Take over as soon as this worker is installed rather than waiting for
     every tab to close. Waiting is the polite default and it is exactly what
     made an installed app sit on an old version for days. */
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      /* A failed warm-up is not a failed install — the worker still works,
         it just has nothing to fall back on until the first online load. */
      .catch(() => {})
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.map((name) =>
      name.startsWith("musicd-shell-") && name !== CACHE ? caches.delete(name) : null));
    await self.clients.claim();
  })());
});

/* A page can ask the waiting worker to take over immediately, which is what
   the "reload" button in the update banner does. */
self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});

function isShell(url) {
  return SHELL.includes(url.pathname) || url.pathname === "/index.html";
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;      // GitHub, and nothing else

  const navigation = request.mode === "navigate";
  if (!navigation && !isShell(url)) return;             // art, audio and the API go straight out

  event.respondWith((async () => {
    try {
      /* "reload" bypasses the HTTP cache as well as this one. Without it the
         worker can be handed the very stale copy it exists to avoid. */
      const fresh = await fetch(navigation ? new Request(request.url, { cache: "reload" }) : request, {
        cache: "reload"
      });
      if (fresh && fresh.ok) {
        const copy = fresh.clone();
        caches.open(CACHE).then((cache) => cache.put(navigation ? "/" : request, copy)).catch(() => {});
      }
      return fresh;
    } catch {
      /* Offline. Serve the last good copy so the app opens and can at least
         say the server is unreachable. */
      const cached = await caches.match(navigation ? "/" : request);
      if (cached) return cached;
      throw new Error("offline and nothing cached for " + url.pathname);
    }
  })());
});
