import { resolveApiBase } from "./apiBase";
import { fetchWithTimeout } from "./fetchTimeout";

/**
 * Cookie-only admin authentication.
 * Never reads localStorage — the httpOnly `admin_auth_token` (short TTL) or
 * `auth_token` cookie authenticates via credentials: "include".
 */
export function adminAuthHeaders(extra?: HeadersInit): HeadersInit {
  return { ...(extra ?? {}) };
}

/** Merge credentials/cache defaults for raw `fetch` to absolute admin URLs. */
export function adminRequestInit(init?: RequestInit): RequestInit {
  return {
    ...init,
    credentials: "include",
    cache: init?.cache ?? "no-store",
    headers: adminAuthHeaders(init?.headers),
  };
}

export function buildAdminApiUrl(path: string): string {
  const base = resolveApiBase();
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${base}${normalized}`;
}

/**
 * Shared admin HTTP helper — one place for cookie credentials.
 * Do not attach Authorization from localStorage.
 */
export async function adminFetch(
  path: string,
  init?: RequestInit,
  timeoutMs = 15_000,
): Promise<Response> {
  return fetchWithTimeout(
    buildAdminApiUrl(path),
    adminRequestInit(init),
    timeoutMs,
  );
}

export function formatAdminFetchError(
  label: string,
  res: Response,
  url: string,
): string {
  return `${label}: HTTP ${res.status} — ${url}`;
}

export function formatFetchErrors(
  failures: Array<{ label: string; res: Response; url: string }>,
): string {
  return failures
    .map(({ label, res, url }) => formatAdminFetchError(label, res, url))
    .join("; ");
}
