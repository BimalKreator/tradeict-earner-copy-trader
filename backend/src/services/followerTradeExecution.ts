import type { PrismaClient } from "@prisma/client";
import { TradePositionStatus, TradeStatus } from "@prisma/client";
import {
  executeTrade,
  fetchDeltaOpenPositions,
  fetchDeltaTicker,
  isDeltaOptionProductId,
  type ExecuteTradeResult,
  type TradeSide,
} from "./exchangeService.js";
import { EXIT_REASON, type ExitReasonValue } from "../constants/exitReasons.js";
import { STRATEGY_SELECT_IS_ACTIVE } from "../prisma/strategySelect.js";
import {
  findActiveCopySubscriptionForUser,
  findActiveFutureHedgeCopySubscribers,
  followerLotsFromMaster,
  isStrategyCopyTradingActive,
  resolveCopySubscriptionCreds,
  resolveFutureHedgeStrategyId,
} from "./strategySubscriptionService.js";
import { resolveFutureHedgeStrategy } from "./futureHedgeService.js";
import { logUserActivity } from "./userActivityService.js";
import {
  markSubscriptionSynced,
  markSubscriptionSyncError,
  markSubscriptionSyncFailed,
  markSubscriptionSyncPending,
  subscriptionSyncBlocksReconcile,
} from "./subscriptionSyncService.js";
import {
  buildClientOrderId,
  buildStableCopyClientOrderId,
  closeTradePositionsForLeg,
  recordTradePositionOpen,
  sumOpenFollowerBotQuantity,
} from "./tradePositionService.js";

/** Wait after each successful order before re-checking positions. */
const POST_ORDER_VERIFY_WAIT_MS = 3_000;
const MAX_RETRIES = 3;

