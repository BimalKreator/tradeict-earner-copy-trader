/**
 * Public backend API root with **no trailing slash** (e.g. `https://api.example.com/api`).
 * Set `NEXT_PUBLIC_API_URL` in `.env.local` to your backend base (including `/api` if applicable).
 */
export function getPublicApiBase(): string {
  const raw = process.env.NEXT_PUBLIC_API_URL;
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error(
      "NEXT_PUBLIC_API_URL is not set. Add it to .env.local (see .env.example).",
    );
  }
  return raw.trim().replace(/\/$/, "");
}
