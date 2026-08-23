const UNCaught_EXIT_THRESHOLD = 3;
const UNCaught_WINDOW_MS = 60_000;

let uncaughtTimestamps: number[] = [];

function logProcessError(label: string, err: unknown): void {
  console.error(`[Process] ${label}:`, err);
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
}

/**
 * Keeps the API process alive on isolated async failures while still exiting
 * when uncaught exceptions repeat (likely corrupted runtime state).
 */
export function installProcessHandlers(): void {
  process.on("unhandledRejection", (reason) => {
    logProcessError("Unhandled promise rejection (process kept alive)", reason);
  });

  process.on("uncaughtException", (err) => {
    logProcessError("Uncaught exception", err);

    const now = Date.now();
    uncaughtTimestamps = uncaughtTimestamps.filter(
      (ts) => now - ts < UNCaught_WINDOW_MS,
    );
    uncaughtTimestamps.push(now);

    if (uncaughtTimestamps.length >= UNCaught_EXIT_THRESHOLD) {
      console.error(
        `[Process] ${UNCaught_EXIT_THRESHOLD} uncaught exceptions within ${UNCaught_WINDOW_MS}ms — shutting down`,
      );
      process.exit(1);
    } else {
      console.error(
        "[Process] Uncaught exception absorbed — process continues (will exit after repeated failures)",
      );
    }
  });
}
