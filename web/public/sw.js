// Verigence VINeeti service worker. Hand-written and deliberately small.
//
//  - The app shell (the page itself, manifest, icons) is cached on install so the app opens offline.
//  - Page navigations go to the network first and fall back to the cached shell when offline.
//  - Hashed build files under /assets/ never change, so they are served from the cache first.
//  - Nothing under /api/ is ever intercepted or stored: personal data must not sit in the browser cache.
//  - Only GET requests to this origin are touched.
//
// Bump VERSION whenever this file changes; old caches are deleted when the new worker takes over.
const VERSION = "v2";
const SHELL_CACHE = `vineeti-shell-${VERSION}`;
const ASSET_CACHE = `vineeti-assets-${VERSION}`;
// Caches written under the product's earlier name are cleared along with older versions.
const CACHE_PREFIXES = ["vineeti-", "allot-"];
const SHELL_URL = "/";
const SHELL_FILES = ["/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/icon-maskable-512.png", "/icons/apple-touch-icon.png", "/icons/favicon-32.png"];

/** A copy without the "redirected" flag, which browsers refuse as the answer to a navigation. */
async function plainCopy(response) {
  return new Response(await response.blob(), { status: response.status, statusText: response.statusText, headers: response.headers });
}

/** Stores the page under both names it is asked for, and the build files it refers to. */
async function storeShell(response) {
  const html = await response.clone().text();
  const shell = await caches.open(SHELL_CACHE);
  const copy = await plainCopy(response);
  await shell.put(SHELL_URL, copy.clone());
  await shell.put("/index.html", copy);
  const wanted = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
  const assets = await caches.open(ASSET_CACHE);
  await Promise.all(
    wanted.map(async (url) => {
      if (await assets.match(url)) return;
      const res = await fetch(url);
      if (res.ok && !(res.headers.get("Content-Type") || "").includes("text/html")) await assets.put(url, res);
    }),
  );
  // Build files of earlier releases are no longer needed.
  for (const request of await assets.keys()) {
    if (!wanted.includes(new URL(request.url).pathname)) await assets.delete(request);
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const page = await fetch(SHELL_URL, { cache: "reload" });
      if (!page.ok) throw new Error("The app shell could not be fetched");
      await storeShell(page);
      const shell = await caches.open(SHELL_CACHE);
      // Icons are a convenience: a missing one must not stop the install.
      await Promise.all(SHELL_FILES.map((url) => shell.add(url).catch(() => undefined)));
    })(),
  );
  // No skipWaiting here: a new version waits until the user chooses "Reload".
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (CACHE_PREFIXES.some((p) => name.startsWith(p)) && name !== SHELL_CACHE && name !== ASSET_CACHE) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // never intercepted, never cached

  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          if (fresh.ok && (fresh.headers.get("Content-Type") || "").includes("text/html")) event.waitUntil(storeShell(fresh.clone()).catch(() => undefined));
          return fresh;
        } catch {
          const cached = await caches.match(SHELL_URL, { cacheName: SHELL_CACHE });
          return cached || Response.error();
        }
      })(),
    );
    return;
  }

  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(ASSET_CACHE);
        const hit = await cache.match(request);
        if (hit) return hit;
        const fresh = await fetch(request);
        // A build file that no longer exists is answered with the page itself; that must not be kept as a script.
        const isPage = (fresh.headers.get("Content-Type") || "").includes("text/html");
        if (fresh.ok && !isPage) event.waitUntil(cache.put(request, fresh.clone()));
        return fresh;
      })(),
    );
    return;
  }

  if (SHELL_FILES.includes(url.pathname)) {
    event.respondWith(fetch(request).catch(async () => (await caches.match(request, { cacheName: SHELL_CACHE })) || Response.error()));
  }
});
