import type { Response } from "express";
import jwt, { type SignOptions } from "jsonwebtoken";

/** Persistent session for mobile / PWA customers (30 days). Override with JWT_EXPIRES_IN. */
export const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN?.trim() || "30d";

/**
 * Platform admin session TTL — shorter than the customer 30d cookie.
 * Override with ADMIN_JWT_EXPIRES_IN (e.g. "4h", "8h").
 */
export const ADMIN_JWT_EXPIRES_IN =
  process.env.ADMIN_JWT_EXPIRES_IN?.trim() || "8h";

export const AUTH_COOKIE_NAME = "auth_token";

/**
 * Separate httpOnly cookie for platform admins (short TTL).
 * Prefer this over reusing the customer `auth_token` for admin panel access.
 */
export const ADMIN_AUTH_COOKIE_NAME = "admin_auth_token";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;

export const AUTH_COOKIE_MAX_AGE_MS = Number.isFinite(
  Number(process.env.AUTH_COOKIE_MAX_AGE_MS),
)
  ? Number(process.env.AUTH_COOKIE_MAX_AGE_MS)
  : THIRTY_DAYS_MS;

export const ADMIN_AUTH_COOKIE_MAX_AGE_MS = Number.isFinite(
  Number(process.env.ADMIN_AUTH_COOKIE_MAX_AGE_MS),
)
  ? Number(process.env.ADMIN_AUTH_COOKIE_MAX_AGE_MS)
  : EIGHT_HOURS_MS;

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

export function authCookieOptions(): {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax" | "strict" | "none";
  maxAge: number;
  path: string;
} {
  const prod = isProduction();
  const sameSiteEnv = process.env.COOKIE_SAME_SITE?.trim().toLowerCase();
  let sameSite: "lax" | "strict" | "none" = prod ? "none" : "lax";
  if (sameSiteEnv === "lax" || sameSiteEnv === "strict" || sameSiteEnv === "none") {
    sameSite = sameSiteEnv;
  }

  const secure =
    process.env.COOKIE_SECURE === "true" ||
    (process.env.COOKIE_SECURE !== "false" && prod);

  return {
    httpOnly: true,
    secure,
    sameSite,
    maxAge: AUTH_COOKIE_MAX_AGE_MS,
    path: "/",
  };
}

function adminAuthCookieOptions(): ReturnType<typeof authCookieOptions> {
  return {
    ...authCookieOptions(),
    maxAge: ADMIN_AUTH_COOKIE_MAX_AGE_MS,
  };
}

export type AuthTokenPayload = {
  sub: string;
  email: string;
  role?: string;
  tokenVersion: number;
};

export function signAuthToken(
  payload: AuthTokenPayload,
  secret: string,
): string {
  return jwt.sign(payload, secret, {
    expiresIn: JWT_EXPIRES_IN,
  } as SignOptions);
}

/** Short-lived JWT for platform admin sessions (separate from customer 30d token). */
export function signAdminAuthToken(
  payload: AuthTokenPayload,
  secret: string,
): string {
  return jwt.sign(payload, secret, {
    expiresIn: ADMIN_JWT_EXPIRES_IN,
  } as SignOptions);
}

export function extractAccessToken(req: {
  headers: { authorization?: unknown };
  cookies?: Record<string, string | undefined>;
}): string | null {
  const raw = req.headers.authorization;
  const authHeader = Array.isArray(raw) ? raw[0] : raw;
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    const t = authHeader.slice("Bearer ".length).trim();
    if (t) return t;
  }
  const fromAdminCookie = req.cookies?.[ADMIN_AUTH_COOKIE_NAME];
  if (typeof fromAdminCookie === "string" && fromAdminCookie.trim()) {
    return fromAdminCookie.trim();
  }
  const fromCookie = req.cookies?.[AUTH_COOKIE_NAME];
  if (typeof fromCookie === "string" && fromCookie.trim()) {
    return fromCookie.trim();
  }
  return null;
}

export function setAuthCookie(res: Response, token: string): void {
  res.cookie(AUTH_COOKIE_NAME, token, authCookieOptions());
}

export function setAdminAuthCookie(res: Response, token: string): void {
  res.cookie(ADMIN_AUTH_COOKIE_NAME, token, adminAuthCookieOptions());
}

export function clearAuthCookie(res: Response): void {
  res.clearCookie(AUTH_COOKIE_NAME, {
    ...authCookieOptions(),
    maxAge: 0,
  });
  res.clearCookie(ADMIN_AUTH_COOKIE_NAME, {
    ...adminAuthCookieOptions(),
    maxAge: 0,
  });
}
