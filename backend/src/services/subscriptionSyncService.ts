import type { PrismaClient } from "@prisma/client";

export const SUBSCRIPTION_SYNC_STATUS = {
  SYNCED: "SYNCED",
  PENDING: "PENDING",
  /** Legacy — treat like FAILED for reconcile skip. */
  ERROR: "ERROR",
  FAILED: "FAILED",
} as const;

export type SubscriptionSyncStatus =
  (typeof SUBSCRIPTION_SYNC_STATUS)[keyof typeof SUBSCRIPTION_SYNC_STATUS];

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
const MASTER_FLATTING_BLOCK_MS = 10_000;
const masterFlattingUntilByStrategy = new Map<string, number>();

/** Engage a short-lived lock after master flat close starts (prevents ghost catch-up opens). */
export function markMasterFlatting(
  strategyId: string,
  durationMs: number = MASTER_FLATTING_BLOCK_MS,
): void {
  masterFlattingUntilByStrategy.set(strategyId, Date.now() + durationMs);
}

/** True while the master flatting window is active for this strategy. */
export function isMasterFlatting(strategyId: string): boolean {
  const until = masterFlattingUntilByStrategy.get(strategyId);
  if (until == null) return false;
  if (Date.now() >= until) {
    masterFlattingUntilByStrategy.delete(strategyId);
    return false;
  }
  return true;
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
