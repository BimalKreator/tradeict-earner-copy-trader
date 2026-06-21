/** Hard cap on Delta India REST requests — shared across all services. */
const MAX_REQUESTS_PER_SECOND = Number(
  process.env.DELTA_REST_MAX_RPS ?? 10,
);

type QueueItem<T> = {
  fn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

const queue: QueueItem<unknown>[] = [];
const recentStarts: number[] = [];
let draining = false;

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function drainQueue(): Promise<void> {
  if (draining) return;
  draining = true;

  try {
    while (queue.length > 0) {
      const now = Date.now();
      while (recentStarts.length > 0 && now - recentStarts[0]! >= 1_000) {
        recentStarts.shift();
      }

      if (recentStarts.length >= MAX_REQUESTS_PER_SECOND) {
        const waitMs = Math.max(1, 1_000 - (now - recentStarts[0]!));
        await sleepMs(waitMs);
        continue;
      }

      const item = queue.shift()!;
      recentStarts.push(Date.now());
      try {
        item.resolve(await item.fn());
      } catch (err) {
        item.reject(err);
      }
    }
  } finally {
    draining = false;
    if (queue.length > 0) {
      void drainQueue();
    }
  }
}

/**
 * Serialize Delta REST calls behind a global token bucket (~10 req/s by default).
 * All signed and public Delta axios traffic should pass through this.
 */
export function scheduleDeltaRestRequest<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queue.push({
      fn,
      resolve: resolve as (value: unknown) => void,
      reject,
    });
    void drainQueue();
  });
}
