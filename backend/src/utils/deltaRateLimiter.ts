import axios from "axios";

/** Hard cap on Delta India REST requests — shared across all services. */
const MAX_REQUESTS_PER_SECOND = Number(
  process.env.DELTA_REST_MAX_RPS ?? 3,
);

const CDN_PAUSE_SAFETY_BUFFER_MS = 5_000;
/** Fallback when CDN 429 lacks `limit_reset_in` (Delta message: retry after 5 minutes). */
const CDN_PAUSE_DEFAULT_MS = 300_000;

export class DeltaRestPausedError extends Error {
  readonly pauseReason: "cdn" | "manual";

  constructor(message: string, pauseReason: "cdn" | "manual" = "cdn") {
    super(message);
    this.name = "DeltaRestPausedError";
    this.pauseReason = pauseReason;
  }
}

export function isDeltaRestPausedError(err: unknown): err is DeltaRestPausedError {
  return err instanceof DeltaRestPausedError;
}

type QueueItem<T> = {
  fn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

const queue: QueueItem<unknown>[] = [];
const recentStarts: number[] = [];
let draining = false;

let cdnPauseUntilMs = 0;
let cdnResumeTimer: ReturnType<typeof setTimeout> | null = null;
let manualPauseEnabled = false;

function pauseMessage(): string {
  if (manualPauseEnabled) {
    return "API Paused globally — admin kill switch active";
  }
  return "API Paused globally due to CDN limit";
}

function rejectIfPaused<T>(): DeltaRestPausedError | null {
  if (!isDeltaRestApiPaused()) return null;
  return new DeltaRestPausedError(
    pauseMessage(),
    manualPauseEnabled ? "manual" : "cdn",
  );
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function armCdnResumeTimer(): void {
  if (cdnResumeTimer != null) {
    clearTimeout(cdnResumeTimer);
    cdnResumeTimer = null;
  }
  const waitMs = cdnPauseUntilMs - Date.now();
  if (waitMs <= 0) {
    cdnPauseUntilMs = 0;
    return;
  }
  cdnResumeTimer = setTimeout(() => {
    cdnResumeTimer = null;
    cdnPauseUntilMs = 0;
    console.log("[delta-rest] CDN REST pause lifted — resuming queue");
    if (queue.length > 0) {
      void drainQueue();
    }
  }, waitMs);
}

/**
 * Pause all Delta REST traffic after a CDN-level 429.
 * Extends an existing pause when a longer reset window is reported.
 */
export function pauseDeltaRestApiForCdn(resetMs: number, source?: string): void {
  const safeMs =
    Number.isFinite(resetMs) && resetMs > 0 ? resetMs : CDN_PAUSE_DEFAULT_MS;
  const resumeAt = Date.now() + safeMs + CDN_PAUSE_SAFETY_BUFFER_MS;
  const extended = resumeAt > cdnPauseUntilMs;
  cdnPauseUntilMs = Math.max(cdnPauseUntilMs, resumeAt);

  if (extended) {
    console.warn(
      `[delta-rest] CDN rate limit (${source ?? "429"}) — pausing all REST for ` +
        `${Math.ceil((cdnPauseUntilMs - Date.now()) / 1000)}s ` +
        `(reset=${Math.ceil(safeMs / 1000)}s + ${CDN_PAUSE_SAFETY_BUFFER_MS / 1000}s buffer)`,
    );
  }
  armCdnResumeTimer();
}

/** Admin kill switch — blocks every outgoing Delta REST call while enabled. */
export function setDeltaRestApiManualPause(enabled: boolean): void {
  manualPauseEnabled = enabled;
  if (enabled) {
    console.warn("[delta-rest] Admin manual REST API pause ENABLED");
  } else {
    console.log("[delta-rest] Admin manual REST API pause DISABLED");
    if (queue.length > 0) {
      void drainQueue();
    }
  }
}

export function isDeltaRestApiManualPauseEnabled(): boolean {
  return manualPauseEnabled;
}

/** True while CDN auto-pause or admin kill switch is active. */
export function isDeltaRestApiPaused(): boolean {
  if (manualPauseEnabled) return true;
  if (cdnPauseUntilMs > Date.now()) return true;
  if (cdnPauseUntilMs > 0 && cdnPauseUntilMs <= Date.now()) {
    cdnPauseUntilMs = 0;
  }
  return false;
}

export function getDeltaRestPauseStatus(): {
  paused: boolean;
  manualPause: boolean;
  cdnPauseActive: boolean;
  cdnPauseUntil: string | null;
  resumeInMs: number | null;
} {
  const now = Date.now();
  const cdnActive = cdnPauseUntilMs > now;
  const paused = manualPauseEnabled || cdnActive;
  return {
    paused,
    manualPause: manualPauseEnabled,
    cdnPauseActive: cdnActive,
    cdnPauseUntil: cdnActive ? new Date(cdnPauseUntilMs).toISOString() : null,
    resumeInMs: cdnActive ? cdnPauseUntilMs - now : null,
  };
}

function readLimitResetMs(obj: Record<string, unknown>): number | null {
  const raw =
    obj.limit_reset_in ??
    obj.limit_reset_ms ??
    obj.limitResetIn ??
    obj.limitResetMs;
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function bodyIndicatesCdnLimit(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("cdn_rate_limit_breached") ||
    lower.includes("internal rate limit exceeded")
  );
}

/**
 * Extract CDN pause duration (ms) from a Delta 429 response.
 * Returns null for ordinary (non-CDN) rate limits.
 */
export function extractCdnRateLimitPauseMs(err: unknown): number | null {
  if (!axios.isAxiosError(err) || err.response?.status !== 429) {
    return null;
  }

  const data = err.response.data;
  const layers: unknown[] = [data];
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const row = data as Record<string, unknown>;
    if (row.error != null) layers.push(row.error);
    if (row.result != null) layers.push(row.result);
  }

  let sawCdnSignal = false;
  let resetMs: number | null = null;

  for (const layer of layers) {
    if (layer == null) continue;
    if (typeof layer === "string") {
      if (bodyIndicatesCdnLimit(layer)) sawCdnSignal = true;
      continue;
    }
    if (typeof layer !== "object") continue;

    const row = layer as Record<string, unknown>;
    const fromField = readLimitResetMs(row);
    if (fromField != null) resetMs = fromField;

    const code = String(row.code ?? row.error_code ?? "").toLowerCase();
    if (code.includes("cdn") || code.includes("rate_limit")) {
      sawCdnSignal = true;
    }

    const msg = String(row.message ?? row.msg ?? "");
    if (bodyIndicatesCdnLimit(msg)) sawCdnSignal = true;
  }

  const serialized =
    typeof data === "string" ? data : JSON.stringify(data ?? "");
  if (bodyIndicatesCdnLimit(serialized)) sawCdnSignal = true;

  if (resetMs != null) {
    return resetMs;
  }
  if (sawCdnSignal) {
    return CDN_PAUSE_DEFAULT_MS;
  }
  return null;
}

export function handleDeltaCdn429(err: unknown): boolean {
  const resetMs = extractCdnRateLimitPauseMs(err);
  if (resetMs == null) return false;
  pauseDeltaRestApiForCdn(resetMs, "cdn_rate_limit_breached");
  return true;
}

async function drainQueue(): Promise<void> {
  if (draining) return;
  draining = true;

  try {
    while (queue.length > 0) {
      const pausedErr = rejectIfPaused();
      if (pausedErr) {
        const item = queue.shift()!;
        item.reject(pausedErr);
        continue;
      }

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
  const pausedErr = rejectIfPaused();
  if (pausedErr) {
    return Promise.reject(pausedErr);
  }

  return new Promise<T>((resolve, reject) => {
    queue.push({
      fn,
      resolve: resolve as (value: unknown) => void,
      reject,
    });
    void drainQueue();
  });
}
