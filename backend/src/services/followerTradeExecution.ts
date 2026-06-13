import type { PrismaClient } from "@prisma/client";
import { TradePositionStatus, TradeStatus } from "@prisma/client";
import {
  executeTrade,
  fetchDeltaOpenPositions,
  fetchDeltaOrderAckByClientOrderId,
  fetchDeltaSettlementExitPrice,
  fetchDeltaTicker,
  isDeltaOptionProductId,
  isValidDeltaOptionProductSymbol,
  type DeltaClientOrderAck,
  type ExecuteTradeResult,
  type TradeSide,
} from "./exchangeService.js";
import { EXIT_REASON, type ExitReasonValue } from "../constants/exitReasons.js";
import { STRATEGY_SELECT_IS_ACTIVE } from "../prisma/strategySelect.js";
import {
  findActiveCopySubscriptionForUser,
  findActiveFutureHedgeCopySubscribers,
  findCopySubscriptionForUser,
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
  incrementOrRecordFollowerTradePosition,
  recordTradePositionOpen,
  listOpenFollowerBotLegs,
  sumOpenFollowerBotQuantity,
  trimOpenFollowerBotQuantity,
  sumOpenMasterBotQuantity,
  trimOpenMasterBotQuantity,
  incrementOrRecordMasterTradePosition,
} from "./tradePositionService.js";
import { settleOpenCopyTradesForLeg } from "./tradeSettlementService.js";
import {
  buildMasterNoCopyClientOrderId,
  registerMasterNoCopyRestSuppress,
  registerPendingMasterNoCopyOrderId,
} from "./masterNoCopyOrders.js";

/** REST poll interval while waiting for Delta to confirm fill qty (5–20s window). */
const POST_ORDER_VERIFY_WAIT_MS = 5_000;
const MAX_OPEN_CONFIRM_POLLS = 4;
const COPY_LEG_CONFIRM_MS = POST_ORDER_VERIFY_WAIT_MS * MAX_OPEN_CONFIRM_POLLS;
/** Live WS master fill — fire orders immediately; short async confirm only. */
const LIVE_FILL_VERIFY_WAIT_MS = 300;
const LIVE_FILL_MAX_POLLS = 2;
const GRANULAR_SYNC_MAX_RETRIES = 5;

const copyLegExecutionChains = new Map<string, Promise<void>>();
const followerCopyInflightUntil = new Map<string, number>();

function copyLegLockKey(args: {
  userId: string;
  strategyId?: string;
  symbol: string;
  side: TradeSide | string;
}): string {
  const sym = args.symbol.replace(/[/:]/g, "").toUpperCase();
  return `${args.userId}|${args.strategyId ?? "none"}|${sym}|${String(args.side).toUpperCase()}`;
}

async function withCopyLegExecutionLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = copyLegExecutionChains.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  copyLegExecutionChains.set(
    key,
    prev.then(() => gate),
  );
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (copyLegExecutionChains.get(key) === gate) {
      copyLegExecutionChains.delete(key);
    }
  }
}

export function markFollowerCopyInflight(
  args: {
    userId: string;
    strategyId: string;
    symbol: string;
    side: TradeSide | string;
  },
  untilMs = Date.now() + COPY_LEG_CONFIRM_MS,
): void {
  followerCopyInflightUntil.set(copyLegLockKey(args), untilMs);
}

export function isFollowerCopyInflight(args: {
  userId: string;
  strategyId: string;
  symbol: string;
  side: TradeSide | string;
}): boolean {
  return (followerCopyInflightUntil.get(copyLegLockKey(args)) ?? 0) > Date.now();
}

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

/** Delta / pre-flight: reduce-only close when follower has no open leg — not a hard failure. */
export function isAlreadyFlatReduceOnlyError(message: string): boolean {
  const u = message.toUpperCase();
  if (u.includes("NO_POSITION_FOR_REDUCE_ONLY")) return true;
  if (u.includes("PRE-FLIGHT") && u.includes("EXCHANGE FLAT")) return true;
  if (u.includes("REDUCE_ONLY") && u.includes("NO_POSITION")) return true;
  if (u.includes("REDUCE ONLY") && u.includes("NO POSITION")) return true;
  if (u.includes("NO OPEN POSITION")) return true;
  if (u.includes("POSITION_NOT_FOUND")) return true;
  if (u.includes("INSUFFICIENT") && u.includes("POSITION")) return true;
  return false;
}

/** Open-side contract lots from a fresh exchange snapshot (bypasses margined TTL cache). */
export async function followerExchangeOpenLotsLive(
  apiKeyStored: string,
  apiSecretStored: string,
  symbol: string,
  openSide: TradeSide,
): Promise<number> {
  return followerLegContracts(apiKeyStored, apiSecretStored, symbol, openSide, {
    skipCache: true,
  });
}

/**
 * Before a reduce-only close: confirm the follower still holds `openSide` on exchange.
 * Returns lots to close (0 = skip order, clear DB ghost only).
 */
async function resolveFollowerReduceOnlyCloseLots(args: {
  apiKey: string;
  apiSecret: string;
  symbol: string;
  /** Original open leg side (BUY long / SELL short) — not the reduce-only order side. */
  openSide: TradeSide;
  requestedLots: number;
}): Promise<{ lots: number; exchangeOpenLots: number }> {
  const exchangeOpenLots = await followerExchangeOpenLotsLive(
    args.apiKey,
    args.apiSecret,
    args.symbol,
    args.openSide,
  );
  const exchangeFloor = Math.floor(exchangeOpenLots);
  if (exchangeFloor <= 0) {
    return { lots: 0, exchangeOpenLots };
  }
  const requested = Math.max(1, Math.floor(args.requestedLots));
  return {
    lots: Math.min(requested, exchangeFloor),
    exchangeOpenLots,
  };
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
  const a = tradeSymbol.trim();
  const b = positionKey.trim();
  if (
    isValidDeltaOptionProductSymbol(a) ||
    isValidDeltaOptionProductSymbol(b) ||
    isDeltaOptionProductId(a) ||
    isDeltaOptionProductId(b)
  ) {
    return a.toUpperCase() === b.toUpperCase();
  }

  const ca = compactSymbolKey(a);
  const cb = compactSymbolKey(b);
  if (ca === cb || ca.endsWith(cb) || cb.endsWith(ca)) return true;
  const ba = deltaPairBase(ca);
  const bb = deltaPairBase(cb);
  return ba != null && bb != null && ba === bb;
}

/** Open leg size in exchange **contract lots** (must match {@link executeTrade} amount). */
export async function followerExchangeLegContracts(
  apiKeyStored: string,
  apiSecretStored: string,
  symbol: string,
  side: TradeSide,
): Promise<number> {
  return followerLegContracts(apiKeyStored, apiSecretStored, symbol, side);
}

