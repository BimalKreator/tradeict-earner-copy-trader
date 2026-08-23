import cron from "node-cron";

export type CronGuardOptions = {
  timezone?: string;
  /** Multiplier of estimated interval before logging a slow-cycle ERROR. Default 3. */
  slowThresholdMultiplier?: number;
};

export type CronStatusSnapshot = {
  name: string;
  schedule: string;
  timezone: string | null;
  intervalMs: number | null;
  running: boolean;
  runningSince: string | null;
  runningForMs: number | null;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastDurationMs: number | null;
  lastSuccess: boolean | null;
  lastError: string | null;
  runCount: number;
  skipCount: number;
};

type CronRegistryEntry = {
  name: string;
  schedule: string;
  timezone: string | null;
  intervalMs: number | null;
  slowThresholdMs: number | null;
  running: boolean;
  startedAtMs: number | null;
  lastStartedAt: Date | null;
  lastFinishedAt: Date | null;
  lastDurationMs: number | null;
  lastSuccess: boolean | null;
  lastError: string | null;
  runCount: number;
  skipCount: number;
};

const registry = new Map<string, CronRegistryEntry>();

/** Estimate cron interval in ms for slow-cycle detection (best-effort). */
export function estimateCronIntervalMs(schedule: string): number | null {
  const everyMinutes = schedule.match(/^\*\/(\d+) \* \* \* \*$/);
  if (everyMinutes) {
    const n = Number.parseInt(everyMinutes[1]!, 10);
    if (Number.isFinite(n) && n > 0) return n * 60_000;
  }

  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  if (minute?.startsWith("*/")) {
    const n = Number.parseInt(minute.slice(2), 10);
    if (Number.isFinite(n) && n > 0) return n * 60_000;
  }

  // Hourly at a fixed minute.
  if (hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return 3_600_000;
  }

  // Daily at a fixed time.
  if (
    hour !== "*" &&
    dayOfMonth === "*" &&
    month === "*" &&
    dayOfWeek === "*"
  ) {
    return 86_400_000;
  }

  // Monthly (1st of month or similar).
  if (dayOfMonth !== "*" && month === "*") {
    return 30 * 86_400_000;
  }

  return null;
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? err.message;
  }
  return String(err);
}

export function getCronStatusSnapshots(): CronStatusSnapshot[] {
  const now = Date.now();
  return [...registry.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => ({
      name: entry.name,
      schedule: entry.schedule,
      timezone: entry.timezone,
      intervalMs: entry.intervalMs,
      running: entry.running,
      runningSince: entry.lastStartedAt?.toISOString() ?? null,
      runningForMs:
        entry.running && entry.startedAtMs != null
          ? now - entry.startedAtMs
          : null,
      lastStartedAt: entry.lastStartedAt?.toISOString() ?? null,
      lastFinishedAt: entry.lastFinishedAt?.toISOString() ?? null,
      lastDurationMs: entry.lastDurationMs,
      lastSuccess: entry.lastSuccess,
      lastError: entry.lastError,
      runCount: entry.runCount,
      skipCount: entry.skipCount,
    }));
}

/**
 * Schedule a cron job with re-entrancy protection, timing logs, and in-memory
 * status tracking for admin observability.
 */
export function guardedCron(
  name: string,
  schedule: string,
  fn: () => void | Promise<unknown>,
  opts?: CronGuardOptions,
): void {
  const timezone = opts?.timezone ?? null;
  const intervalMs = estimateCronIntervalMs(schedule);
  const slowMultiplier = opts?.slowThresholdMultiplier ?? 3;
  const slowThresholdMs =
    intervalMs != null ? intervalMs * slowMultiplier : null;

  const entry: CronRegistryEntry = {
    name,
    schedule,
    timezone,
    intervalMs,
    slowThresholdMs,
    running: false,
    startedAtMs: null,
    lastStartedAt: null,
    lastFinishedAt: null,
    lastDurationMs: null,
    lastSuccess: null,
    lastError: null,
    runCount: 0,
    skipCount: 0,
  };
  registry.set(name, entry);

  const scheduleOpts = timezone ? { timezone } : undefined;

  cron.schedule(
    schedule,
    () => {
      if (entry.running) {
        const elapsedSec =
          entry.startedAtMs != null
            ? Math.round((Date.now() - entry.startedAtMs) / 1000)
            : 0;
        console.warn(
          `[Cron] ${name} skipped -- previous cycle still running ` +
            `(started ${entry.lastStartedAt?.toISOString() ?? "unknown"}, ${elapsedSec}s ago)`,
        );
        entry.skipCount += 1;
        return;
      }

      entry.running = true;
      entry.startedAtMs = Date.now();
      entry.lastStartedAt = new Date();
      console.info(`[Cron] ${name} started`);

      void (async () => {
        try {
          await fn();
          entry.lastSuccess = true;
          entry.lastError = null;
        } catch (err) {
          entry.lastSuccess = false;
          entry.lastError = formatError(err);
          console.error(`[Cron] ${name} failed:`, err);
        } finally {
          const finishedAt = Date.now();
          const durationMs =
            entry.startedAtMs != null ? finishedAt - entry.startedAtMs : 0;
          entry.lastDurationMs = durationMs;
          entry.lastFinishedAt = new Date();
          entry.runCount += 1;
          entry.running = false;
          entry.startedAtMs = null;

          console.info(
            `[Cron] ${name} finished in ${durationMs}ms success=${entry.lastSuccess === true}`,
          );

          if (
            slowThresholdMs != null &&
            durationMs > slowThresholdMs &&
            entry.lastSuccess === true
          ) {
            console.error(
              `[Cron] ${name} slow cycle: ${durationMs}ms exceeds ${slowThresholdMs}ms ` +
                `(>${slowMultiplier}x estimated interval) — overlap risk`,
            );
          }
        }
      })();
    },
    scheduleOpts,
  );
}
