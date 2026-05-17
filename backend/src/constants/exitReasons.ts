/** Canonical exit / failure reasons persisted on `Trade.exitReason`. */
export const EXIT_REASON = {
  AUTO_EXIT_TARGET: "Auto-Exit Target Hit",
  AUTO_EXIT_STOP_LOSS: "Auto-Exit Stop Loss Hit",
  ADMIN_PANEL: "Closed via Admin Panel",
  EXTERNAL_DELTA:
    "Closed Externally on Delta Exchange (Manual/Liquidation)",
  INSUFFICIENT_MARGIN: "Insufficient Margin (Failed)",
  MASTER_CLOSED: "Master Closed",
  SLIPPAGE_EXCEEDED: "Slippage Exceeded (Failed)",
  NO_API_CREDENTIALS: "No API Credentials (Failed)",
  EXECUTION_FAILED: "Execution Failed",
  RECONCILE_GHOST: "Master Closed (Reconcile)",
} as const;

export type ExitReasonValue = (typeof EXIT_REASON)[keyof typeof EXIT_REASON];

const PENDING_TTL_MS = 120_000;
const BOT_INITIATED_TTL_MS = 120_000;

type TimedReason = { reason: ExitReasonValue; expiresAt: number };

const pendingByStrategy = new Map<string, TimedReason>();

/** strategyId:SYMBOL_ALIAS → reason the bot registered before placing a close order */
const botInitiatedCloses = new Map<string, TimedReason>();

function symbolAliasSet(raw: string): Set<string> {
  const u = raw.trim().toUpperCase();
  const out = new Set<string>();
  if (!u) return out;
  out.add(u);
  if (u.startsWith("C-") || u.startsWith("P-")) return out;
  if (u.endsWith("USDT")) out.add(`${u.slice(0, -4)}USD`);
  if (u.endsWith("USD") && !u.endsWith("USDT")) out.add(`${u.slice(0, -3)}USDT`);
  return out;
}

function botCloseKeys(strategyId: string, symbol: string): string[] {
  return Array.from(symbolAliasSet(symbol)).map((alias) => `${strategyId}:${alias}`);
}

export function setPendingStrategyExitReason(
  strategyId: string,
  reason: ExitReasonValue,
): void {
  pendingByStrategy.set(strategyId, {
    reason,
    expiresAt: Date.now() + PENDING_TTL_MS,
  });
}

/** Returns a pending close reason for this strategy if still within the TTL window. */
export function peekPendingStrategyExitReason(
  strategyId: string,
): ExitReasonValue | null {
  const entry = pendingByStrategy.get(strategyId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    pendingByStrategy.delete(strategyId);
    return null;
  }
  return entry.reason;
}

/**
 * Register that the bot is about to close this symbol on the master account.
 * WS `positions delete` will match against this cache to distinguish bot vs external closes.
 */
export function markBotInitiatedClose(
  strategyId: string,
  symbol: string,
  reason: ExitReasonValue,
): void {
  const expiresAt = Date.now() + BOT_INITIATED_TTL_MS;
  for (const key of botCloseKeys(strategyId, symbol)) {
    botInitiatedCloses.set(key, { reason, expiresAt });
  }
}

/** Read bot-initiated close reason without removing it (safe for duplicate WS events). */
export function peekBotInitiatedCloseReason(
  strategyId: string,
  symbol: string,
): ExitReasonValue | null {
  const keys = botCloseKeys(strategyId, symbol);
  for (const key of keys) {
    const entry = botInitiatedCloses.get(key);
    if (!entry) continue;
    if (Date.now() > entry.expiresAt) {
      botInitiatedCloses.delete(key);
      continue;
    }
    return entry.reason;
  }
  return null;
}

/** Clears bot-initiated markers after a close has been processed. */
export function consumeBotInitiatedCloseReason(
  strategyId: string,
  symbol: string,
): ExitReasonValue | null {
  const reason = peekBotInitiatedCloseReason(strategyId, symbol);
  if (!reason) return null;
  for (const key of botCloseKeys(strategyId, symbol)) {
    botInitiatedCloses.delete(key);
  }
  return reason;
}

/** Resolve closure origin for master flat → follower fan-out (same reason for all followers). */
export function resolveClosureOrigin(
  strategyId: string,
  symbol: string,
  explicit?: ExitReasonValue | null,
): ExitReasonValue {
  if (explicit) return explicit;
  const botReason = peekBotInitiatedCloseReason(strategyId, symbol);
  if (botReason) return botReason;
  return EXIT_REASON.EXTERNAL_DELTA;
}

export function resolveCloseExitReason(
  strategyId: string,
  symbol: string,
  explicit?: ExitReasonValue | null,
): ExitReasonValue {
  return resolveClosureOrigin(strategyId, symbol, explicit);
}
