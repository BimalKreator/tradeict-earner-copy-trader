import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";

function getBotWebhookSecret(): string {
  return process.env.BOT_WEBHOOK_SECRET?.trim() ?? "";
}

/** Refuse boot when the shared secret is missing (called from server.ts). */
export function assertBotWebhookSecretConfigured(): void {
  if (!getBotWebhookSecret()) {
    console.error("FATAL: BOT_WEBHOOK_SECRET is missing");
    process.exit(1);
  }
}

function parseIpAllowlist(): Set<string> | null {
  const raw = process.env.INTERNAL_IP_ALLOWLIST?.trim();
  if (!raw) return null;
  const ips = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return ips.length > 0 ? new Set(ips) : null;
}

function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0]!.trim();
  }
  if (Array.isArray(forwarded) && forwarded[0]) {
    return String(forwarded[0]).trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}

function verifySignature(
  rawBody: Buffer,
  provided: string,
  secret: string,
): boolean {
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");
  if (expected.length !== provided.length) {
    return false;
  }
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, "utf8"),
      Buffer.from(provided, "utf8"),
    );
  } catch {
    return false;
  }
}

/**
 * Requires HMAC-SHA256 of the raw JSON body in `x-internal-signature` (hex).
 * Optionally restricts callers via INTERNAL_IP_ALLOWLIST.
 */
export function requireInternalSignature(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const secret = getBotWebhookSecret();
  if (!secret) {
    res.status(500).json({ error: "Internal webhook secret is not configured" });
    return;
  }

  const clientIp = getClientIp(req);
  const allowlist = parseIpAllowlist();
  if (allowlist && !allowlist.has(clientIp)) {
    console.warn(
      `[InternalAuth] rejected request from non-allowlisted IP ${clientIp}`,
    );
    res.status(401).json({ error: "invalid signature" });
    return;
  }

  const signatureHeader = req.headers["x-internal-signature"];
  const provided =
    typeof signatureHeader === "string"
      ? signatureHeader.trim()
      : Array.isArray(signatureHeader)
        ? (signatureHeader[0]?.trim() ?? "")
        : "";

  const rawBody = req.rawBody;
  if (!rawBody) {
    console.warn(
      `[InternalAuth] invalid signature from ${clientIp}: missing raw body`,
    );
    res.status(401).json({ error: "invalid signature" });
    return;
  }

  if (!provided || !verifySignature(rawBody, provided, secret)) {
    console.warn(`[InternalAuth] invalid signature from ${clientIp}`);
    res.status(401).json({ error: "invalid signature" });
    return;
  }

  next();
}
