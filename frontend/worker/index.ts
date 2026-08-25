/**
 * Injected into the generated service worker by @ducanh2912/next-pwa.
 * Deletes stale Cache Storage buckets (especially the old default "apis" cache)
 * that cleanupOutdatedCaches does not touch.
 */

/// <reference lib="webworker" />

declare const self: ServiceWorkerGlobalScope;

/** Cache names used by our explicit runtimeCaching + workbox start-url. */
const ALLOWED_CACHE_NAMES = new Set([
  "next-static",
  "static-fonts",
  "static-images",
  "manifest",
  "app-icons",
  "app-shell",
  "start-url",
]);

/** Always remove — leftover from stock next-pwa NetworkFirst /api rules. */
const FORBIDDEN_CACHE_NAMES = new Set(["apis"]);

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.map(async (name) => {
          if (FORBIDDEN_CACHE_NAMES.has(name) || !ALLOWED_CACHE_NAMES.has(name)) {
            // Keep Workbox precache buckets (usually workbox-precache-v2-...).
            if (name.startsWith("workbox-precache")) return;
            await caches.delete(name);
          }
        }),
      );
      await self.clients.claim();
    })(),
  );
});

export {};