const HARD_ERROR_PATTERNS = [
  "INSUFFICIENT_MARGIN",
  "INSUFFICIENT_BALANCE",
  "INSUFFICIENT_FUNDS",
  "NOT_ENOUGH_MARGIN",
  "NOT_ENOUGH_BALANCE",
  "ACCOUNT_FROZEN",
  "ACCOUNT_SUSPENDED",
  "MARGIN_CALL",
  "insufficient_margin",
  "insufficient balance",
  "insufficient_balance",
  "account_frozen",
  "account is frozen",
  "frozen account",
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isHardExecutionError(message: string): boolean {
  const u = message.toUpperCase();
  return HARD_ERROR_PATTERNS.some((p) => u.includes(p.toUpperCase()));
}

function compactSymbolKey(s: string): string {
  return s.replace(/[/:]/g, "").toUpperCase();
}

function deltaPairBase(compactNoSlash: string): string | null {
  const u = compactNoSlash.toUpperCase();
  if (u.endsWith("USDT")) return u.slice(0, -4);
  if (u.endsWith("USD") && !u.endsWith("USDT")) return u.slice(0, -3);
  return null;
}

function symbolsAlign(tradeSymbol: string, positionKey: string): boolean {
  const a = compactSymbolKey(tradeSymbol);
  const b = compactSymbolKey(positionKey);
  if (a === b || a.endsWith(b) || b.endsWith(a)) return true;
  const ba = deltaPairBase(a);
  const bb = deltaPairBase(b);
  return ba != null && bb != null && ba === bb;
}

/** Open leg size in exchange **contract lots** (must match {@link executeTrade} amount). */
async function followerLegContracts(
  apiKeyStored: string,
  apiSecretStored: string,
  symbol: string,
  side: TradeSide,
): Promise<number> {
  const positions = await fetchDeltaOpenPositions(apiKeyStored, apiSecretStored);
  let max = 0;
  for (const p of positions) {
    if (!symbolsAlign(symbol, p.symbolKey)) continue;
    if (p.side !== side) continue;
    const lots = Math.abs(p.contracts);
    if (Number.isFinite(lots) && lots > max) max = lots;
  }
  return max;
}

async function notifyFollowerHardFailure(
  prisma: PrismaClient,
  userId: string,
  symbol: string,
  reason: string,
): Promise<void> {
  console.error(
    `[RETRY_LOOP] Hard error for user ${userId} on ${symbol}: ${reason}`,
  );
  await logUserActivity(prisma, {
    userId,
    kind: "TRADE_EXECUTION_FAILED",
    message: `Copy trade failed for ${symbol}: ${reason}`,
  });
}

export type FollowerExecuteResult = ExecuteTradeResult & {
  attempts: number;
  verified: boolean;
};

function percentSlippage(entry: number, market: number): number {
  if (entry <= 0) return Number.POSITIVE_INFINITY;
  return (Math.abs(market - entry) / entry) * 100;
}

function slippageBlocksCopy(
  symbol: string,
  entry: number,
  market: number,
  strategySlippagePct: number,
): boolean {
  if (isDeltaOptionProductId(symbol)) return false;
  return percentSlippage(entry, market) > strategySlippagePct;
}

async function persistCopyTradeRow(
  prisma: PrismaClient,
  args: {
    userId: string;
    strategyId: string;
    symbol: string;
    side: TradeSide;
    size: number;
    entryPrice: number;
    status: TradeStatus;
    tradingFee?: number;
    exitReason?: ExitReasonValue;
    clientOrderId?: string;
  },
): Promise<void> {
  const data = {
    userId: args.userId,
    strategyId: args.strategyId,
    symbol: args.symbol,
    side: args.side,
    size: args.size,
    entryPrice: args.entryPrice,
    status: args.status,
    ...(args.tradingFee != null ? { tradingFee: args.tradingFee } : {}),
    ...(args.exitReason ? { exitReason: args.exitReason } : {}),
    ...(args.clientOrderId ? { clientOrderId: args.clientOrderId } : {}),
  };

  if (args.clientOrderId) {
    const existing = await prisma.trade.findUnique({
      where: { clientOrderId: args.clientOrderId },
      select: { id: true, status: true },
    });
    if (existing) {
      await prisma.trade.update({
        where: { id: existing.id },
        data,
      });
      return;
    }
  }

  await prisma.trade.create({ data });
}

async function followerFillAlreadyCopied(
  prisma: PrismaClient,
  clientOrderId: string,
): Promise<boolean> {
  const trade = await prisma.trade.findUnique({
    where: { clientOrderId },
    select: { status: true },
  });
  if (trade?.status === TradeStatus.OPEN) {
    return true;
  }

  const leg = await prisma.tradePosition.findUnique({
    where: { clientOrderId },
    select: { status: true },
  });
  return leg?.status === TradePositionStatus.OPEN;
}

export type MasterOpenFillArgs = {
  symbol: string;
  side: TradeSide;
  masterLots: number;
  avgPrice: number;
  /** Master order id or fill fingerprint — one follower leg per key. */
  masterFillKey: string;
  /** REST force-sync: bypass slippage, syncStatus, and stable dedup gates. */
  forceRestSync?: boolean;
};

export type MasterCloseFillArgs = {
  symbol: string;
  side: TradeSide;
  masterLots: number;
  masterEntryPrice: number;
};

/** Gate all master→follower copy paths when the strategy is paused. */
export async function assertStrategyActiveForCopy(
  prisma: PrismaClient,
  strategyId: string,
): Promise<boolean> {
  const active = await isStrategyCopyTradingActive(prisma, strategyId);
  if (!active) {
    console.log(
      `[copy] Strategy paused — skipping copy/adjust strategyId=${strategyId}`,
    );
  }
  return active;
}

/**
 * Fan-out a master open fill to every active Future Hedge subscriber.
 * Follower size = floor(master lots × {@link UserStrategySubscription.multiplier}).
 */
export async function syncMasterOpenFillToFutureHedgeFollowers(
  prisma: PrismaClient,
  fill: MasterOpenFillArgs,
): Promise<{ strategyId: string; fanoutCount: number } | null> {
  if (fill.forceRestSync) {
    return forceSyncMasterOpenToFollowers(prisma, fill);
  }

  const strategy = await resolveFutureHedgeStrategy(prisma);
  if (!strategy.isActive) {
    console.log("[copy] Future Hedge paused — skip master open fan-out");
    return null;
  }
  if (!(await assertStrategyActiveForCopy(prisma, strategy.id))) {
    return null;
  }

  const strategyId = strategy.id;
  const subscribers = await findActiveFutureHedgeCopySubscribers(prisma);
  if (subscribers.length === 0) {
    console.log("[copy] No active Future Hedge subscribers for master open");
    return { strategyId, fanoutCount: 0 };
  }

  await recordTradePositionOpen(prisma, {
    isMaster: true,
    strategyId,
    symbol: fill.symbol,
    side: fill.side,
    quantity: fill.masterLots,
    entryPrice: fill.avgPrice,
  });

  const tick = await fetchDeltaTicker(fill.symbol);
  const marketPrice =
    tick.last != null && Number.isFinite(tick.last) ? tick.last : undefined;

  const skipAll =
    marketPrice !== undefined &&
    slippageBlocksCopy(
      fill.symbol,
      fill.avgPrice,
      marketPrice,
      strategy.slippage,
    );

  if (skipAll) {
    console.warn(
      `[copy] Slippage exceeded for ${fill.symbol}; skipping Future Hedge fan-out`,
    );
    await Promise.all(
      subscribers.map(async (sub) => {
        const lots = followerLotsFromMaster(fill.masterLots, sub);
        const clientOrderId = buildStableCopyClientOrderId({
          strategyId,
          userId: sub.userId,
          masterFillKey: fill.masterFillKey,
          symbol: fill.symbol,
          side: fill.side,
          leg: "open",
        });
        await markSubscriptionSyncError(prisma, {
          userId: sub.userId,
          strategyId,
          label: "Slippage Exceeded",
        });
        await persistCopyTradeRow(prisma, {
          userId: sub.userId,
          strategyId,
          symbol: fill.symbol,
          side: fill.side,
          size: lots,
          entryPrice: fill.avgPrice,
          status: TradeStatus.FAILED,
          exitReason: EXIT_REASON.SLIPPAGE_EXCEEDED,
          clientOrderId,
        });
      }),
    );
    return { strategyId, fanoutCount: subscribers.length };
  }

  await Promise.all(
    subscribers.map(async (sub) => {
      const lots = followerLotsFromMaster(fill.masterLots, sub);
      const clientOrderId = buildStableCopyClientOrderId({
        strategyId,
        userId: sub.userId,
        masterFillKey: fill.masterFillKey,
        symbol: fill.symbol,
        side: fill.side,
        leg: "open",
      });
      const creds = resolveCopySubscriptionCreds(sub);

      if (!creds) {
        await markSubscriptionSyncError(prisma, {
          userId: sub.userId,
          strategyId,
          label: "No API Credentials",
        });
        await persistCopyTradeRow(prisma, {
          userId: sub.userId,
          strategyId,
          symbol: fill.symbol,
          side: fill.side,
          size: lots,
          entryPrice: fill.avgPrice,
          status: TradeStatus.FAILED,
          exitReason: EXIT_REASON.NO_API_CREDENTIALS,
          clientOrderId,
        });
        return;
      }

      if (await followerFillAlreadyCopied(prisma, clientOrderId)) {
        console.log(
          `[copy] Skip duplicate master fill user=${sub.userId} ${fill.symbol} clientOrderId=${clientOrderId}`,
        );
        return;
      }

      if (subscriptionSyncBlocksReconcile(sub.syncStatus)) {
        console.log(
          `[copy] Skip user=${sub.userId} strategyId=${strategyId} — syncStatus=${sub.syncStatus} (admin re-sync required)`,
        );
        return;
      }

      console.log(
        `[copy] Future Hedge open user=${sub.userId} ${fill.symbol} ${fill.side} ` +
          `lots=${lots} (master ${fill.masterLots} × ${sub.multiplier}) clientOrderId=${clientOrderId}`,
      );

      await markSubscriptionSyncPending(prisma, {
        userId: sub.userId,
        strategyId,
      });

      const result = await executeFollowerTradeWithVerification(prisma, {
        strategyId,
        userId: sub.userId,
        apiKey: creds.apiKey,
        apiSecret: creds.apiSecret,
        symbol: fill.symbol,
        side: fill.side,
        size: lots,
        entryPrice: fill.avgPrice,
        clientOrderId,
      });

      if (result.success && result.verified) {
        await markSubscriptionSynced(prisma, {
          userId: sub.userId,
          strategyId,
        });
        await recordTradePositionOpen(prisma, {
          strategyId,
          userId: sub.userId,
          symbol: fill.symbol,
          side: fill.side,
          quantity: lots,
          entryPrice: fill.avgPrice,
          clientOrderId,
          ...(result.orderId ? { exchangeOrderId: result.orderId } : {}),
        });
      } else {
        await markSubscriptionSyncFailed(prisma, {
          userId: sub.userId,
          strategyId,
          error: result.error ?? "Copy trade execution failed",
        });
      }

      await persistCopyTradeRow(prisma, {
        userId: sub.userId,
        strategyId,
        symbol: fill.symbol,
        side: fill.side,
        size: lots,
        entryPrice: fill.avgPrice,
        status:
          result.success && result.verified
            ? TradeStatus.OPEN
            : TradeStatus.FAILED,
        tradingFee: result.success ? (result.feeCost ?? 0) : 0,
        clientOrderId,
        ...(!result.success || !result.verified
          ? {
              exitReason: isHardExecutionError(result.error ?? "")
                ? EXIT_REASON.INSUFFICIENT_MARGIN
                : EXIT_REASON.EXECUTION_FAILED,
            }
          : {}),
      });
    }),
  );

  return { strategyId, fanoutCount: subscribers.length };
}

/**
 * REST force-sync: align followers to master runtime positions using DB bot qty
 * as source of truth. Bypasses slippage, syncStatus blocks, and stable fill dedup.
 */
export async function forceSyncMasterOpenToFollowers(
  prisma: PrismaClient,
  fill: MasterOpenFillArgs,
): Promise<{ strategyId: string; fanoutCount: number } | null> {
  const strategy = await resolveFutureHedgeStrategy(prisma);
  if (!strategy.isActive) {
    console.log("[FORCE-SYNC] Future Hedge paused — skip force open sync");
    return null;
  }
  if (!(await assertStrategyActiveForCopy(prisma, strategy.id))) {
    return null;
  }

  const strategyId = strategy.id;
  const subscribers = await findActiveFutureHedgeCopySubscribers(prisma);
  if (subscribers.length === 0) {
    return { strategyId, fanoutCount: 0 };
  }

  const pending: Array<{
    sub: (typeof subscribers)[number];
    expectedLots: number;
  }> = [];

  for (const sub of subscribers) {
    const expectedLots = followerLotsFromMaster(fill.masterLots, sub);
    const actualLots = await sumOpenFollowerBotQuantity(prisma, {
      strategyId,
      userId: sub.userId,
      symbol: fill.symbol,
      side: fill.side,
    });
    if (actualLots <= 0 && expectedLots > 0) {
      pending.push({ sub, expectedLots });
    }
  }

  if (pending.length === 0) {
    return { strategyId, fanoutCount: 0 };
  }

  console.log(
    "[FORCE-SYNC] Forcing market open order synchronization for followers on symbol:",
    fill.symbol,
  );

  await recordTradePositionOpen(prisma, {
    isMaster: true,
    strategyId,
    symbol: fill.symbol,
    side: fill.side,
    quantity: fill.masterLots,
    entryPrice: fill.avgPrice,
  });

  let tickLast: number | undefined;
  try {
    const tick = await fetchDeltaTicker(fill.symbol);
    if (tick.last != null && Number.isFinite(tick.last)) {
      tickLast = tick.last;
    }
  } catch {
    /* use master entry */
  }
  const entryPrice =
    tickLast != null && tickLast > 0 ? tickLast : fill.avgPrice;

  await Promise.all(
    pending.map(async ({ sub, expectedLots }) => {
      const lots = Math.max(1, expectedLots);
      const creds = resolveCopySubscriptionCreds(sub);
      const clientOrderId = buildClientOrderId({
        strategyId,
        userId: sub.userId,
        symbol: fill.symbol,
      });

      if (!creds) {
        await persistCopyTradeRow(prisma, {
          userId: sub.userId,
          strategyId,
          symbol: fill.symbol,
          side: fill.side,
          size: lots,
          entryPrice,
          status: TradeStatus.FAILED,
          exitReason: EXIT_REASON.NO_API_CREDENTIALS,
          clientOrderId,
        });
        return;
      }

      console.log(
        `[FORCE-SYNC] market open user=${sub.userId} ${fill.symbol} ${fill.side} ` +
          `lots=${lots} (master ${fill.masterLots} × ${sub.multiplier})`,
      );

      const result = await executeFollowerTradeWithVerification(prisma, {
        strategyId,
        userId: sub.userId,
        apiKey: creds.apiKey,
        apiSecret: creds.apiSecret,
        symbol: fill.symbol,
        side: fill.side,
        size: lots,
        entryPrice,
        clientOrderId,
        forceRestSync: true,
      });

      if (result.success && result.verified) {
        await markSubscriptionSynced(prisma, {
          userId: sub.userId,
          strategyId,
        });
        await recordTradePositionOpen(prisma, {
          strategyId,
          userId: sub.userId,
          symbol: fill.symbol,
          side: fill.side,
          quantity: lots,
          entryPrice,
          clientOrderId,
          ...(result.orderId ? { exchangeOrderId: result.orderId } : {}),
        });
      } else {
        await markSubscriptionSyncFailed(prisma, {
          userId: sub.userId,
          strategyId,
          error: result.error ?? "Force-sync open failed",
        });
      }

      await persistCopyTradeRow(prisma, {
        userId: sub.userId,
        strategyId,
        symbol: fill.symbol,
        side: fill.side,
        size: lots,
        entryPrice,
        status:
          result.success && result.verified
            ? TradeStatus.OPEN
            : TradeStatus.FAILED,
        tradingFee: result.success ? (result.feeCost ?? 0) : 0,
        clientOrderId,
        ...(!result.success || !result.verified
          ? {
              exitReason: isHardExecutionError(result.error ?? "")
                ? EXIT_REASON.INSUFFICIENT_MARGIN
                : EXIT_REASON.EXECUTION_FAILED,
            }
          : {}),
      });
    }),
  );

  return { strategyId, fanoutCount: pending.length };
}

/**
 * Place reduce-only closes for each Future Hedge follower when the master leg flats.
 */
export async function syncMasterCloseToFutureHedgeFollowers(
  prisma: PrismaClient,
  snap: MasterCloseFillArgs,
  onFollowerClosed: (args: {
    userId: string;
    strategyId: string;
    symbol: string;
    side: TradeSide;
    masterEntryPrice: number;
    sizedPosition: number;
    exitPrice: number;
    exitFee: number;
    exitReason?: ExitReasonValue;
  }) => Promise<void>,
  options?: { exitReason?: ExitReasonValue },
): Promise<{ strategyId: string; fanoutCount: number } | null> {
  const strategyId = await resolveFutureHedgeStrategyId(prisma);
  if (!strategyId) return null;

  const strat = await prisma.strategy.findUnique({
    where: { id: strategyId },
    select: STRATEGY_SELECT_IS_ACTIVE,
  });
  if (!strat?.isActive) {
    console.log("[copy] Future Hedge paused — skip master close fan-out");
    return null;
  }
  if (!(await assertStrategyActiveForCopy(prisma, strategyId))) {
    return null;
  }

  await closeTradePositionsForLeg(prisma, {
    isMaster: true,
    strategyId,
    symbol: snap.symbol,
    side: snap.side,
  });

  const subscribers = await findActiveFutureHedgeCopySubscribers(prisma);
  const oppositeSide: TradeSide = snap.side === "BUY" ? "SELL" : "BUY";

  await Promise.all(
    subscribers.map(async (sub) => {
      const creds = resolveCopySubscriptionCreds(sub);
      if (!creds) return;

      const dbLots = await sumOpenFollowerBotQuantity(prisma, {
        strategyId,
        userId: sub.userId,
        symbol: snap.symbol,
        side: snap.side,
      });
      if (dbLots <= 0) {
        console.log(
          `[copy] Skip close user=${sub.userId} ${snap.symbol} ${snap.side} — no bot-managed OPEN qty in DB`,
        );
        return;
      }

      const lots = Math.max(1, Math.floor(dbLots));
      const closeClientOrderId = buildStableCopyClientOrderId({
        strategyId,
        userId: sub.userId,
        masterFillKey: `close:${snap.symbol}:${snap.side}:${lots}`,
        symbol: snap.symbol,
        side: oppositeSide,
        leg: "close",
      });

      console.log(
        `[copy] Future Hedge close user=${sub.userId} ${snap.symbol} ${oppositeSide} lots=${lots} (DB-managed qty)`,
      );

      const closeResult = await executeFollowerTradeWithVerification(prisma, {
        strategyId,
        userId: sub.userId,
        apiKey: creds.apiKey,
        apiSecret: creds.apiSecret,
        symbol: snap.symbol,
        side: oppositeSide,
        size: lots,
        reduceOnly: true,
        clientOrderId: closeClientOrderId,
      });

      if (!closeResult.success) {
        console.error(
          `[copy] follower close failed user=${sub.userId} ${snap.symbol}: ${closeResult.error ?? "unknown"}`,
        );
        return;
      }

      let exitPrice = closeResult.fillPrice ?? null;
      if (exitPrice == null || !Number.isFinite(exitPrice)) {
        try {
          const tick = await fetchDeltaTicker(snap.symbol);
          if (tick.last != null && Number.isFinite(tick.last)) {
            exitPrice = tick.last;
          }
        } catch {
          /* fallback below */
        }
      }
      if (exitPrice == null || !Number.isFinite(exitPrice)) {
        exitPrice =
          Number.isFinite(snap.masterEntryPrice) && snap.masterEntryPrice > 0
            ? snap.masterEntryPrice
            : 0;
      }

      await onFollowerClosed({
        userId: sub.userId,
        strategyId,
        symbol: snap.symbol,
        side: snap.side,
        masterEntryPrice: snap.masterEntryPrice,
        sizedPosition: lots,
        exitPrice,
        exitFee: closeResult.feeCost ?? 0,
        ...(options?.exitReason ? { exitReason: options.exitReason } : {}),
      });
    }),
  );

  return { strategyId, fanoutCount: subscribers.length };
}

async function placeFollowerOrder(
  apiKey: string,
  apiSecret: string,
  symbol: string,
  side: TradeSide,
  size: number,
  opts?: { reduceOnly?: boolean; clientOrderId?: string },
): Promise<ExecuteTradeResult> {
  try {
    return await executeTrade(apiKey, apiSecret, symbol, side, size, opts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[copy] createOrder threw for ${symbol}: ${message}`);
    return { success: false, error: message };
  }
}

async function markFollowerOrderFailure(
  prisma: PrismaClient,
  args: { strategyId?: string | undefined; userId: string; symbol: string; error: string },
): Promise<void> {
  if (!args.strategyId) return;
  await markSubscriptionSyncFailed(prisma, {
    userId: args.userId,
    strategyId: args.strategyId,
    error: args.error,
  });
  await notifyFollowerHardFailure(
    prisma,
    args.userId,
    args.symbol,
    args.error,
  );
}

/**
 * Execute → wait 3s → verify → retry (up to {@link MAX_RETRIES}).
 * Skips verification for reduce-only closes (caller should use {@link executeTrade}).
 */
export async function executeFollowerTradeWithVerification(
  prisma: PrismaClient,
  args: {
    strategyId?: string;
    userId: string;
    apiKey: string;
    apiSecret: string;
    symbol: string;
    side: TradeSide;
    size: number;
    reduceOnly?: boolean;
    /** Leader fill price for ledger entry (opens). */
    entryPrice?: number;
    /** Stable exchange client order id — generated once per master fill leg. */
    clientOrderId?: string;
    /** REST force-sync: skip subscription syncStatus gate on the open path. */
    forceRestSync?: boolean;
  },
): Promise<FollowerExecuteResult> {
  const { userId, apiKey, apiSecret, symbol, side } = args;
  const targetContracts = Math.max(1, Math.floor(args.size));

  if (args.strategyId) {
    const strat = await prisma.strategy.findUnique({
      where: { id: args.strategyId },
      select: STRATEGY_SELECT_IS_ACTIVE,
    });
    if (!strat?.isActive) {
      return {
        success: false,
        error: "Strategy is paused",
        attempts: 0,
        verified: false,
      };
    }

    const sub = await findActiveCopySubscriptionForUser(prisma, {
      strategyId: args.strategyId,
      userId: args.userId,
    });
    if (!sub) {
      await markSubscriptionSyncError(prisma, {
        userId: args.userId,
        strategyId: args.strategyId,
        label: "Subscription Inactive",
      });
      return {
        success: false,
        error: "No active subscription for this strategy",
        attempts: 0,
        verified: false,
      };
    }
  }

  if (args.reduceOnly === true) {
    const closeClientOrderId =
      args.clientOrderId ??
      (args.strategyId
        ? buildStableCopyClientOrderId({
            strategyId: args.strategyId,
            userId: args.userId,
            masterFillKey: `${symbol}:${side}:close`,
            symbol,
            side,
            leg: "close",
          })
        : undefined);
    const single = await placeFollowerOrder(
      apiKey,
      apiSecret,
      symbol,
      side,
      targetContracts,
      {
        reduceOnly: true,
        ...(closeClientOrderId ? { clientOrderId: closeClientOrderId } : {}),
      },
    );
    if (!single.success) {
      await markFollowerOrderFailure(prisma, {
        strategyId: args.strategyId,
        userId,
        symbol,
        error: single.error ?? "Reduce-only close failed",
      });
    } else if (args.strategyId) {
      const openSide: TradeSide = side === "BUY" ? "SELL" : "BUY";
      await closeTradePositionsForLeg(prisma, {
        strategyId: args.strategyId,
        userId: args.userId,
        symbol,
        side: openSide,
        ...(closeClientOrderId ? { clientOrderId: closeClientOrderId } : {}),
      });
    }
    return { ...single, attempts: 1, verified: single.success };
  }

  const minFilled = targetContracts * 0.9;
  let totalFee = 0;
  let lastResult: ExecuteTradeResult = {
    success: false,
    error: "no execution attempt",
  };
  let attempts = 0;

  const openClientOrderId =
    args.clientOrderId ??
    (args.strategyId
      ? buildStableCopyClientOrderId({
          strategyId: args.strategyId,
          userId: args.userId,
          masterFillKey: `${symbol}:${side}:open`,
          symbol,
          side,
          leg: "open",
        })
      : undefined);

  for (let retry = 0; retry < MAX_RETRIES; retry += 1) {
    const existingBefore = await followerLegContracts(
      apiKey,
      apiSecret,
      symbol,
      side,
    );
    if (existingBefore >= minFilled) {
      console.log(
        `[RETRY_LOOP] Already filled (${existingBefore}/${targetContracts} contracts) before attempt ${retry + 1}.`,
      );
      if (args.strategyId && args.entryPrice != null && Number.isFinite(args.entryPrice)) {
        await recordTradePositionOpen(prisma, {
          strategyId: args.strategyId,
          userId: args.userId,
          symbol,
          side,
          quantity: targetContracts,
          entryPrice: args.entryPrice,
          ...(openClientOrderId ? { clientOrderId: openClientOrderId } : {}),
          ...(lastResult.orderId ? { exchangeOrderId: lastResult.orderId } : {}),
        });
      }
      return {
        success: true,
        ...(lastResult.orderId != null ? { orderId: lastResult.orderId } : {}),
        ...(openClientOrderId ? { clientOrderId: openClientOrderId } : {}),
        feeCost: totalFee,
        ...(lastResult.raw !== undefined ? { raw: lastResult.raw } : {}),
        attempts: Math.max(attempts, 1),
        verified: true,
      };
    }

    const orderSize = Math.max(
      1,
      targetContracts - Math.floor(existingBefore),
    );

    attempts += 1;
    console.log(
      `[RETRY_LOOP] Execute attempt ${retry + 1}/${MAX_RETRIES} user ${userId} ${symbol} — orderSize=${orderSize} (existing=${existingBefore}, target=${targetContracts}) clientOrderId=${openClientOrderId ?? "none"}`,
    );

    lastResult = await placeFollowerOrder(
      apiKey,
      apiSecret,
      symbol,
      side,
      orderSize,
      openClientOrderId ? { clientOrderId: openClientOrderId } : undefined,
    );

    if (!lastResult.success) {
      const err = lastResult.error ?? "unknown";
      console.warn(
        `[RETRY_LOOP] executeTrade failed attempt ${retry + 1}/${MAX_RETRIES}: ${err}`,
      );
      if (isHardExecutionError(err)) {
        await markFollowerOrderFailure(prisma, {
          strategyId: args.strategyId,
          userId,
          symbol,
          error: err,
        });
        return {
          ...lastResult,
          feeCost: totalFee,
          attempts,
          verified: false,
        };
      }
      continue;
    }

    if (lastResult.feeCost != null && Number.isFinite(lastResult.feeCost)) {
      totalFee += lastResult.feeCost;
    }

    console.log(
      `[RETRY_LOOP] Order accepted; waiting ${POST_ORDER_VERIFY_WAIT_MS}ms before verify (user ${userId}, ${symbol})`,
    );
    await sleep(POST_ORDER_VERIFY_WAIT_MS);

    const existingAfter = await followerLegContracts(
      apiKey,
      apiSecret,
      symbol,
      side,
    );
    if (existingAfter >= minFilled) {
      console.log(
        `[RETRY_LOOP] Verified after wait (${existingAfter}/${targetContracts} contracts) on attempt ${retry + 1}.`,
      );
      if (args.strategyId && args.entryPrice != null && Number.isFinite(args.entryPrice)) {
        await recordTradePositionOpen(prisma, {
          strategyId: args.strategyId,
          userId: args.userId,
          symbol,
          side,
          quantity: targetContracts,
          entryPrice: args.entryPrice,
          ...(openClientOrderId ? { clientOrderId: openClientOrderId } : {}),
          ...(lastResult.orderId ? { exchangeOrderId: lastResult.orderId } : {}),
        });
      }
      return {
        success: true,
        ...(lastResult.orderId != null ? { orderId: lastResult.orderId } : {}),
        ...(openClientOrderId ? { clientOrderId: openClientOrderId } : {}),
        feeCost: totalFee,
        ...(lastResult.raw !== undefined ? { raw: lastResult.raw } : {}),
        attempts,
        verified: true,
      };
    }

    console.log(
      `[RETRY_LOOP] Position not visible yet (${existingAfter}/${targetContracts} contracts) after ${POST_ORDER_VERIFY_WAIT_MS}ms — will retry if attempts remain.`,
    );
  }

  const finalContracts = await followerLegContracts(
    apiKey,
    apiSecret,
    symbol,
    side,
  );
  if (finalContracts >= minFilled) {
    return {
      success: true,
      ...(lastResult.orderId != null ? { orderId: lastResult.orderId } : {}),
      ...(openClientOrderId ? { clientOrderId: openClientOrderId } : {}),
      feeCost: totalFee,
      ...(lastResult.raw !== undefined ? { raw: lastResult.raw } : {}),
      attempts,
      verified: true,
    };
  }

  const failMsg =
    lastResult.error ??
    `Position not verified after ${MAX_RETRIES} execute→wait→verify cycles (${finalContracts}/${targetContracts} contracts)`;
  console.error(
    `[RETRY_LOOP] Exhausted retries for user ${userId} on ${symbol}: ${failMsg}`,
  );
  await markFollowerOrderFailure(prisma, {
    strategyId: args.strategyId,
    userId,
    symbol,
    error: failMsg,
  });

  return {
    success: false,
    error: failMsg,
    feeCost: totalFee,
    attempts,
    verified: false,
  };
}
