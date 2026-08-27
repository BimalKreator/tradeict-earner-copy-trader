/**
 * Single-flight session expiry handling for API 401 responses.
 * Login/signup/OTP endpoints are exempt — wrong credentials must not redirect.
 */

export const SESSION_EXPIRED_MESSAGE =
  "Your session expired. Please sign in again.";

const SESSION_EXPIRED_STORAGE_KEY = "tradeict_session_expired_message";
export const SESSION_EXPIRED_EVENT = "tradeict:session-expired";

/** Module-level: one redirect + one toast even if many requests 401 at once. */
let sessionExpiryRedirectInFlight = false;

const AUTH_EXEMPT_PATH =
  /\/auth\/(login|verify-otp|register|send-otp|send-login-otp|forgot-password|reset-password|logout)(?:\/|$|\?)/i;

/**
 * Relative path only — rejects open redirects (`//evil.com`, absolute URLs).
 */
export function safePostLoginNext(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) {
    return "/dashboard";
  }
  return raw;
}

export function consumeSessionExpiredMessage(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const msg = sessionStorage.getItem(SESSION_EXPIRED_STORAGE_KEY);
    if (msg) sessionStorage.removeItem(SESSION_EXPIRED_STORAGE_KEY);
    return msg;
  } catch {
    return null;
  }
}

/** Persist the shared session-expired banner message (DashboardAuthGate + 401 interceptor). */
export function storeSessionExpiredMessage(): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(SESSION_EXPIRED_STORAGE_KEY, SESSION_EXPIRED_MESSAGE);
  } catch {
    /* ignore */
  }
}

export function isAuthEndpointExemptFromSessionExpiry(url: string): boolean {
  try {
    const pathname = new URL(url, "http://localhost").pathname;
    return AUTH_EXEMPT_PATH.test(pathname);
  } catch {
    return AUTH_EXEMPT_PATH.test(url);
  }
}

function clearClientAuthArtifacts(): void {
  try {
    localStorage.removeItem("token");
  } catch {
    /* ignore */
  }
  storeSessionExpiredMessage();
  try {
    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
  } catch {
    /* ignore */
  }
}

/**
 * On authenticated API 401: clear client auth once, toast via login banner, redirect to /login?next=.
 * No-ops for exempt auth endpoints and after the first concurrent 401.
 */
export function handleApiUnauthorized(responseUrl: string): void {
  if (typeof window === "undefined") return;
  if (isAuthEndpointExemptFromSessionExpiry(responseUrl)) return;
  if (sessionExpiryRedirectInFlight) return;

  const path = `${window.location.pathname}${window.location.search}`;
  if (path.startsWith("/login")) return;

  sessionExpiryRedirectInFlight = true;
  clearClientAuthArtifacts();

  const next = encodeURIComponent(safePostLoginNext(path));
  window.location.replace(`/login?next=${next}`);
}

/** Reset in-flight flag after successful login (optional; full page load also resets). */
export function resetSessionExpiryRedirectFlag(): void {
  sessionExpiryRedirectInFlight = false;
}
