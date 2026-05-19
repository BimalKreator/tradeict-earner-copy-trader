import type { Response } from "express";
import jwt, { type SignOptions } from "jsonwebtoken";

/** Persistent session for mobile / PWA (30 days). Override with JWT_EXPIRES_IN. */
export const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN?.trim() || "30d";

export const AUTH_COOKIE_NAME = "auth_token";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export const AUTH_COOKIE_MAX_AGE_MS = Number.isFinite(
  Number(process.env.AUTH_COOKIE_MAX_AGE_MS),
)
  ? Number(process.env.AUTH_COOKIE_MAX_AGE_MS)
  : THIRTY_DAYS_MS;

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

export function signAuthToken(
  payload: { sub: string; email: string },
  secret: string,
): string {
  return jwt.sign(payload, secret, {
    expiresIn: JWT_EXPIRES_IN,
  } as SignOptions);
}

export function setAuthCookie(res: Response, token: string): void {
  res.cookie(AUTH_COOKIE_NAME, token, authCookieOptions());
}

export function clearAuthCookie(res: Response): void {
  res.clearCookie(AUTH_COOKIE_NAME, {
    ...authCookieOptions(),
    maxAge: 0,
  });
}