async function followerLegContracts(
  apiKeyStored: string,
  apiSecretStored: string,
  symbol: string,
  side: TradeSide,
  options?: { skipCache?: boolean },
): Promise<number> {
  const positions = await fetchDeltaOpenPositions(apiKeyStored, apiSecretStored, {
    lite: true,
    ...(options?.skipCache === true ? { skipCache: true } : {}),
  });
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
  /** Exchange-confirmed filled lots recorded to DB (may be < requested target). */
  verifiedQty?: number;
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

function orderAckPending(ack: DeltaClientOrderAck): boolean {
  if (!ack.found) return false;
  return ack.state === "open" || ack.state === "pending";
}

function orderAckFilledQty(ack: DeltaClientOrderAck): number {
  if (!ack.found) return 0;
  if (ack.filledSize > 0) return ack.filledSize;
  if (ack.state === "filled" && ack.unfilledSize <= 0) {
    return ack.filledSize;
  }
  return 0;
}

/** Minimum exchange lots to treat an open as verified (perps: exact; options: allow REST lag). */
function minVerifiedLots(targetContracts: number, isOptionLeg: boolean): number {
  if (isOptionLeg) {
    return Math.max(1, Math.ceil(targetContracts * 0.9));
  }
  return targetContracts;
}

/** Lots to persist — never above what exchange confirms, never above requested target. */
function resolvedDbOpenQty(
  targetContracts: number,
  exchangeLots: number,
  ackFilled?: number,
): number {
  const candidates = [exchangeLots, ackFilled ?? 0].filter(
    (n) => Number.isFinite(n) && n > 0,
  );
  const confirmed =
    candidates.length > 0 ? Math.max(...candidates) : 0;
  if (confirmed <= 0) return 0;
  return Math.min(targetContracts, Math.floor(confirmed));
}

async function recordVerifiedFollowerOpen(
  prisma: PrismaClient,
  args: {
    strategyId?: string;
    userId: string;
    symbol: string;
    side: TradeSide;
    quantity: number;
    entryPrice?: number;
    clientOrderId?: string;
    exchangeOrderId?: string | null;
  },
): Promise<boolean> {
  if (
    !args.strategyId ||
    args.entryPrice == null ||
    !Number.isFinite(args.entryPrice)
  ) {
    return false;
  }
  const row = await recordTradePositionOpen(prisma, {
    strategyId: args.strategyId,
    userId: args.userId,
    symbol: args.symbol,
    side: args.side,
    quantity: args.quantity,
    entryPrice: args.entryPrice,
    ...(args.clientOrderId ? { clientOrderId: args.clientOrderId } : {}),
    ...(args.exchangeOrderId != null
      ? { exchangeOrderId: args.exchangeOrderId }
      : {}),
  });
  return row != null;
}

function buildOpenExecuteSuccess(
  args: {
    lastResult: ExecuteTradeResult;
    openClientOrderId?: string;
    feeCost: number;
    attempts: number;
    verifiedQty?: number;
  },
): FollowerExecuteResult {
  return {
    success: true,
    ...(args.lastResult.orderId != null ? { orderId: args.lastResult.orderId } : {}),
    ...(args.openClientOrderId ? { clientOrderId: args.openClientOrderId } : {}),
    feeCost: args.feeCost,
    ...(args.lastResult.raw !== undefined ? { raw: args.lastResult.raw } : {}),
    attempts: Math.max(args.attempts, 1),
    verified: true,
    ...(args.verifiedQty != null ? { verifiedQty: args.verifiedQty } : {}),
  };
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
  const leg = await prisma.tradePosition.findUnique({
    where: { clientOrderId },
    select: { status: true },
  });
  if (leg?.status === TradePositionStatus.OPEN) {
    return true;
  }

  // Stale Trade rows without a bot-managed leg must not block retries.
  return false;
}

/**
 * How many follower contract lots are still missing vs target (0 = synced).
 * Uses max(bot DB qty, exchange REST qty) so lagging DB rows cannot trigger refires.
 */
export async function followerBotOpenDeficitLots(
  prisma: PrismaClient,
  args: {
    strategyId: string;
    userId: string;
    symbol: string;
    side: TradeSide | string;
    targetLots: number;
    apiKey?: string;
    apiSecret?: string;
  },
): Promise<number> {
  const target = Math.max(0, Math.floor(args.targetLots));
  if (target <= 0) return 0;

  if (
    isFollowerCopyInflight({
      userId: args.userId,
      strategyId: args.strategyId,
      symbol: args.symbol,
      side: args.side,
    })
  ) {
    return 0;
  }

  const botQty = await sumOpenFollowerBotQuantity(prisma, {
    strategyId: args.strategyId,
    userId: args.userId,
    symbol: args.symbol,
    side: args.side,
  });

  let exchangeLots = 0;
  if (args.apiKey?.trim() && args.apiSecret?.trim()) {
    try {
      exchangeLots = Math.floor(
        await followerLegContracts(
          args.apiKey,
          args.apiSecret,
          String(args.symbol),
          args.side as TradeSide,
          { skipCache: true },
        ),
      );
    } catch (err) {
      console.warn(
        `[copy-deficit] REST position read failed user=${args.userId} ${args.symbol}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  const effective = Math.max(botQty, exchangeLots);
  if (effective >= target) {
    if (exchangeLots > target) {
      console.warn(
        `[copy-deficit] overfill user=${args.userId} ${args.symbol} ${args.side} ` +
          `exchange=${exchangeLots} db=${botQty} target=${target} — blocking new orders`,
      );
    }
    return 0;
  }

  return Math.max(1, target - Math.floor(effective));
}

/** REST poll may only open a master leg for followers if it opened within this window. */
export const MASTER_REST_CATCHUP_MAX_AGE_MS = 15 * 60 * 1000;

export function parseMasterLegOpenedAt(
  iso: string | null | undefined,
): Date | null {
  if (!iso?.trim()) return null;
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * REST catch-up window — uses exchange open time when present, otherwise locally
 * first-seen for legs discovered this session.
 */
export function isMasterLegFreshForRestCatchup(
  exchangeOpenedAt: Date | null,
  locallyFirstSeenAt: Date | null = null,
  isNewLegThisSession = false,
  refMs = Date.now(),
): boolean {
  if (isNewLegThisSession && !exchangeOpenedAt) return true;
  const effective = exchangeOpenedAt ?? locallyFirstSeenAt;
  if (!effective) return false;
  return refMs - effective.getTime() <= MASTER_REST_CATCHUP_MAX_AGE_MS;
}

/** Pre-existing at REST baseline with no open timestamp — never REST catch-up. */
export function masterLegRestPreExistingUnknown(args: {
  isNewLegThisSession: boolean;
  exchangeOpenedAt: Date | null;
  locallyFirstSeenAt: Date | null;
}): boolean {
  return (
    !args.isNewLegThisSession &&
    !args.exchangeOpenedAt &&
    !args.locallyFirstSeenAt
  );
}

/**
 * Follower may copy a master leg when they subscribed on or before the leg opened.
 * Live WS fills bypass late-join checks. Missing timestamps default to COPY (fault-tolerant).
 */
export function followerEligibleForMasterLegCopy(args: {
  joinedDate: Date;
  masterOpenedAt?: Date | null;
  locallyFirstSeenAt?: Date | null;
  adminForceSync?: boolean;
  liveMasterFill?: boolean;
  restPreExistingUnknown?: boolean;
}): boolean {
  if (args.adminForceSync || args.liveMasterFill) return true;
  if (args.restPreExistingUnknown) return false;

  const legOpened = args.masterOpenedAt ?? args.locallyFirstSeenAt ?? null;
  if (!legOpened) return true;
  return args.joinedDate.getTime() <= legOpened.getTime();
}

export type MasterOpenFillArgs = {
  symbol: string;
  side: TradeSide;
  masterLots: number;
  avgPrice: number;
  /** Master order id or fill fingerprint — one follower leg per key. */
  masterFillKey: string;
  /** REST force-sync: bypass slippage and stable dedup gates. */
  forceRestSync?: boolean;
  /** Admin Force Sync — bypass late-join and syncStatus blocks. */
  adminForceSync?: boolean;
  /** When the master leg opened (Delta margined `created_at` / entryTime). */
  masterOpenedAt?: Date | null;
  /** Bot session first-seen when exchange omits open time. */
  locallyFirstSeenAt?: Date | null;
  /** Live WS master fill — bypass late-join timestamp checks. */
  liveMasterFill?: boolean;
  /** REST pre-existing leg at baseline with unknown open time. */
  restPreExistingUnknown?: boolean;
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

  void recordTradePositionOpen(prisma, {
    isMaster: true,
    strategyId,
    symbol: fill.symbol,
    side: fill.side,
    quantity: fill.masterLots,
    entryPrice: fill.avgPrice,
  }).catch((err) => {
    console.warn(
      `[copy] master TradePosition ledger skipped ${fill.symbol}:`,
      err instanceof Error ? err.message : err,
    );
  });

  let entryForCopy = fill.avgPrice;
  if (fill.liveMasterFill !== true) {
    const tick = await fetchDeltaTicker(fill.symbol);
    const marketPrice =
      tick.last != null && Number.isFinite(tick.last) ? tick.last : undefined;
    if (
      marketPrice !== undefined &&
      slippageBlocksCopy(
        fill.symbol,
        fill.avgPrice,
        marketPrice,
        strategy.slippage,
      )
    ) {
      console.warn(
        `[copy] Slippage vs master entry for ${fill.symbol}; using market ${marketPrice} for follower entry`,
      );
      entryForCopy = marketPrice;
    }
  }

  type FanoutJob = {
    sub: (typeof subscribers)[number];
    lots: number;
    clientOrderId: string;
    creds: { apiKey: string; apiSecret: string };
  };

  const jobs: FanoutJob[] = [];
  await Promise.all(
    subscribers.map(async (sub) => {
      if (
        !followerEligibleForMasterLegCopy({
          joinedDate: sub.joinedDate,
          masterOpenedAt: fill.masterOpenedAt ?? null,
          locallyFirstSeenAt: fill.locallyFirstSeenAt ?? null,
          liveMasterFill: fill.liveMasterFill === true,
          adminForceSync: fill.adminForceSync === true,
          restPreExistingUnknown: fill.restPreExistingUnknown === true,
        })
      ) {
        console.log(
          `[copy] skip late-join user=${sub.userId} ${fill.symbol} — ` +
            `subscribed after master leg opened`,
        );
        return;
      }

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
          entryPrice: entryForCopy,
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

      jobs.push({ sub, lots, clientOrderId, creds });
    }),
  );

  if (jobs.length === 0) {
    return { strategyId, fanoutCount: 0 };
  }

  console.log(
    `[copy] parallel fan-out ${jobs.length} follower order(s) ${fill.symbol} ${fill.side} ` +
      `(liveMasterFill=${fill.liveMasterFill === true})`,
  );

  const settled = await Promise.allSettled(
    jobs.map(async (job) => {
      console.log(
        `[copy] Future Hedge open user=${job.sub.userId} ${fill.symbol} ${fill.side} ` +
          `lots=${job.lots} (master ${fill.masterLots} × ${job.sub.multiplier}) ` +
          `clientOrderId=${job.clientOrderId}`,
      );

      await markSubscriptionSyncPending(prisma, {
        userId: job.sub.userId,
        strategyId,
      });

      const result = await executeFollowerTradeWithVerification(prisma, {
        strategyId,
        userId: job.sub.userId,
        apiKey: job.creds.apiKey,
        apiSecret: job.creds.apiSecret,
        symbol: fill.symbol,
        side: fill.side,
        size: job.lots,
        entryPrice: entryForCopy,
        clientOrderId: job.clientOrderId,
        liveMasterFill: fill.liveMasterFill === true,
      });

      if (result.success && result.verified) {
        await markSubscriptionSynced(prisma, {
          userId: job.sub.userId,
          strategyId,
        });
        const recordedLots = result.verifiedQty ?? job.lots;
        await recordTradePositionOpen(prisma, {
          strategyId,
          userId: job.sub.userId,
          symbol: fill.symbol,
          side: fill.side,
          quantity: recordedLots,
          entryPrice: entryForCopy,
          clientOrderId: job.clientOrderId,
          ...(result.orderId ? { exchangeOrderId: result.orderId } : {}),
        });
      } else {
        await markSubscriptionSyncFailed(prisma, {
          userId: job.sub.userId,
          strategyId,
          error: result.error ?? "Copy trade execution failed",
        });
      }

      await persistCopyTradeRow(prisma, {
        userId: job.sub.userId,
        strategyId,
        symbol: fill.symbol,
        side: fill.side,
        size:
          result.success && result.verified
            ? (result.verifiedQty ?? job.lots)
            : job.lots,
        entryPrice: entryForCopy,
        status:
          result.success && result.verified
            ? TradeStatus.OPEN
            : TradeStatus.FAILED,
        tradingFee: result.success ? (result.feeCost ?? 0) : 0,
        clientOrderId: job.clientOrderId,
        ...(!result.success || !result.verified
          ? {
              exitReason: isHardExecutionError(result.error ?? "")
                ? EXIT_REASON.INSUFFICIENT_MARGIN
                : EXIT_REASON.EXECUTION_FAILED,
            }
          : {}),
      });

      return result;
    }),
  );

  for (const outcome of settled) {
    if (outcome.status === "rejected") {
      console.error(
        `[copy] parallel fan-out task rejected:`,
        outcome.reason instanceof Error
          ? outcome.reason.message
          : outcome.reason,
      );
    }
  }

  return { strategyId, fanoutCount: jobs.length };
}

/**
 * REST force-sync: align followers to master runtime positions using DB bot qty
 * as source of truth. Bypasses slippage, syncStatus blocks, and stable fill dedup.
 */
export async function forceSyncMasterOpenToFollowers(
  prisma: PrismaClient,
  fill: MasterOpenFillArgs,
): Promise<{ strategyId: string; fanoutCount: number } | null> {
  try {
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
      lots: number;
    }> = [];

    for (const sub of subscribers) {
      if (
        !followerEligibleForMasterLegCopy({
          joinedDate: sub.joinedDate,
          masterOpenedAt: fill.masterOpenedAt ?? null,
          locallyFirstSeenAt: fill.locallyFirstSeenAt ?? null,
          liveMasterFill: fill.liveMasterFill === true,
          adminForceSync:
            fill.adminForceSync === true || fill.forceRestSync === true,
          restPreExistingUnknown: fill.restPreExistingUnknown === true,
        })
      ) {
        console.log(
          `[FORCE-SYNC] skip late-join user=${sub.userId} ${fill.symbol} — ` +
            `master leg predates subscription (joined=${sub.joinedDate.toISOString()})`,
        );
        continue;
      }

      const expectedLots = followerLotsFromMaster(fill.masterLots, sub);
      const credsForDeficit = resolveCopySubscriptionCreds(sub);
      const deficitLots = await followerBotOpenDeficitLots(prisma, {
        strategyId,
        userId: sub.userId,
        symbol: fill.symbol,
        side: fill.side,
        targetLots: expectedLots,
        ...(credsForDeficit
          ? {
              apiKey: credsForDeficit.apiKey,
              apiSecret: credsForDeficit.apiSecret,
            }
          : {}),
      });
      if (deficitLots > 0) {
        pending.push({ sub, lots: deficitLots });
      }
    }

    if (pending.length === 0) {
      return { strategyId, fanoutCount: 0 };
    }

    console.log(
      "[FORCE-SYNC] Forcing market open order synchronization for followers on symbol:",
      fill.symbol,
    );

    try {
      await recordTradePositionOpen(prisma, {
        isMaster: true,
        strategyId,
        symbol: fill.symbol,
        side: fill.side,
        quantity: fill.masterLots,
        entryPrice: fill.avgPrice,
        clientOrderId: buildClientOrderId({
          strategyId,
          isMaster: true,
          symbol: fill.symbol,
          exchangeOrderId: fill.masterFillKey,
        }),
      });
    } catch (masterLegErr) {
      console.warn(
        "[FORCE-SYNC] master TradePosition ledger skipped:",
        masterLegErr instanceof Error ? masterLegErr.message : masterLegErr,
      );
    }

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

    await Promise.allSettled(
      pending.map(async ({ sub, lots }) => {
        try {
          const creds = resolveCopySubscriptionCreds(sub);
          const clientOrderId = buildStableCopyClientOrderId({
            strategyId,
            userId: sub.userId,
            masterFillKey: fill.masterFillKey,
            symbol: fill.symbol,
            side: fill.side,
            leg: "open",
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

          if (await followerFillAlreadyCopied(prisma, clientOrderId)) {
            console.log(
              `[FORCE-SYNC] Skip duplicate force-sync user=${sub.userId} ${fill.symbol} clientOrderId=${clientOrderId}`,
            );
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
            adminForceSync:
              fill.adminForceSync === true || fill.forceRestSync === true,
          });

          if (result.success && result.verified) {
            await markSubscriptionSynced(prisma, {
              userId: sub.userId,
              strategyId,
            });
            const recordedLots = result.verifiedQty ?? lots;
            await recordTradePositionOpen(prisma, {
              strategyId,
              userId: sub.userId,
              symbol: fill.symbol,
              side: fill.side,
              quantity: recordedLots,
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
            size:
              result.success && result.verified
                ? (result.verifiedQty ?? lots)
                : lots,
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
        } catch (subErr) {
          console.error(
            `[FORCE-SYNC] follower open failed user=${sub.userId} ${fill.symbol}:`,
            subErr instanceof Error ? subErr.message : subErr,
          );
        }
      }),
    );

    return { strategyId, fanoutCount: pending.length };
  } catch (err) {
    console.error(
      "[FORCE-SYNC] forceSyncMasterOpenToFollowers failed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

export type GranularSyncLegInput = {
  symbol: string;
  side: TradeSide | string;
  addLots: number;
};

export type GranularSyncLegResult = {
  symbol: string;
  side: string;
  addLots: number;
  success: boolean;
  error?: string;
};

export type GranularAdminSyncResult = {
  ok: boolean;
  strategyId: string;
  userId: string;
  legsAttempted: number;
  legsSucceeded: number;
  results: GranularSyncLegResult[];
  syncStatus: string;
  syncError: string | null;
  error?: string;
};

/**
 * Admin granular sync — exact lot counts per leg (no multiplier), bypasses late-join guards.
 */
export async function adminGranularSyncFollowerLegs(
  prisma: PrismaClient,
  args: {
    strategyId: string;
    userId: string;
    legs: GranularSyncLegInput[];
  },
): Promise<GranularAdminSyncResult> {
  const strategyId = args.strategyId.trim();
  const userId = args.userId.trim();

  const strategy = await prisma.strategy.findUnique({
    where: { id: strategyId },
    select: { id: true, isActive: true },
  });
  if (!strategy) {
    throw new Error("Strategy not found.");
  }

  const sub = await findCopySubscriptionForUser(prisma, { strategyId, userId });
  if (!sub) {
    throw new Error("User is not subscribed to this strategy.");
  }

  const creds = resolveCopySubscriptionCreds(sub);
  if (!creds) {
    throw new Error("Follower has no Delta API credentials configured.");
  }

  const pending = args.legs
    .map((leg) => ({
      symbol: String(leg.symbol ?? "").trim(),
      side: String(leg.side ?? "").toUpperCase(),
      addLots: Math.floor(Number(leg.addLots)),
    }))
    .filter(
      (leg) =>
        leg.symbol.length > 0 &&
        (leg.side === "BUY" || leg.side === "SELL") &&
        leg.addLots > 0,
    );

  if (pending.length === 0) {
    return {
      ok: false,
      strategyId,
      userId,
      legsAttempted: 0,
      legsSucceeded: 0,
      results: [],
      syncStatus: sub.syncStatus,
      syncError: "No legs with addLots > 0",
      error: "No legs with addLots > 0",
    };
  }

  await markSubscriptionSyncPending(prisma, { userId, strategyId });

  const results: GranularSyncLegResult[] = [];
  let legsSucceeded = 0;
  const errors: string[] = [];

  for (const leg of pending) {
    const side = leg.side as TradeSide;
    let entryPrice = 0;
    try {
      const tick = await fetchDeltaTicker(leg.symbol);
      if (tick.last != null && Number.isFinite(tick.last) && tick.last > 0) {
        entryPrice = tick.last;
      }
    } catch {
      /* fallback below */
    }
    if (entryPrice <= 0) {
      const masterLeg = await prisma.tradePosition.findFirst({
        where: {
          strategyId,
          isMaster: true,
          status: TradePositionStatus.OPEN,
          symbol: leg.symbol,
          side: leg.side,
        },
        select: { entryPrice: true },
      });
      if (
        masterLeg?.entryPrice != null &&
        Number.isFinite(masterLeg.entryPrice) &&
        masterLeg.entryPrice > 0
      ) {
        entryPrice = masterLeg.entryPrice;
      }
    }
    if (entryPrice <= 0) {
      console.warn(
        `[granular-sync] no quote for ${leg.symbol} — placing REST order anyway (ledger price from fill)`,
      );
    }

    const clientOrderId = buildClientOrderId({
      strategyId,
      userId,
      symbol: leg.symbol,
    });

    console.log(
      `[granular-sync] user=${userId} ${leg.symbol} ${side} +${leg.addLots} lots (admin exact)`,
    );

    const exec = await executeFollowerExactIncrementalAdd(prisma, {
      strategyId,
      userId,
      apiKey: creds.apiKey,
      apiSecret: creds.apiSecret,
      symbol: leg.symbol,
      side,
      addLots: leg.addLots,
      clientOrderId,
    });

    if (exec.success && exec.verified) {
      const ledgerEntryPrice =
        exec.fillPrice != null && Number.isFinite(exec.fillPrice) && exec.fillPrice > 0
          ? exec.fillPrice
          : entryPrice > 0
            ? entryPrice
            : 0;
      if (ledgerEntryPrice <= 0) {
        console.warn(
          `[granular-sync] ${leg.symbol} filled but no entry price — using 0 for ledger`,
        );
      }
      await incrementOrRecordFollowerTradePosition(prisma, {
        strategyId,
        userId,
        symbol: leg.symbol,
        side,
        addLots: leg.addLots,
        entryPrice: ledgerEntryPrice,
        clientOrderId,
        ...(exec.orderId ? { exchangeOrderId: exec.orderId } : {}),
      });
      await persistCopyTradeRow(prisma, {
        userId,
        strategyId,
        symbol: leg.symbol,
        side,
        size: leg.addLots,
        entryPrice: ledgerEntryPrice,
        status: TradeStatus.OPEN,
        tradingFee: exec.feeCost ?? 0,
        clientOrderId,
      });
      results.push({
        symbol: leg.symbol,
        side: leg.side,
        addLots: leg.addLots,
        success: true,
      });
      legsSucceeded += 1;
      continue;
    }

    const errMsg = exec.error ?? "Execution failed";
    results.push({
      symbol: leg.symbol,
      side: leg.side,
      addLots: leg.addLots,
      success: false,
      error: errMsg,
    });
    errors.push(`${leg.symbol} ${leg.side}: ${errMsg}`);
    if (isHardExecutionError(errMsg)) {
      break;
    }
  }

  if (errors.length === 0) {
    await markSubscriptionSynced(prisma, { userId, strategyId });
    return {
      ok: true,
      strategyId,
      userId,
      legsAttempted: pending.length,
      legsSucceeded,
      results,
      syncStatus: "SYNCED",
      syncError: null,
    };
  }

  const syncError = errors.join("; ");
  await markSubscriptionSyncFailed(prisma, {
    userId,
    strategyId,
    error: syncError,
  });

  return {
    ok: false,
    strategyId,
    userId,
    legsAttempted: pending.length,
    legsSucceeded,
    results,
    syncStatus: "FAILED",
    syncError,
    error: syncError,
  };
}

export type MasterCloseFanoutResult = {
  strategyId: string;
  fanoutCount: number;
  closedCount: number;
  remainingExchangeLots: number;
};

/**
 * Exchange leg is already flat — book CLOSED + PnL for any lingering OPEN Trade rows.
 */
async function bookFollowerLegSettlementWhenFlat(
  prisma: PrismaClient,
  args: {
    userId: string;
    strategyId: string;
    symbol: string;
    side: TradeSide;
    masterEntryPrice: number;
    exitReason?: ExitReasonValue;
  },
): Promise<void> {
  let exitPrice = 0;
  const fromMarket = await fetchDeltaSettlementExitPrice(
    args.symbol,
    args.side,
  );
  if (fromMarket != null && Number.isFinite(fromMarket) && fromMarket > 0) {
    exitPrice = fromMarket;
  } else {
    try {
      const tick = await fetchDeltaTicker(args.symbol);
      if (tick.last != null && Number.isFinite(tick.last)) {
        exitPrice = tick.last;
      }
    } catch {
      /* optional */
    }
  }
  if (exitPrice <= 0 && args.masterEntryPrice > 0) {
    exitPrice = args.masterEntryPrice;
  }

  await settleOpenCopyTradesForLeg(prisma, {
    userId: args.userId,
    strategyId: args.strategyId,
    symbol: args.symbol,
    side: args.side,
    exitPrice,
    exitFee: 0,
    exitReason: args.exitReason,
    masterEntryPrice: args.masterEntryPrice,
    closeAllMatching: true,
  });
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
): Promise<MasterCloseFanoutResult | null> {
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
  let closedCount = 0;

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

      const dbLotsFloor = Math.floor(dbLots);

      const { lots, exchangeOpenLots } = await resolveFollowerReduceOnlyCloseLots({
        apiKey: creds.apiKey,
        apiSecret: creds.apiSecret,
        symbol: snap.symbol,
        openSide: snap.side,
        requestedLots: Math.max(1, Math.floor(dbLots), 1),
      });

      if (lots <= 0) {
        if (dbLotsFloor > 0) {
          await closeTradePositionsForLeg(prisma, {
            strategyId,
            userId: sub.userId,
            symbol: snap.symbol,
            side: snap.side,
          });
          console.log(
            `[copy] Cleared DB ghost leg user=${sub.userId} ${snap.symbol} ${snap.side} ` +
              `(exchange flat; liveLots=${exchangeOpenLots})`,
          );
        } else {
          console.log(
            `[copy] Skip close user=${sub.userId} ${snap.symbol} ${snap.side} — ` +
              `flat on exchange (liveLots=${exchangeOpenLots}) and no DB qty`,
          );
        }
        await bookFollowerLegSettlementWhenFlat(prisma, {
          userId: sub.userId,
          strategyId,
          symbol: snap.symbol,
          side: snap.side,
          masterEntryPrice: snap.masterEntryPrice,
          ...(options?.exitReason ? { exitReason: options.exitReason } : {}),
        });
        return;
      }

      const closeClientOrderId = buildStableCopyClientOrderId({
        strategyId,
        userId: sub.userId,
        masterFillKey: `close:${snap.symbol}:${snap.side}`,
        symbol: snap.symbol,
        side: oppositeSide,
        leg: "close",
      });

      console.log(
        `[copy] Future Hedge close user=${sub.userId} ${snap.symbol} ${oppositeSide} lots=${lots} ` +
          `(exchangeLive=${exchangeOpenLots} db=${dbLotsFloor})`,
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

      await closeTradePositionsForLeg(prisma, {
        strategyId,
        userId: sub.userId,
        symbol: snap.symbol,
        side: snap.side,
        ...(closeClientOrderId ? { clientOrderId: closeClientOrderId } : {}),
      });

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
      closedCount += 1;
    }),
  );

  let remainingExchangeLots = 0;
  for (const sub of subscribers) {
    const creds = resolveCopySubscriptionCreds(sub);
    if (!creds) continue;
    const openLots = await followerExchangeOpenLotsLive(
      creds.apiKey,
      creds.apiSecret,
      snap.symbol,
      snap.side,
    );
    remainingExchangeLots += Math.floor(openLots);
  }

  return {
    strategyId,
    fanoutCount: subscribers.length,
    closedCount,
    remainingExchangeLots,
  };
}

/**
 * Master REST book is empty but followers still hold legs — close orphans (DB + exchange).
 */
export async function reconcileFollowersToEmptyMasterBook(
  prisma: PrismaClient,
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
): Promise<number> {
  const strategyId = await resolveFutureHedgeStrategyId(prisma);
  if (!strategyId) return 0;
  if (!(await assertStrategyActiveForCopy(prisma, strategyId))) return 0;

  const subscribers = await findActiveFutureHedgeCopySubscribers(prisma);
  const legKeys = new Map<string, MasterCloseFillArgs>();

  for (const sub of subscribers) {
    const botLegs = await listOpenFollowerBotLegs(prisma, strategyId, sub.userId);
    for (const leg of botLegs) {
      const side = leg.side.toUpperCase() === "SELL" ? "SELL" : "BUY";
      const k = `${leg.symbol}:${side}`;
      if (!legKeys.has(k)) {
        legKeys.set(k, {
          symbol: leg.symbol,
          side,
          masterLots: 0,
          masterEntryPrice: 0,
        });
      }
    }

    const creds = resolveCopySubscriptionCreds(sub);
    if (!creds) continue;
    try {
      const open = await fetchDeltaOpenPositions(creds.apiKey, creds.apiSecret, {
        lite: true,
        skipCache: true,
      });
      for (const p of open) {
        if (Math.abs(p.contracts) < 1e-12) continue;
        const k = `${p.symbolKey}:${p.side}`;
        if (!legKeys.has(k)) {
          legKeys.set(k, {
            symbol: p.symbolKey,
            side: p.side,
            masterLots: Math.abs(p.contracts),
            masterEntryPrice:
              p.entryPrice != null && Number.isFinite(p.entryPrice)
                ? p.entryPrice
                : 0,
          });
        }
      }
    } catch (err) {
      console.warn(
        `[copy] orphan reconcile fetch failed user=${sub.userId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (legKeys.size === 0) return 0;

  console.log(
    `[MASTER-REST-SYNC] master book empty — reconciling ${legKeys.size} orphan follower leg(s)`,
  );

  let reconciled = 0;
  for (const snap of legKeys.values()) {
    const result = await syncMasterCloseToFutureHedgeFollowers(
      prisma,
      snap,
      onFollowerClosed,
      options,
    );
    if (result && result.remainingExchangeLots === 0) {
      reconciled += 1;
    }
  }
  return reconciled;
}

async function placeFollowerOrder(
  apiKey: string,
  apiSecret: string,
  symbol: string,
  side: TradeSide,
  size: number,
  opts?: { reduceOnly?: boolean; clientOrderId?: string },
): Promise<ExecuteTradeResult> {
  console.log(
    `[copy] placeFollowerOrder symbol="${symbol.trim()}" side=${side} lots=${size} ` +
      `reduceOnly=${opts?.reduceOnly === true} clientOrderId=${opts?.clientOrderId ?? "none"}`,
  );
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
 * Admin granular sync — place exactly `addLots` as a delta (one market order max).
 * Does not use absolute-position target logic; never re-orders when verify is slow.
 */
export async function executeFollowerExactIncrementalAdd(
  prisma: PrismaClient,
  args: {
    strategyId: string;
    userId: string;
    apiKey: string;
    apiSecret: string;
    symbol: string;
    side: TradeSide;
    addLots: number;
    clientOrderId?: string;
  },
): Promise<FollowerExecuteResult> {
  const addLots = Math.floor(Number(args.addLots));
  if (!Number.isFinite(addLots) || addLots <= 0) {
    return {
      success: false,
      error: "addLots must be a positive integer",
      attempts: 0,
      verified: false,
    };
  }

  const { userId, apiKey, apiSecret, symbol, side, strategyId } = args;

  const sub = await findCopySubscriptionForUser(prisma, { strategyId, userId });
  if (!sub) {
    return {
      success: false,
      error: "User is not subscribed to this strategy",
      attempts: 0,
      verified: false,
    };
  }
  if (!sub.isActive) {
    return {
      success: false,
      error: "User copy subscription is inactive (isActive is false).",
      attempts: 0,
      verified: false,
    };
  }

  const baseline = await followerLegContracts(apiKey, apiSecret, symbol, side);
  const minDelta = addLots * 0.9;
  let totalFee = 0;
  let lastResult: ExecuteTradeResult = {
    success: false,
    error: "no order placed",
  };
  let attempts = 0;
  let orderAccepted = false;

  console.log(
    `[granular-sync] exact incremental addLots=${addLots} baseline=${baseline} user=${userId} ${symbol} ${side}`,
  );

  for (let pass = 0; pass <= GRANULAR_SYNC_MAX_RETRIES; pass += 1) {
    const current = await followerLegContracts(apiKey, apiSecret, symbol, side);
    const delta = current - baseline;
    if (delta >= minDelta) {
      return {
        success: true,
        verified: true,
        attempts: Math.max(attempts, 1),
        feeCost: totalFee,
        ...(lastResult.orderId != null ? { orderId: lastResult.orderId } : {}),
        ...(lastResult.fillPrice != null ? { fillPrice: lastResult.fillPrice } : {}),
        ...(args.clientOrderId ? { clientOrderId: args.clientOrderId } : {}),
        ...(lastResult.raw !== undefined ? { raw: lastResult.raw } : {}),
      };
    }

    if (orderAccepted) {
      if (pass < GRANULAR_SYNC_MAX_RETRIES) {
        await sleep(POST_ORDER_VERIFY_WAIT_MS);
      }
      continue;
    }

    attempts += 1;
    lastResult = await placeFollowerOrder(
      apiKey,
      apiSecret,
      symbol,
      side,
      addLots,
      args.clientOrderId ? { clientOrderId: args.clientOrderId } : undefined,
    );

    if (!lastResult.success) {
      const err = lastResult.error ?? "unknown";
      console.warn(
        `[granular-sync] order failed attempt ${attempts}: ${err}`,
      );
      if (isHardExecutionError(err)) {
        await markFollowerOrderFailure(prisma, {
          strategyId,
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
      if (pass < GRANULAR_SYNC_MAX_RETRIES) {
        await sleep(POST_ORDER_VERIFY_WAIT_MS);
      }
      continue;
    }

    orderAccepted = true;
    if (lastResult.feeCost != null && Number.isFinite(lastResult.feeCost)) {
      totalFee += lastResult.feeCost;
    }
    await sleep(POST_ORDER_VERIFY_WAIT_MS);
  }

  const finalDelta =
    (await followerLegContracts(apiKey, apiSecret, symbol, side)) - baseline;

  if (orderAccepted) {
    if (finalDelta < minDelta) {
      console.warn(
        `[granular-sync] order accepted but REST delta=${finalDelta} expected +${addLots} — not re-ordering`,
      );
    }
    return {
      success: true,
      verified: true,
      attempts: Math.max(attempts, 1),
      feeCost: totalFee,
      ...(lastResult.orderId != null ? { orderId: lastResult.orderId } : {}),
      ...(lastResult.fillPrice != null ? { fillPrice: lastResult.fillPrice } : {}),
      ...(args.clientOrderId ? { clientOrderId: args.clientOrderId } : {}),
      ...(lastResult.raw !== undefined ? { raw: lastResult.raw } : {}),
    };
  }

  const failMsg = lastResult.error ?? "Incremental add order failed";
  return {
    success: false,
    error: failMsg,
    feeCost: totalFee,
    attempts,
    verified: false,
  };
}

/**
 * Execute → single fire → REST confirm poll (5s × 4 = 20s max).
 * Opens replicate the master leg direction verbatim (`side` = master BUY/SELL).
 * Reduce-only closes use the opposite exchange side to flatten an existing leg.
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
    /** Live master fill fan-out — never block on prior FAILED syncStatus. */
    liveMasterFill?: boolean;
    /** Admin Force Sync — allow opens despite FAILED syncStatus / late-join rules. */
    adminForceSync?: boolean;
  },
): Promise<FollowerExecuteResult> {
  const { userId, apiKey, apiSecret, symbol, side } = args;
  const targetContracts = Math.max(1, Math.floor(args.size));
  const skipSyncStatusGate =
    args.adminForceSync === true ||
    args.forceRestSync === true ||
    args.liveMasterFill === true;
  const isOptionLeg = isDeltaOptionProductId(symbol);

  if (args.strategyId) {
    const strat = await prisma.strategy.findUnique({
      where: { id: args.strategyId },
      select: STRATEGY_SELECT_IS_ACTIVE,
    });
    if (!strat?.isActive && !args.adminForceSync) {
      return {
        success: false,
        error: "Strategy is paused",
        attempts: 0,
        verified: false,
      };
    }

    const sub = args.adminForceSync
      ? await findCopySubscriptionForUser(prisma, {
          strategyId: args.strategyId,
          userId: args.userId,
        })
      : await findActiveCopySubscriptionForUser(prisma, {
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
        error: args.adminForceSync
          ? "User is not subscribed to this strategy"
          : "No active subscription for this strategy",
        attempts: 0,
        verified: false,
      };
    }
    if (args.adminForceSync && !sub.isActive) {
      return {
        success: false,
        error: "User copy subscription is inactive (isActive is false).",
        attempts: 0,
        verified: false,
      };
    }

    if (
      !skipSyncStatusGate &&
      subscriptionSyncBlocksReconcile(sub.syncStatus)
    ) {
      console.log(
        `[RETRY_LOOP] skip open user=${args.userId} syncStatus=${sub.syncStatus}`,
      );
      return {
        success: false,
        error: `Subscription sync blocked (${sub.syncStatus})`,
        attempts: 0,
        verified: false,
      };
    }
  }

  if (args.reduceOnly === true) {
    const openSide: TradeSide = side === "BUY" ? "SELL" : "BUY";
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

    const { lots: closeLots, exchangeOpenLots } =
      await resolveFollowerReduceOnlyCloseLots({
        apiKey,
        apiSecret,
        symbol,
        openSide,
        requestedLots: targetContracts,
      });

    if (closeLots <= 0) {
      console.log(
        `[copy] reduceOnly skip user=${userId} ${symbol} open=${openSide} — ` +
          `exchange flat (liveLots=${exchangeOpenLots}); clearing DB ghost only`,
      );
      if (args.strategyId) {
        await closeTradePositionsForLeg(prisma, {
          strategyId: args.strategyId,
          userId: args.userId,
          symbol,
          side: openSide,
          ...(closeClientOrderId ? { clientOrderId: closeClientOrderId } : {}),
        });
      }
      return {
        success: true,
        attempts: 0,
        verified: true,
        ...(closeClientOrderId ? { clientOrderId: closeClientOrderId } : {}),
      };
    }

    const single = await placeFollowerOrder(
      apiKey,
      apiSecret,
      symbol,
      side,
      closeLots,
      {
        reduceOnly: true,
        ...(closeClientOrderId ? { clientOrderId: closeClientOrderId } : {}),
      },
    );
    if (!single.success) {
      const err = single.error ?? "Reduce-only close failed";
      if (isAlreadyFlatReduceOnlyError(err)) {
        if (args.strategyId) {
          await closeTradePositionsForLeg(prisma, {
            strategyId: args.strategyId,
            userId: args.userId,
            symbol,
            side: openSide,
            ...(closeClientOrderId ? { clientOrderId: closeClientOrderId } : {}),
          });
        }
        return {
          success: true,
          attempts: 1,
          verified: true,
          ...(single.orderId != null ? { orderId: single.orderId } : {}),
          ...(single.clientOrderId != null ? { clientOrderId: single.clientOrderId } : {}),
          ...(single.fillPrice != null ? { fillPrice: single.fillPrice } : {}),
          ...(single.feeCost != null ? { feeCost: single.feeCost } : {}),
          ...(single.raw !== undefined ? { raw: single.raw } : {}),
        };
      }
      await markFollowerOrderFailure(prisma, {
        strategyId: args.strategyId,
        userId,
        symbol,
        error: err,
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

  const minFilled = minVerifiedLots(targetContracts, isOptionLeg);
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

  const legLockKey = copyLegLockKey({
    userId: args.userId,
    ...(args.strategyId ? { strategyId: args.strategyId } : {}),
    symbol,
    side,
  });

  if (args.strategyId) {
    const inflightMs = args.liveMasterFill
      ? LIVE_FILL_VERIFY_WAIT_MS * (LIVE_FILL_MAX_POLLS + 1)
      : COPY_LEG_CONFIRM_MS;
    markFollowerCopyInflight(
      {
        userId: args.userId,
        strategyId: args.strategyId,
        symbol,
        side,
      },
      Date.now() + inflightMs,
    );
  }

  return withCopyLegExecutionLock(legLockKey, async () => {
    const tryFinalizeVerifiedOpen = async (
      exchangeLots: number,
      ack?: DeltaClientOrderAck,
    ): Promise<FollowerExecuteResult | null> => {
      if (exchangeLots > targetContracts) {
        console.warn(
          `[RETRY_LOOP] overfill user=${userId} ${symbol} exchange=${exchangeLots} target=${targetContracts} — capping DB at target`,
        );
      }
      const ackFilled = ack ? orderAckFilledQty(ack) : 0;
      const dbQty = resolvedDbOpenQty(targetContracts, exchangeLots, ackFilled);
      if (dbQty < minFilled) {
        return null;
      }
      const persisted = await recordVerifiedFollowerOpen(prisma, {
        userId: args.userId,
        symbol,
        side,
        quantity: dbQty,
        ...(args.strategyId ? { strategyId: args.strategyId } : {}),
        ...(args.entryPrice != null && Number.isFinite(args.entryPrice)
          ? { entryPrice: args.entryPrice }
          : {}),
        ...(openClientOrderId ? { clientOrderId: openClientOrderId } : {}),
        exchangeOrderId: ack?.orderId ?? lastResult.orderId ?? null,
      });
      if (!persisted) {
        console.warn(
          `[RETRY_LOOP] exchange/ack ok (${exchangeLots}/${targetContracts}, ack=${ackFilled}) but DB open failed user=${userId} ${symbol}`,
        );
        return null;
      }
      return buildOpenExecuteSuccess({
        lastResult: {
          ...lastResult,
          ...(ack?.orderId ? { orderId: ack.orderId } : {}),
        },
        ...(openClientOrderId ? { openClientOrderId } : {}),
        feeCost: totalFee,
        attempts: Math.max(attempts, 1),
        verifiedQty: dbQty,
      });
    };

    let exchangeLots = await followerLegContracts(apiKey, apiSecret, symbol, side, {
      skipCache: true,
    });
    const preVerified = await tryFinalizeVerifiedOpen(exchangeLots);
    if (preVerified) {
      console.log(
        `[RETRY_LOOP] Already synced (${exchangeLots}/${targetContracts} contracts) via REST — no order.`,
      );
      return preVerified;
    }

    let orderSubmitted = false;
    if (openClientOrderId) {
      const existingAck = await fetchDeltaOrderAckByClientOrderId(
        apiKey,
        apiSecret,
        openClientOrderId,
      );
      if (orderAckPending(existingAck) || orderAckFilledQty(existingAck) > 0) {
        orderSubmitted = true;
        console.log(
          `[RETRY_LOOP] Existing clientOrderId=${openClientOrderId} state=${existingAck.state} filled=${existingAck.filledSize} — poll only`,
        );
      }
    }

    if (!orderSubmitted) {
      const orderSize = Math.max(1, targetContracts - Math.floor(exchangeLots));
      attempts = 1;
      console.log(
        `[RETRY_LOOP] Single fire user ${userId} ${symbol} orderSize=${orderSize} ` +
          `(rest=${exchangeLots}, target=${targetContracts}) clientOrderId=${openClientOrderId ?? "none"}`,
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
        console.warn(`[RETRY_LOOP] executeTrade failed (single fire): ${err}`);
        if (openClientOrderId) {
          const ack = await fetchDeltaOrderAckByClientOrderId(
            apiKey,
            apiSecret,
            openClientOrderId,
          );
          if (orderAckPending(ack) || orderAckFilledQty(ack) > 0) {
            console.log(
              `[RETRY_LOOP] Place rejected but order live on exchange (${ack.state}) — poll only`,
            );
            orderSubmitted = true;
          }
        }
        if (!orderSubmitted && isHardExecutionError(err)) {
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
      } else {
        if (lastResult.feeCost != null && Number.isFinite(lastResult.feeCost)) {
          totalFee += lastResult.feeCost;
        }
      }
      orderSubmitted = true;
    }

    const verifyWaitMs = args.liveMasterFill
      ? LIVE_FILL_VERIFY_WAIT_MS
      : POST_ORDER_VERIFY_WAIT_MS;
    const maxPolls = args.liveMasterFill
      ? LIVE_FILL_MAX_POLLS
      : MAX_OPEN_CONFIRM_POLLS;

    if (args.liveMasterFill === true && orderSubmitted && lastResult.success) {
      exchangeLots = await followerLegContracts(apiKey, apiSecret, symbol, side, {
        skipCache: true,
      });
      let liveAck: DeltaClientOrderAck | undefined;
      if (openClientOrderId) {
        liveAck = await fetchDeltaOrderAckByClientOrderId(
          apiKey,
          apiSecret,
          openClientOrderId,
        );
      }
      const immediate = await tryFinalizeVerifiedOpen(exchangeLots, liveAck);
      if (immediate) {
        console.log(
          `[RETRY_LOOP] Live fill immediate verify user=${userId} ${symbol} ` +
            `(${exchangeLots}/${targetContracts} contracts)`,
        );
        return immediate;
      }
      if (
        lastResult.orderId ||
        (liveAck &&
          (orderAckPending(liveAck) || orderAckFilledQty(liveAck) > 0))
      ) {
        const optimisticQty = targetContracts;
        if (args.strategyId) {
          await recordTradePositionOpen(prisma, {
            strategyId: args.strategyId,
            userId: args.userId,
            symbol,
            side,
            quantity: optimisticQty,
            entryPrice:
              args.entryPrice != null && Number.isFinite(args.entryPrice)
                ? args.entryPrice
                : 0,
            ...(openClientOrderId ? { clientOrderId: openClientOrderId } : {}),
            ...(lastResult.orderId ? { exchangeOrderId: lastResult.orderId } : {}),
          });
        }
        console.log(
          `[RETRY_LOOP] Live fill fast-ack user=${userId} ${symbol} ` +
            `orderId=${lastResult.orderId ?? liveAck?.orderId ?? "pending"} — returning without slow poll`,
        );
        return buildOpenExecuteSuccess({
          lastResult,
          ...(openClientOrderId ? { openClientOrderId } : {}),
          feeCost: totalFee,
          attempts: Math.max(attempts, 1),
          verifiedQty: optimisticQty,
        });
      }
    }

    for (let poll = 0; poll < maxPolls; poll += 1) {
      if (!(args.liveMasterFill && poll === 0)) {
        console.log(
          `[RETRY_LOOP] REST confirm poll ${poll + 1}/${maxPolls} ` +
            `(wait ${verifyWaitMs}ms) user ${userId} ${symbol}`,
        );
        await sleep(verifyWaitMs);
      } else {
        console.log(
          `[RETRY_LOOP] Live fill confirm poll ${poll + 1}/${maxPolls} (no initial wait) user ${userId} ${symbol}`,
        );
      }

      exchangeLots = await followerLegContracts(apiKey, apiSecret, symbol, side, {
        skipCache: true,
      });

      let ack: DeltaClientOrderAck | undefined;
      if (openClientOrderId) {
        ack = await fetchDeltaOrderAckByClientOrderId(
          apiKey,
          apiSecret,
          openClientOrderId,
        );
      }

      const verified = await tryFinalizeVerifiedOpen(exchangeLots, ack);
      if (verified) {
        console.log(
          `[RETRY_LOOP] Verified via REST (${exchangeLots}/${targetContracts}) poll ${poll + 1}.`,
        );
        return verified;
      }

      if (ack && orderAckPending(ack)) {
        console.log(
          `[RETRY_LOOP] Order pending clientOrderId=${openClientOrderId} filled=${ack.filledSize} — continue polling`,
        );
        continue;
      }
    }

    exchangeLots = await followerLegContracts(apiKey, apiSecret, symbol, side, {
      skipCache: true,
    });
    let finalAck: DeltaClientOrderAck | undefined;
    if (openClientOrderId) {
      finalAck = await fetchDeltaOrderAckByClientOrderId(
        apiKey,
        apiSecret,
        openClientOrderId,
      );
    }
    const restFinalized = await tryFinalizeVerifiedOpen(exchangeLots, finalAck);
    if (restFinalized) {
      return restFinalized;
    }

    if (isOptionLeg && orderSubmitted && openClientOrderId && finalAck) {
      const ackFilled = orderAckFilledQty(finalAck);
      const dbQty = resolvedDbOpenQty(targetContracts, exchangeLots, ackFilled);
      if (dbQty >= minFilled) {
        console.warn(
          `[RETRY_LOOP] Option ${symbol} REST lag — ack filled=${ackFilled} position=${exchangeLots}`,
        );
        if (
          args.strategyId &&
          args.entryPrice != null &&
          Number.isFinite(args.entryPrice)
        ) {
          await recordTradePositionOpen(prisma, {
            strategyId: args.strategyId,
            userId: args.userId,
            symbol,
            side,
            quantity: dbQty,
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
          verifiedQty: dbQty,
        };
      }
    }

    const failMsg =
      lastResult.error ??
      `Position not verified after ${COPY_LEG_CONFIRM_MS}ms REST polling (${exchangeLots}/${targetContracts} contracts)`;
    console.error(
      `[RETRY_LOOP] Confirm window exhausted for user ${userId} on ${symbol}: ${failMsg}`,
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
  });
}

export type AdminAdjustFollowerQtyArgs = {
  strategyId: string;
  userId: string;
  symbol: string;
  currentSide: TradeSide;
  adjustmentLots: number;
};

export type AdminAdjustFollowerQtyResult =
  | {
      ok: true;
      strategyId: string;
      userId: string;
      symbol: string;
      currentSide: TradeSide;
      adjustmentLots: number;
      previousQuantity: number;
      newQuantity: number;
      executeSide: TradeSide;
      reduceOnly: boolean;
      orderId?: string;
    }
  | { ok: false; error: string; status?: number };

/** Map open-leg side + signed lot delta to exchange order side and reduce-only flag. */
export function resolveAdminQtyAdjustmentOrder(args: {
  currentSide: TradeSide;
  adjustmentLots: number;
}): { executeSide: TradeSide; reduceOnly: boolean; lots: number } {
  const lots = Math.abs(Math.trunc(args.adjustmentLots));
  if (!Number.isFinite(lots) || lots <= 0) {
    throw new Error("adjustmentLots must be a non-zero integer");
  }
  if (args.adjustmentLots > 0) {
    return { executeSide: args.currentSide, reduceOnly: false, lots };
  }
  return {
    executeSide: args.currentSide === "BUY" ? "SELL" : "BUY",
    reduceOnly: true,
    lots,
  };
}

/**
 * Admin manual lot adjustment on one follower leg — market order on Delta + TradePosition update.
 */
export async function adminAdjustFollowerTradeQuantity(
  prisma: PrismaClient,
  args: AdminAdjustFollowerQtyArgs,
): Promise<AdminAdjustFollowerQtyResult> {
  const { strategyId, userId, symbol } = args;
  const currentSide = args.currentSide;
  const adjustmentLots = Math.trunc(args.adjustmentLots);

  if (!strategyId || !userId || !symbol.trim()) {
    return { ok: false, error: "strategyId, userId, and symbol are required", status: 400 };
  }
  if (currentSide !== "BUY" && currentSide !== "SELL") {
    return { ok: false, error: "currentSide must be BUY or SELL", status: 400 };
  }
  if (!Number.isFinite(adjustmentLots) || adjustmentLots === 0) {
    return { ok: false, error: "adjustmentLots must be a non-zero integer", status: 400 };
  }

  const strategy = await prisma.strategy.findUnique({
    where: { id: strategyId },
    select: { id: true },
  });
  if (!strategy) {
    return { ok: false, error: "Strategy not found", status: 404 };
  }

  const sub = await findCopySubscriptionForUser(prisma, { userId, strategyId });
  if (!sub) {
    return { ok: false, error: "User is not subscribed to this strategy", status: 404 };
  }

  const creds = resolveCopySubscriptionCreds(sub);
  if (!creds) {
    return { ok: false, error: "No Delta API credentials for this user", status: 400 };
  }

  const previousQuantity = await sumOpenFollowerBotQuantity(prisma, {
    strategyId,
    userId,
    symbol,
    side: currentSide,
  });

  let orderPlan: ReturnType<typeof resolveAdminQtyAdjustmentOrder>;
  try {
    orderPlan = resolveAdminQtyAdjustmentOrder({ currentSide, adjustmentLots });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Invalid adjustment",
      status: 400,
    };
  }

  if (orderPlan.reduceOnly && orderPlan.lots > previousQuantity) {
    return {
      ok: false,
      error:
        `Cannot reduce ${orderPlan.lots} lots — bot-managed open quantity is ${previousQuantity}`,
      status: 400,
    };
  }

  const clientOrderId = buildClientOrderId({ strategyId, userId, symbol });

  console.log(
    `[admin-qty-adjust] user=${userId} ${symbol} open=${currentSide} delta=${adjustmentLots} ` +
      `→ ${orderPlan.executeSide} lots=${orderPlan.lots} reduceOnly=${orderPlan.reduceOnly}`,
  );

  const orderResult = await executeTrade(
    creds.apiKey,
    creds.apiSecret,
    symbol,
    orderPlan.executeSide,
    orderPlan.lots,
    {
      ...(orderPlan.reduceOnly ? { reduceOnly: true } : {}),
      clientOrderId,
    },
  );

  if (!orderResult.success) {
    return {
      ok: false,
      error: orderResult.error ?? "Market order failed",
      status: 502,
    };
  }

  let entryPrice = 0;
  try {
    const tick = await fetchDeltaTicker(symbol);
    if (tick.last != null && Number.isFinite(tick.last) && tick.last > 0) {
      entryPrice = tick.last;
    }
  } catch {
    /* optional for DB row */
  }

  if (orderPlan.reduceOnly) {
    await trimOpenFollowerBotQuantity(prisma, {
      strategyId,
      userId,
      symbol,
      side: currentSide,
      reduceBy: orderPlan.lots,
    });
  } else {
    if (entryPrice <= 0) {
      return {
        ok: false,
        error: `Order placed but could not resolve mark price to update TradePosition for ${symbol}`,
        status: 502,
      };
    }
    await incrementOrRecordFollowerTradePosition(prisma, {
      strategyId,
      userId,
      symbol,
      side: currentSide,
      addLots: orderPlan.lots,
      entryPrice,
      clientOrderId,
      exchangeOrderId: orderResult.orderId ?? null,
    });
  }

  const newQuantity = Math.max(0, previousQuantity + adjustmentLots);

  await markSubscriptionSynced(prisma, { userId, strategyId }).catch(() => {
    /* non-fatal */
  });

  return {
    ok: true,
    strategyId,
    userId,
    symbol,
    currentSide,
    adjustmentLots,
    previousQuantity,
    newQuantity,
    executeSide: orderPlan.executeSide,
    reduceOnly: orderPlan.reduceOnly,
    ...(orderResult.orderId ? { orderId: orderResult.orderId } : {}),
  };
}

export type AdminBulkAdjustFollowerLegResult =
  | (Extract<AdminAdjustFollowerQtyResult, { ok: true }>)
  | { ok: false; error: string; symbol: string; side: string };

export type AdminBulkAdjustFollowerQtyResult =
  | {
      ok: true;
      strategyId: string;
      userId: string;
      adjustmentLots: number;
      legsAttempted: number;
      legsSucceeded: number;
      results: AdminBulkAdjustFollowerLegResult[];
    }
  | { ok: false; error: string; status?: number };

/** Apply the same lot delta to every open follower leg for a user. */
export async function adminBulkAdjustFollowerTradeQuantity(
  prisma: PrismaClient,
  args: {
    strategyId: string;
    userId: string;
    adjustmentLots: number;
  },
): Promise<AdminBulkAdjustFollowerQtyResult> {
  const { strategyId, userId } = args;
  const adjustmentLots = Math.trunc(args.adjustmentLots);

  if (!strategyId || !userId) {
    return { ok: false, error: "strategyId and userId are required", status: 400 };
  }
  if (!Number.isFinite(adjustmentLots) || adjustmentLots === 0) {
    return { ok: false, error: "adjustmentLots must be a non-zero integer", status: 400 };
  }

  const legs = await listOpenFollowerBotLegs(prisma, strategyId, userId);
  if (legs.length === 0) {
    return { ok: false, error: "No open TradePosition legs for this user", status: 404 };
  }

  const results: AdminBulkAdjustFollowerLegResult[] = [];
  let legsSucceeded = 0;

  for (const leg of legs) {
    const side = leg.side.toUpperCase() as TradeSide;
    if (side !== "BUY" && side !== "SELL") continue;

    const result = await adminAdjustFollowerTradeQuantity(prisma, {
      strategyId,
      userId,
      symbol: leg.symbol,
      currentSide: side,
      adjustmentLots,
    });

    if (result.ok) {
      legsSucceeded += 1;
      results.push(result);
    } else {
      results.push({
        ok: false,
        error: result.error,
        symbol: leg.symbol,
        side: leg.side,
      });
    }
  }

  if (legsSucceeded === 0) {
    return {
      ok: false,
      error: results[0]?.ok === false ? results[0].error : "All leg adjustments failed",
      status: 422,
    };
  }

  return {
    ok: true,
    strategyId,
    userId,
    adjustmentLots,
    legsAttempted: legs.length,
    legsSucceeded,
    results,
  };
}

export type AdminAdjustMasterQtyArgs = {
  strategyId: string;
  symbol: string;
  currentSide: TradeSide;
  adjustmentLots: number;
  copyToUsers: boolean;
};

export type AdminAdjustMasterQtyResult =
  | {
      ok: true;
      strategyId: string;
      symbol: string;
      currentSide: TradeSide;
      adjustmentLots: number;
      copyToUsers: boolean;
      previousQuantity: number;
      newQuantity: number;
      executeSide: TradeSide;
      reduceOnly: boolean;
      clientOrderId: string;
      orderId?: string;
    }
  | { ok: false; error: string; status?: number };

/** Admin manual lot adjustment on one master leg — optional follower fan-out via copy engine. */
export async function adminAdjustMasterTradeQuantity(
  prisma: PrismaClient,
  args: AdminAdjustMasterQtyArgs,
): Promise<AdminAdjustMasterQtyResult> {
  const { strategyId, symbol } = args;
  const currentSide = args.currentSide;
  const adjustmentLots = Math.trunc(args.adjustmentLots);
  const copyToUsers = args.copyToUsers === true;

  if (!strategyId || !symbol.trim()) {
    return { ok: false, error: "strategyId and symbol are required", status: 400 };
  }
  if (currentSide !== "BUY" && currentSide !== "SELL") {
    return { ok: false, error: "currentSide must be BUY or SELL", status: 400 };
  }
  if (!Number.isFinite(adjustmentLots) || adjustmentLots === 0) {
    return { ok: false, error: "adjustmentLots must be a non-zero integer", status: 400 };
  }

  const strategy = await prisma.strategy.findUnique({
    where: { id: strategyId },
    select: { id: true, masterApiKey: true, masterApiSecret: true },
  });
  if (!strategy) {
    return { ok: false, error: "Strategy not found", status: 404 };
  }

  const apiKey = strategy.masterApiKey?.trim() ?? "";
  const apiSecret = strategy.masterApiSecret?.trim() ?? "";
  if (!apiKey || !apiSecret) {
    return { ok: false, error: "Master Delta credentials are missing", status: 400 };
  }

  const previousQuantity = await sumOpenMasterBotQuantity(prisma, {
    strategyId,
    symbol,
    side: currentSide,
  });

  let orderPlan: ReturnType<typeof resolveAdminQtyAdjustmentOrder>;
  try {
    orderPlan = resolveAdminQtyAdjustmentOrder({ currentSide, adjustmentLots });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Invalid adjustment",
      status: 400,
    };
  }

  if (orderPlan.reduceOnly && orderPlan.lots > previousQuantity) {
    return {
      ok: false,
      error:
        `Cannot reduce ${orderPlan.lots} lots — bot-managed master quantity is ${previousQuantity}`,
      status: 400,
    };
  }

  const clientOrderId = copyToUsers
    ? buildClientOrderId({ strategyId, isMaster: true, symbol })
    : buildMasterNoCopyClientOrderId();

  if (!copyToUsers) {
    registerPendingMasterNoCopyOrderId(clientOrderId);
    registerMasterNoCopyRestSuppress({
      strategyId,
      symbol,
      side: currentSide,
    });
  }

  console.log(
    `[admin-master-qty-adjust] strategy=${strategyId} ${symbol} open=${currentSide} delta=${adjustmentLots} ` +
      `copyToUsers=${copyToUsers} clientOrderId=${clientOrderId} → ${orderPlan.executeSide} lots=${orderPlan.lots}`,
  );

  const orderResult = await executeTrade(
    apiKey,
    apiSecret,
    symbol,
    orderPlan.executeSide,
    orderPlan.lots,
    {
      ...(orderPlan.reduceOnly ? { reduceOnly: true } : {}),
      clientOrderId,
    },
  );

  if (!orderResult.success) {
    return {
      ok: false,
      error: orderResult.error ?? "Master market order failed",
      status: 502,
    };
  }

  if (copyToUsers) {
    if (orderPlan.reduceOnly) {
      await trimOpenMasterBotQuantity(prisma, {
        strategyId,
        symbol,
        side: currentSide,
        reduceBy: orderPlan.lots,
      });

      const subscribers = await findActiveFutureHedgeCopySubscribers(prisma);
      for (const sub of subscribers) {
        await adminAdjustFollowerTradeQuantity(prisma, {
          strategyId,
          userId: sub.userId,
          symbol,
          currentSide,
          adjustmentLots,
        });
      }
    }

    const newQuantityEstimate = Math.max(0, previousQuantity + adjustmentLots);
    return {
      ok: true,
      strategyId,
      symbol,
      currentSide,
      adjustmentLots,
      copyToUsers,
      previousQuantity,
      newQuantity: newQuantityEstimate,
      executeSide: orderPlan.executeSide,
      reduceOnly: orderPlan.reduceOnly,
      clientOrderId,
      ...(orderResult.orderId ? { orderId: orderResult.orderId } : {}),
    };
  }

  let entryPrice = 0;
  try {
    const tick = await fetchDeltaTicker(symbol);
    if (tick.last != null && Number.isFinite(tick.last) && tick.last > 0) {
      entryPrice = tick.last;
    }
  } catch {
    /* optional for DB row */
  }

  if (orderPlan.reduceOnly) {
    await trimOpenMasterBotQuantity(prisma, {
      strategyId,
      symbol,
      side: currentSide,
      reduceBy: orderPlan.lots,
    });
  } else {
    if (entryPrice <= 0) {
      return {
        ok: false,
        error: `Order placed but could not resolve mark price to update master TradePosition for ${symbol}`,
        status: 502,
      };
    }
    await incrementOrRecordMasterTradePosition(prisma, {
      strategyId,
      symbol,
      side: currentSide,
      addLots: orderPlan.lots,
      entryPrice,
      clientOrderId,
      exchangeOrderId: orderResult.orderId ?? null,
    });
  }

  const newQuantity = Math.max(0, previousQuantity + adjustmentLots);

  return {
    ok: true,
    strategyId,
    symbol,
    currentSide,
    adjustmentLots,
    copyToUsers,
    previousQuantity,
    newQuantity,
    executeSide: orderPlan.executeSide,
    reduceOnly: orderPlan.reduceOnly,
    clientOrderId,
    ...(orderResult.orderId ? { orderId: orderResult.orderId } : {}),
  };
}

export type AdminBulkAdjustMasterLegResult =
  | (Extract<AdminAdjustMasterQtyResult, { ok: true }>)
  | { ok: false; error: string; symbol: string; side: string };

export type AdminBulkAdjustMasterQtyResult =
  | {
      ok: true;
      strategyId: string;
      adjustmentLots: number;
      copyToUsers: boolean;
      legsAttempted: number;
      legsSucceeded: number;
      results: AdminBulkAdjustMasterLegResult[];
    }
  | { ok: false; error: string; status?: number };

/** Apply the same lot delta to every open master leg (Delta REST positions). */
export async function adminBulkAdjustMasterTradeQuantity(
  prisma: PrismaClient,
  args: {
    strategyId: string;
    adjustmentLots: number;
    copyToUsers: boolean;
  },
): Promise<AdminBulkAdjustMasterQtyResult> {
  const { strategyId } = args;
  const adjustmentLots = Math.trunc(args.adjustmentLots);
  const copyToUsers = args.copyToUsers === true;

  if (!strategyId) {
    return { ok: false, error: "strategyId is required", status: 400 };
  }
  if (!Number.isFinite(adjustmentLots) || adjustmentLots === 0) {
    return { ok: false, error: "adjustmentLots must be a non-zero integer", status: 400 };
  }

  const strategy = await prisma.strategy.findUnique({
    where: { id: strategyId },
    select: { id: true, masterApiKey: true, masterApiSecret: true },
  });
  if (!strategy) {
    return { ok: false, error: "Strategy not found", status: 404 };
  }

  const apiKey = strategy.masterApiKey?.trim() ?? "";
  const apiSecret = strategy.masterApiSecret?.trim() ?? "";
  if (!apiKey || !apiSecret) {
    return { ok: false, error: "Master Delta credentials are missing", status: 400 };
  }

  const { fetchMasterOpenPositions } = await import("./tradeEngine.js");
  let legs: Awaited<ReturnType<typeof fetchMasterOpenPositions>>;
  try {
    legs = await fetchMasterOpenPositions(apiKey, apiSecret, { skipCache: true });
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error
          ? err.message
          : "Failed to fetch master open positions from Delta",
      status: 502,
    };
  }

  const activeLegs = legs.filter((leg) => leg.masterContracts > 0);
  if (activeLegs.length === 0) {
    return { ok: false, error: "No open master positions on Delta", status: 404 };
  }

  const results: AdminBulkAdjustMasterLegResult[] = [];
  let legsSucceeded = 0;

  for (const leg of activeLegs) {
    const currentSide = leg.side;
    if (currentSide !== "BUY" && currentSide !== "SELL") continue;

    const result = await adminAdjustMasterTradeQuantity(prisma, {
      strategyId,
      symbol: leg.deltaSymbol,
      currentSide,
      adjustmentLots,
      copyToUsers,
    });

    if (result.ok) {
      legsSucceeded += 1;
      results.push(result);
    } else {
      results.push({
        ok: false,
        error: result.error,
        symbol: leg.deltaSymbol,
        side: currentSide,
      });
    }
  }

  if (legsSucceeded === 0) {
    return {
      ok: false,
      error: results[0]?.ok === false ? results[0].error : "All master leg adjustments failed",
      status: 422,
    };
  }

  return {
    ok: true,
    strategyId,
    adjustmentLots,
    copyToUsers,
    legsAttempted: activeLegs.length,
    legsSucceeded,
    results,
  };
}
