import { NextResponse } from "next/server";

/** Play Console → App integrity → App signing key certificate (what devices see). */
const DEFAULT_APP_SIGNING_SHA256 =
  "A2:A4:21:23:CA:DB:5C:23:12:08:CF:3C:BB:1F:38:8E:98:2A:E9:93:13:ED:11:91:79:14:69:88:DD:47:BB:BB";

/** Play Console → App integrity → Upload key certificate (local / sideload builds). */
const DEFAULT_UPLOAD_KEY_SHA256 =
  "3B:87:A4:05:D8:61:93:98:4D:44:0C:D1:27:9F:AD:D6:D9:7C:BF:CF:92:2C:D6:06:5F:62:56:9B:17:85:AA:23";

function parseFingerprints(raw: string | undefined, fallback: string): string[] {
  const source = raw?.trim() ? raw : fallback;
  return source
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function GET() {
  const fingerprints = [
    ...parseFingerprints(
      process.env.ANDROID_APP_SIGNING_SHA256,
      DEFAULT_APP_SIGNING_SHA256,
    ),
    ...parseFingerprints(
      process.env.ANDROID_UPLOAD_KEY_SHA256,
      DEFAULT_UPLOAD_KEY_SHA256,
    ),
  ];

  const assetlinks = [
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: "online.tradeictearner.twa",
        sha256_cert_fingerprints: fingerprints,
      },
    },
  ];

  return NextResponse.json(assetlinks, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
