/** Shared API base for browser fetches (public + authenticated).
 *
 * ALWAYS use `resolveApiBase()` — never read `process.env.NEXT_PUBLIC_API_URL`
 * directly in app/components code. Env may be unset in some deploys; this
 * helper falls back to same-origin `/api`.
 */
export function resolveApiBase(): string {
  const env = process.env.NEXT_PUBLIC_API_URL?.trim().replace(/\/$/, "") ?? "";
  if (env) return env;
  if (typeof window !== "undefined") {
    return `${window.location.origin.replace(/\/$/, "")}/api`;
  }
  return "";
}
