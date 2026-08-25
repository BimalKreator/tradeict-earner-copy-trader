import type { NextConfig } from "next";
import withPWAInit from "@ducanh2912/next-pwa";
import type { RuntimeCaching } from "workbox-build";

/** @ducanh2912/next-pwa registers Workbox via webpack; production builds must use `next build --webpack` (see package.json). */

/**
 * Explicit runtime caching — replace stock defaults (extendDefaultRuntimeCaching: false).
 * Authenticated /api responses must never be stored in Cache Storage.
 */
const runtimeCaching: RuntimeCaching[] = [
  // API — NetworkOnly for every method (no cache entry, ever).
  ...(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const).map(
    (method) =>
      ({
        urlPattern: ({ url: { pathname } }) => pathname.startsWith("/api/"),
        handler: "NetworkOnly",
        method,
      }) satisfies RuntimeCaching,
  ),

  // Next.js build assets
  {
    urlPattern: /\/_next\/static.+/i,
    handler: "CacheFirst",
    options: {
      cacheName: "next-static",
      expiration: { maxEntries: 64, maxAgeSeconds: 86_400 },
    },
  },

  // Fonts
  {
    urlPattern: /\.(?:eot|otf|ttc|ttf|woff|woff2)$/i,
    handler: "CacheFirst",
    options: {
      cacheName: "static-fonts",
      expiration: { maxEntries: 16, maxAgeSeconds: 60 * 60 * 24 * 365 },
    },
  },

  // Images
  {
    urlPattern: /\.(?:jpg|jpeg|gif|png|svg|ico|webp)$/i,
    handler: "StaleWhileRevalidate",
    options: {
      cacheName: "static-images",
      expiration: { maxEntries: 64, maxAgeSeconds: 60 * 60 * 24 * 30 },
    },
  },

  // PWA manifest
  {
    urlPattern: /\/manifest\.json$/i,
    handler: "StaleWhileRevalidate",
    options: {
      cacheName: "manifest",
      expiration: { maxEntries: 2, maxAgeSeconds: 86_400 },
    },
  },

  // App icons
  {
    urlPattern: /\/icon-.*\.png$/i,
    handler: "CacheFirst",
    options: {
      cacheName: "app-icons",
      expiration: { maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 * 30 },
    },
  },

  // App shell (document navigations only — not API JSON)
  {
    urlPattern: ({ request, sameOrigin }) =>
      sameOrigin && request.mode === "navigate",
    handler: "NetworkFirst",
    options: {
      cacheName: "app-shell",
      networkTimeoutSeconds: 10,
      expiration: { maxEntries: 32, maxAgeSeconds: 86_400 },
    },
  },
];

const withPWA = withPWAInit({
  dest: "public",
  disable: process.env.NODE_ENV === "development",
  // Do not cache front-end navigations beyond the explicit app-shell rule above.
  cacheOnFrontEndNav: false,
  reloadOnOnline: true,
  // Custom list replaces stock defaults (which NetworkFirst-cached /api).
  extendDefaultRuntimeCaching: false,
  workboxOptions: {
    disableDevLogs: true,
    skipWaiting: true,
    clientsClaim: true,
    runtimeCaching,
  },
});

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: "/.well-known/assetlinks.json",
        destination: "/api/assetlinks",
      },
    ];
  },
};

export default withPWA(nextConfig);
