import { resolveApiBase } from "./apiBase";

/**
 * Build a full API URL from a path relative to the API base.
 * The base already includes `/api` when needed — do not prefix paths with `/api`.
 *
 * @example authFetch("/me/structures?limit=100")
 */
export function buildApiUrl(path: string): string {
  const base = resolveApiBase();
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${base}${normalized}`;
}

export function authHeaders(): HeadersInit {
  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;
  return { Authorization: `Bearer ${token ?? ""}` };
}

export async function authFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const url = buildApiUrl(path);
  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;
  return fetch(url, {
    ...init,
    cache: init?.cache ?? "no-store",
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${token ?? ""}`,
    },
  });
}

export function formatFetchError(
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
    .map(({ label, res, url }) => formatFetchError(label, res, url))
    .join("; ");
}
