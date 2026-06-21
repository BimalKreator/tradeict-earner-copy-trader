/**
 * Copy-trading sync policy — professional lag handling.
 *
 * Rules:
 * 1. WebSocket closing hints trigger {@link runPriorityFlatVerificationRestFetch}
 *    (one REST fetch; streak treated as verified → immediate notifyMasterFlat).
 * 2. Pure REST polling with no WS hint keeps 4-miss / 20s hysteresis.
 * 3. Master Delta REST open positions remain authority — closes still re-check REST once.
 * 4. Never trim followers to zero on a single laggy empty REST read without hints.
 */

/** Minimum time a master leg must be absent from REST before follower close (REST-only). */
export const COPY_FLAT_CONFIRM_MS = 20_000;

/** WS-hinted flat: no extra wait after REST confirms missing (streak=1). */
export const COPY_FLAT_WS_CONFIRM_MS = 0;

/** Consecutive REST misses with WS flat hint before follower close. */
export const COPY_FLAT_WS_MISS_POLLS_REQUIRED = 1;

/** Consecutive REST misses without WS hint (pure REST fallback). */
export const COPY_FLAT_MISS_POLLS_REQUIRED = 4;

/** WS flat hints older than this are ignored for the fast close path. */
export const COPY_WS_HINT_MAX_AGE_MS = 120_000;

/** Consecutive empty master REST books before orphan follower reconcile. */
export const COPY_EMPTY_BOOK_POLLS_REQUIRED = 4;

/** After hedge roll WS noise, suppress flat detection for this symbol. */
export const COPY_ROLL_SUPPRESS_MS = 90_000;

/** Background master REST poll interval (WS hints trigger immediate poll). */
export const COPY_MASTER_REST_POLL_MS = 15_000;

/** Follower qty align pass interval (SYNC-MONITOR fallback — WS is primary). */
export const COPY_QTY_RECONCILE_MS = 30_000;

/** Debounce burst WS hints into one REST poll (avoid event-loop choke). */
export const COPY_REST_IMMEDIATE_DEBOUNCE_MS = 2_500;

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
  wsHinted?: boolean;
  refMs?: number;
}): boolean {
  const refMs = args.refMs ?? Date.now();
  const wsHinted = args.wsHinted === true;
  const missRequired = wsHinted
    ? COPY_FLAT_WS_MISS_POLLS_REQUIRED
    : COPY_FLAT_MISS_POLLS_REQUIRED;
  const confirmMs = wsHinted ? COPY_FLAT_WS_CONFIRM_MS : COPY_FLAT_CONFIRM_MS;

  if (args.missStreak < missRequired) {
    return true;
  }
  if (args.firstMissingSinceMs == null) {
    return true;
  }
  return refMs - args.firstMissingSinceMs < confirmMs;
}

export function masterLegCloseHasActiveWsHint(
  wsHintAgeMs: number | null,
): boolean {
  return (
    wsHintAgeMs != null &&
    wsHintAgeMs >= 0 &&
    wsHintAgeMs <= COPY_WS_HINT_MAX_AGE_MS
  );
}
