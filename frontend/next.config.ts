import type { NextConfig } from "next";
import withPWAInit from "@ducanh2912/next-pwa";
import type { RuntimeCaching } from "workbox-build";

/** @ducanh2912/next-pwa registers Workbox via webpack; production builds must use `next build --webpack` (see package.json). */

/**
 * Explicit runtime caching for @ducanh2912/next-pwa v10.
 * MUST live under workboxOptions.runtimeCaching — a top-level key is ignored.
 * extendDefaultRuntimeCaching: false replaces stock defaults (which NetworkFirst-cache /api as "apis").
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

  {
    urlPattern: /\/_next\/static.+/i,
    handler: "CacheFirst",
    options: {
      cacheName: "next-static",
      expiration: { maxEntries: 64, maxAgeSeconds: 86_400 },
    },
  },
  {
    urlPattern: /\.(?:eot|otf|ttc|ttf|woff|woff2)$/i,
    handler: "CacheFirst",
    options: {
      cacheName: "static-fonts",
      expiration: { maxEntries: 16, maxAgeSeconds: 60 * 60 * 24 * 365 },
    },
  },
  {
    urlPattern: /\.(?:jpg|jpeg|gif|png|svg|ico|webp)$/i,
    handler: "StaleWhileRevalidate",
    options: {
      cacheName: "static-images",
      expiration: { maxEntries: 64, maxAgeSeconds: 60 * 60 * 24 * 30 },
    },
  },
  {
    urlPattern: /\/manifest\.json$/i,
    handler: "StaleWhileRevalidate",
    options: {
      cacheName: "manifest",
      expiration: { maxEntries: 2, maxAgeSeconds: 86_400 },
    },
  },
  {
    urlPattern: /\/icon-.*\.png$/i,
    handler: "CacheFirst",
    options: {
      cacheName: "app-icons",
      expiration: { maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 * 30 },
    },
  },
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
  cacheOnFrontEndNav: false,
  reloadOnOnline: true,
  customWorkerSrc: "worker",
  // PluginOptions (top-level): false = use our array instead of stock defaults.
  extendDefaultRuntimeCaching: false,
  workboxOptions: {
    // GenerateSWOptions — these MUST be under workboxOptions in v10.
    skipWaiting: true,
    clientsClaim: true,
    cleanupOutdatedCaches: true,
    runtimeCaching,
    disableDevLogs: true,
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
