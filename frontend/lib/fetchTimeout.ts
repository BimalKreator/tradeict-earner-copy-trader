export class FetchTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Request timed out after ${Math.round(timeoutMs / 1000)}s. Please try again.`);
    this.name = "FetchTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

/**
 * fetch() with AbortController timeout. Prefer this (or authFetch) over bare fetch.
 */
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const external = init?.signal;
  const onExternalAbort = () => controller.abort();
  if (external) {
    if (external.aborted) {
      controller.abort();
    } else {
      external.addEventListener("abort", onExternalAbort, { once: true });
    }
  }

  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } catch (err) {
    if (
      (err instanceof DOMException && err.name === "AbortError") ||
      (err instanceof Error && err.name === "AbortError")
    ) {
      if (external?.aborted) throw err;
      throw new FetchTimeoutError(timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (external) {
      external.removeEventListener("abort", onExternalAbort);
    }
  }
}

export function isFetchTimeoutError(err: unknown): err is FetchTimeoutError {
  return err instanceof FetchTimeoutError;
}
