/* Flow's offline shell (Review 2 §4.2): the installed PWA answers even when
   uvicorn is restarting — a §32-verified event the browser currently answers
   with a dinosaur. The scope is deliberately the shell only, per the review:

   - hashed assets (/assets/…) are cache-first: Vite content-hashes them, so
     a hit is always the bytes that URL names (immutable, like nginx's);
   - /api is network-only — data is never cached (the queue is server truth,
     §32), and the app's own error states are the offline story for calls;
   - navigations try the network and fall back to one calm offline page.

   Hand-written, no build step — the manifest/icons precedent (§30.9). Bump
   VERSION to drop every cache on deploy (activate removes the old ones). */

const VERSION = "flow-shell-v2";
const SHELL_CACHE = `${VERSION}-shell`;
const ASSET_CACHE = `${VERSION}-assets`;
const OFFLINE_URL = "/offline.html";
/* The runtime cache is bounded — old builds' hashes churn out slowly, but
   unbounded growth is not a design (§8.0.2: edge cases get a decision). */
const MAX_ASSETS = 128;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.add(OFFLINE_URL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => !key.startsWith(VERSION))
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Data is network-only. A stale queue, scan status, or artwork would lie;
  // the app renders its own honest empty/error states without us.
  if (url.pathname.startsWith("/api")) return;

  // Navigations: network first (the app is live data over a thin shell);
  // an unreachable server gets the one fallback page, retry button inside.
  // cache: "reload" bypasses the HTTP cache — a navigation served from a
  // stale heuristic entry would pin the whole shell to an old build.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req, { cache: "reload" }).catch(() =>
        caches
          .open(SHELL_CACHE)
          .then((cache) => cache.match(OFFLINE_URL))
          .then((res) => res ?? Response.error()),
      ),
    );
    return;
  }

  // Hashed assets are immutable: cache-first, populate on first fetch.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.open(ASSET_CACHE).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        try {
          const res = await fetch(req);
          if (res.ok) {
            await cache.put(req, res.clone());
            trimAssets(cache);
          }
          return res;
        } catch {
          // Never cached and unreachable: the console noise is the honest
          // state — inventing a body would be worse.
          return Response.error();
        }
      }),
    );
  }
});

/** Keep the runtime cache bounded: oldest entries go first. */
function trimAssets(cache) {
  cache.keys().then((keys) => {
    if (keys.length <= MAX_ASSETS) return;
    for (const key of keys.slice(0, keys.length - MAX_ASSETS)) {
      cache.delete(key);
    }
  });
}
