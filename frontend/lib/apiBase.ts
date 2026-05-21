/** Shared API base for browser fetches (public + authenticated). */
export function resolveApiBase(): string {
  const env = process.env.NEXT_PUBLIC_API_URL?.trim().replace(/\/$/, "") ?? "";
  if (env) return env;
  if (typeof window !== "undefined") {
    return `${window.location.origin.replace(/\/$/, "")}/api`;
  }
  return "";
}
