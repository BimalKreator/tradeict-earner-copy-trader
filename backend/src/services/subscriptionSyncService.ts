import type { PrismaClient } from "@prisma/client";
import { tradePositionSymbolsAlign } from "./tradePositionService.js";

export const SUBSCRIPTION_SYNC_STATUS = {
  SYNCED: "SYNCED",
  PENDING: "PENDING",
  /** Legacy — treat like FAILED for reconcile skip. */
  ERROR: "ERROR",
  FAILED: "FAILED",
} as const;

export type SubscriptionSyncStatus =
  (typeof SUBSCRIPTION_SYNC_STATUS)[keyof typeof SUBSCRIPTION_SYNC_STATUS];

type TradeSide = "BUY" | "SELL";

const HARD_ERROR_FRAGMENTS = [
  "INSUFFICIENT_MARGIN",
  "INSUFFICIENT_BALANCE",
  "INSUFFICIENT_FUNDS",
  "NOT_ENOUGH_MARGIN",
  "NOT_ENOUGH_BALANCE",
];

function isHardMarginError(message: string): boolean {
  const u = message.toUpperCase();
  return HARD_ERROR_FRAGMENTS.some((p) => u.includes(p));
}

/** Map exchange / engine errors to a short label for admin UI. */
export function formatSubscriptionSyncError(error?: string | null): string {
  if (!error?.trim()) return "Execution Failed";
  if (isHardMarginError(error)) return "Insufficient Funds";
  const u = error.toUpperCase();
  if (u.includes("NO API") || u.includes("CREDENTIAL")) {
    return "No API Credentials";
  }
  if (u.includes("SLIPPAGE")) return "Slippage Exceeded";
  if (u.includes("PAUSED")) return "Strategy Paused";
  return error.trim().slice(0, 500);
}

/** True when automatic qty reconciliation must not retry this subscriber. */
export function subscriptionSyncBlocksReconcile(syncStatus: string): boolean {
  return (
    syncStatus === SUBSCRIPTION_SYNC_STATUS.FAILED ||
    syncStatus === SUBSCRIPTION_SYNC_STATUS.ERROR
  );
}

export async function markSubscriptionSyncPending(
  prisma: PrismaClient,
  args: { userId: string; strategyId: string },
): Promise<void> {
  await prisma.userStrategySubscription.updateMany({
    where: { userId: args.userId, strategyId: args.strategyId },
    data: {
      syncStatus: SUBSCRIPTION_SYNC_STATUS.PENDING,
      syncError: null,
    },
  });
}

export async function markSubscriptionSynced(
  prisma: PrismaClient,
  args: { userId: string; strategyId: string },
): Promise<void> {
  await prisma.userStrategySubscription.updateMany({
    where: { userId: args.userId, strategyId: args.strategyId },
    data: {
      syncStatus: SUBSCRIPTION_SYNC_STATUS.SYNCED,
      syncError: null,
    },
  });
}

export async function markSubscriptionSyncFailed(
  prisma: PrismaClient,
  args: { userId: string; strategyId: string; error: string },
): Promise<void> {
  const syncError = args.error.trim().slice(0, 2000) || "Execution Failed";
  await prisma.userStrategySubscription.updateMany({
    where: { userId: args.userId, strategyId: args.strategyId },
    data: {
      syncStatus: SUBSCRIPTION_SYNC_STATUS.FAILED,
      syncError,
    },
  });
}

/** Block SYNC-MONITOR / reconcile opens while master flat close is in flight. */
const MASTER_FLATTING_BLOCK_MS = 60_000;
const masterFlattingUntilByStrategy = new Map<string, number>();
const legClosingUntilByKey = new Map<string, number>();

function legClosingKey(
  strategyId: string,
  symbol: string,
  side: TradeSide,
): string {
  return `${strategyId}|${symbol.trim().toUpperCase()}|${side}`;
}

function pruneExpiredLocks(now = Date.now()): void {
  for (const [strategyId, until] of masterFlattingUntilByStrategy) {
    if (now >= until) masterFlattingUntilByStrategy.delete(strategyId);
  }
  for (const [key, until] of legClosingUntilByKey) {
    if (now >= until) legClosingUntilByKey.delete(key);
  }
}

/**
 * Engage (or extend) a strategy-wide lock after master flat close starts.
 * Prevents ghost catch-up opens racing with close fan-out.
 */
export function markMasterFlatting(
  strategyId: string,
  durationMs: number = MASTER_FLATTING_BLOCK_MS,
): void {
  const until = Date.now() + durationMs;
  const prev = masterFlattingUntilByStrategy.get(strategyId) ?? 0;
  masterFlattingUntilByStrategy.set(strategyId, Math.max(prev, until));
}

/** Per-leg close lock — refreshed on each notifyMasterFlat / WS flat hint. */
export function markLegClosing(
  strategyId: string,
  symbol: string,
  side: TradeSide,
  durationMs: number = MASTER_FLATTING_BLOCK_MS,
): void {
  const until = Date.now() + durationMs;
  const key = legClosingKey(strategyId, symbol, side);
  const prev = legClosingUntilByKey.get(key) ?? 0;
  legClosingUntilByKey.set(key, Math.max(prev, until));
  markMasterFlatting(strategyId, durationMs);
}

/** True while the master flatting window is active for this strategy. */
export function isMasterFlatting(strategyId: string): boolean {
  pruneExpiredLocks();
  const until = masterFlattingUntilByStrategy.get(strategyId);
  if (until == null) return false;
  return Date.now() < until;
}

/** True while a specific master leg is being closed (symbol aliases included). */
export function isLegClosingBlocked(
  strategyId: string,
  symbol: string,
  side: TradeSide,
): boolean {
  pruneExpiredLocks();
  const now = Date.now();
  const sym = symbol.trim().toUpperCase();
  for (const [key, until] of legClosingUntilByKey) {
    if (now >= until) continue;
    const parts = key.split("|");
    if (parts.length !== 3) continue;
    const [sid, storedSym, storedSide] = parts as [string, string, TradeSide];
    if (sid !== strategyId || storedSide !== side) continue;
    if (storedSym === sym || tradePositionSymbolsAlign(symbol, storedSym)) {
      return true;
    }
  }
  return false;
}

/** SYNC-MONITOR and reconcile must not place new open legs while this is true. */
export function syncMonitorOpensBlocked(strategyId: string): boolean {
  return isMasterFlatting(strategyId);
}

export async function markSubscriptionSyncError(
  prisma: PrismaClient,
  args: {
    userId: string;
    strategyId: string;
    error?: string | null;
    label?: string;
  },
): Promise<void> {
  const syncError =
    args.label ??
    (args.error?.trim() ? args.error.trim().slice(0, 2000) : "Execution Failed");
  await prisma.userStrategySubscription.updateMany({
    where: { userId: args.userId, strategyId: args.strategyId },
    data: {
      syncStatus: SUBSCRIPTION_SYNC_STATUS.FAILED,
      syncError,
    },
  });
}
