import type { NextConfig } from "next";
import withPWAInit from "@ducanh2912/next-pwa";

/** @ducanh2912/next-pwa registers Workbox via webpack; production builds must use `next build --webpack` (see package.json). */

const withPWA = withPWAInit({
  dest: "public",
  disable: process.env.NODE_ENV === "development",
  cacheOnFrontEndNav: true,
  reloadOnOnline: true,
  workboxOptions: {
    disableDevLogs: true,
  },
});

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: '/.well-known/assetlinks.json',
        destination: '/api/assetlinks',
      },
    ];
  },
};

export default withPWA(nextConfig);
