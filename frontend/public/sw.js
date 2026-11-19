/* Flow's offline shell: the installed app opens even when the server is
   gone (stopped, restarting, a reverse proxy answering "bad gateway"),
   and says so in place instead of showing the browser's own error page.

   - Install stores this build's shell: index.html and every script and
     stylesheet it can load, so the app starts and every section opens
     with no connection.
   - /api is network-only. Data is never cached (the queue is server
     truth); the app shows what it already holds and says the server is
     unreachable.
   - A page load tries the network first. With no answer, or a 5xx, it gets
     the stored shell (and if even that is missing, a one-page notice).
   - /assets/ are content-hashed, so they are served from the store first.

   BUILD and PRECACHE are written by the build (vite.config.ts): every
   build has its own cache name, and activating a new build removes the
   old one. This file is never edited per release. */

const BUILD = "__FLOW_BUILD__";
const PRECACHE = ["__FLOW_PRECACHE__"];

const CACHE = `flow-${BUILD}`;
const SHELL_URL = "/";
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) =>
        cache.addAll([
          // "reload": the shell must come from the server, never from an
          // HTTP cache that may still hold the previous build's page.
          ...[SHELL_URL, OFFLINE_URL].map((url) => new Request(url, { cache: "reload" })),
          // Hashed assets never change under their name: the copies the
          // page already fetched (and an upgrade did not rename) come from
          // the HTTP cache instead of the network a second time.
          ...PRECACHE,
        ]),
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith("/api")) return;

  if (req.mode === "navigate") {
    event.respondWith(navigate(req));
    return;
  }

  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(req, { cacheName: CACHE }).then((hit) => hit ?? fetch(req)),
    );
  }
});

// A server that hangs (a sleeping NAS, a weak signal) gets this long
// before the stored shell answers instead.
const NAVIGATE_TIMEOUT_MS = 5000;

async function navigate(req) {
  try {
    const res = await Promise.race([
      fetch(req, { cache: "reload" }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), NAVIGATE_TIMEOUT_MS)),
    ]);
    if (res.status < 500) return res;
  } catch {
    // No answer, or none in time: the stored shell below.
  }
  const cache = await caches.open(CACHE);
  return (
    (await cache.match(SHELL_URL)) ?? (await cache.match(OFFLINE_URL)) ?? Response.error()
  );
}
