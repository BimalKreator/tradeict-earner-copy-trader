/**
 * Copy-trading sync policy — professional lag handling.
 *
 * Rules:
 * 1. WebSocket events are HINTS only (schedule REST poll, never close on WS alone).
 * 2. Master Delta REST open positions are the sole authority for opens/closes/target qty.
 * 3. Follower closes require consecutive REST misses + time + re-check (hysteresis).
 * 4. Never trim followers to zero because master REST was empty on a single laggy read.
 */

/** Minimum time a master leg must be absent from REST before follower close. */
export const COPY_FLAT_CONFIRM_MS = 20_000;

/** Same minimum when WS also hinted flat (no fast-path close). */
export const COPY_FLAT_WS_CONFIRM_MS = 20_000;

/** Consecutive successful REST polls with leg missing before flat close. */
export const COPY_FLAT_MISS_POLLS_REQUIRED = 4;

/** Consecutive empty master REST books before orphan follower reconcile. */
export const COPY_EMPTY_BOOK_POLLS_REQUIRED = 4;

/** After hedge roll WS noise, suppress flat detection for this symbol. */
export const COPY_ROLL_SUPPRESS_MS = 90_000;

/** Background master REST poll interval (WS hints trigger immediate poll). */
export const COPY_MASTER_REST_POLL_MS = 15_000;

/** Follower qty align pass interval. */
export const COPY_QTY_RECONCILE_MS = 30_000;

/** Debounce burst WS hints into one REST poll. */
export const COPY_REST_IMMEDIATE_DEBOUNCE_MS = 350;

/** Per-leg REST force-copy cooldown. */
export const COPY_FORCE_SYNC_COOLDOWN_MS = 45_000;

/**
 * True when master REST book is empty but we should NOT close followers yet (lag window).
 */
export function deferCloseOnEmptyMasterBook(args: {
  emptyBookPollStreak: number;
  emptyBookSinceMs: number | null;
  refMs?: number;
}): boolean {
  const refMs = args.refMs ?? Date.now();
  if (args.emptyBookPollStreak < COPY_EMPTY_BOOK_POLLS_REQUIRED) {
    return true;
  }
  if (args.emptyBookSinceMs == null) {
    return true;
  }
  return refMs - args.emptyBookSinceMs < COPY_FLAT_CONFIRM_MS;
}

/**
 * True when a follower leg should NOT be trimmed just because master REST omitted it once.
 */
export function deferFollowerTrimMasterLegAbsent(masterLegOnRest: boolean): boolean {
  return !masterLegOnRest;
}

/**
 * True when flat close gates are not yet satisfied for a tracked master leg.
 */
export function deferFollowerCloseMissingMasterLeg(args: {
  missStreak: number;
  firstMissingSinceMs: number | null;
  refMs?: number;
}): boolean {
  const refMs = args.refMs ?? Date.now();
  if (args.missStreak < COPY_FLAT_MISS_POLLS_REQUIRED) {
    return true;
  }
  if (args.firstMissingSinceMs == null) {
    return true;
  }
  return refMs - args.firstMissingSinceMs < COPY_FLAT_CONFIRM_MS;
}
