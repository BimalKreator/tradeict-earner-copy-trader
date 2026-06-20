import { randomUUID } from "node:crypto";
import {
  FutureHedgeBatchTrend,
  type FutureHedgeConfig,
  type PrismaClient,
} from "@prisma/client";
import {
  executeTrade,
  fetchDeltaOpenPositions,
  findAtmBtcOptionForExpiry,
  findAtmBtcOptionProductId,
  isDeltaOptionProductId,
  parseBtcOptionProductId,
  type AtmBtcOptionMatch,
  type DeltaLivePosition,
  type TradeSide,
} from "./exchangeService.js";
import {
  FUTURE_HEDGE_BTC_SYMBOL,
  getCurrentTrend,
  getLiveFuturePrice,
  type FutureHedgeTrend,
} from "./futureHedgeDataService.js";
import { FUTURE_HEDGE_STRATEGY_TITLE } from "./futureHedgeService.js";
import { findActiveFutureHedgeCopySubscribers } from "./strategySubscriptionService.js";
import {
  clearBreakevenHedgeEntryLatch,
  isBreakevenHedgeEntryLatched,
  isMasterFlatting,
  markMasterFlatting,
  markPostExitEntryBlock,
  isPostExitEntryBlocked,
  POST_EXIT_ENTRY_BLOCK_MS,
} from "./subscriptionSyncService.js";
import {
  assertMasterHedgeEntryGate,
  isBreakevenZoneBlockingHedgeEntry,
  isMasterEntryFrozen,
} from "./masterEntryGate.js";

const ENGINE_TICK_MS =
  Number(process.env.FUTURE_HEDGE_ENGINE_TICK_MS) || 5_000;
const MTM_TICK_MS = Number(process.env.FUTURE_HEDGE_MTM_TICK_MS) || 1_000;
const ENTRY_COOLDOWN_MS =
  Number(process.env.FUTURE_HEDGE_ENTRY_COOLDOWN_MS) || 120_000;
const BATCH_EXPIRY_MATCH_TOLERANCE_MS = 86_400_000;

const AUTOMATION_DISABLED_MSG =
  "Future Hedge autonomous engine is disabled — use Strategy SL/TP/breakeven or admin close only";

export type FutureHedgeEntryResult = {
  ok: boolean;
  batchId?: string;
  trend?: FutureHedgeTrend;
  lastEntryPrice?: number;
  perpOrderId?: string;
  optionProductId?: string;
  optionOrderId?: string;
  error?: string;
};

export type FutureHedgeAdjustmentResult = {
  ok: boolean;
  batchId?: string;
  newAnchorPrice?: number;
  error?: string;
};

export type FutureHedgeExitResult = {
  ok: boolean;
  batchId?: string;
  combinedMtm?: number;
  targetProfitUsd?: number;
  closedLegs?: number;
  error?: string;
};

export type BatchMtmSnapshot = {
  batchId: string;
  combinedMtm: number;
  targetProfitUsd: number;
  legCount: number;
  legs: Array<{
    symbol: string;
    side: TradeSide;
    contracts: number;
    unrealizedPnl: number;
  }>;
};

let destroyed = true;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let mtmTimer: ReturnType<typeof setInterval> | null = null;
let entryInFlight = false;
let adjustmentInFlight = false;
let closeInFlight = false;
let lastEntryAttemptAt = 0;
let lastLoggedMtm: number | null = null;
let lastNoSubscriberSafetyAt = 0;
let lastNoSubscriberBlockLogAt = 0;

const NO_SUBSCRIBER_FLATTEN_COOLDOWN_MS = 60_000;
const NO_SUBSCRIBER_BLOCK_LOG_MS = 300_000;

function logMasterOpenBlocked(reason: string): void {
  const now = Date.now();
  if (now - lastNoSubscriberBlockLogAt < NO_SUBSCRIBER_BLOCK_LOG_MS) return;
  lastNoSubscriberBlockLogAt = now;
  console.warn(`[future-hedge-engine] master opens BLOCKED: ${reason}`);
}

/** @deprecated Use markPostExitEntryBlock from subscriptionSyncService */
export function markFutureHedgePostExitEntryBlock(
  durationMs: number = POST_EXIT_ENTRY_BLOCK_MS,
): void {
  markPostExitEntryBlock(durationMs);
  lastEntryAttemptAt = Date.now();
}

/** @deprecated Use isPostExitEntryBlocked from subscriptionSyncService */
export function isFutureHedgePostExitEntryBlocked(): boolean {
  return isPostExitEntryBlocked();
}

/** Master hedge opens require gate pass + active strategy + copy subscribers. */
async function assertMasterHedgeOpensAllowed(
  prisma: PrismaClient,
  strategy?: { id: string; isActive: boolean },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const gate = await assertMasterHedgeEntryGate(prisma, strategy);
  if (!gate.ok) return gate;
  const subs = await findActiveFutureHedgeCopySubscribers(prisma);
  if (subs.length === 0) {
    return {
      ok: false,
      reason: "no active copy subscribers — refusing master entry/adjustment",
    };
  }
  return { ok: true };
}

/**
 * Previously auto-flattened master when no copy subscribers existed.
 * Disabled — master exits are SL/TP/breakeven/admin only.
 */
export async function enforceNoSubscriberMasterSafety(
  _prisma: PrismaClient,
): Promise<void> {
  /* no-op */
}

function generateBatchId(): string {
  return `fh-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

function trendToBatchEnum(trend: FutureHedgeTrend): FutureHedgeBatchTrend {
  return trend === "UPTREND"
    ? FutureHedgeBatchTrend.UPTREND
    : FutureHedgeBatchTrend.DOWNTREND;
}

function expiryMsFromConfig(config: FutureHedgeConfig): number | null {
  if (config.batchOptionExpiryMs == null) return null;
  const n = Number(config.batchOptionExpiryMs);
  return Number.isFinite(n) ? n : null;
}

function normSymbol(s: string): string {
  return s.trim().toUpperCase();
}

function btcPerpAliases(): Set<string> {
  return new Set(
    [
      FUTURE_HEDGE_BTC_SYMBOL,
      "BTCUSDT",
      "BTCUSD",
      "BTC/USD:USD",
    ].map(normSymbol),
  );
}

function isBtcPerpSymbol(symbol: string): boolean {
  const u = normSymbol(symbol);
  const aliases = btcPerpAliases();
  if (aliases.has(u)) return true;
  return u.includes("BTC") && !isDeltaOptionProductId(u);
}

async function loadBatchSymbolSet(
  prisma: PrismaClient,
  batchId: string,
): Promise<Set<string>> {
  const rows = await prisma.futureHedgeExecution.findMany({
    where: { batchId },
    select: { symbol: true },
  });
  const set = new Set<string>();
  for (const row of rows) {
    if (row.symbol?.trim()) set.add(normSymbol(row.symbol));
  }
  for (const alias of btcPerpAliases()) {
    set.add(alias);
  }
  return set;
}

function positionMatchesBatch(
  pos: DeltaLivePosition,
  batchSymbols: Set<string>,
  config: FutureHedgeConfig,
): boolean {
  const keys = [normSymbol(pos.symbolKey), normSymbol(pos.symbol)];
  for (const k of keys) {
    if (batchSymbols.has(k)) return true;
  }

  if (isBtcPerpSymbol(pos.symbolKey) || isBtcPerpSymbol(pos.symbol)) {
    for (const sym of batchSymbols) {
      if (isBtcPerpSymbol(sym)) return true;
    }
  }

  const expiryMs = expiryMsFromConfig(config);
  if (expiryMs == null || config.batchTrend == null) return false;

  const productId = pos.symbolKey.trim();
  if (!isDeltaOptionProductId(productId)) return false;

  const parsed = parseBtcOptionProductId(productId);
  if (!parsed) return false;

  const wantCall = config.batchTrend === FutureHedgeBatchTrend.UPTREND;
  if (parsed.type !== (wantCall ? "call" : "put")) return false;

  return Math.abs(parsed.expiryMs - expiryMs) <= BATCH_EXPIRY_MATCH_TOLERANCE_MS;
}

/**
 * Sum live unrealized PnL for master positions tied to the active batch.
 */
export async function computeCombinedBatchMtm(
  prisma: PrismaClient,
  apiKey: string,
  apiSecret: string,
  config: FutureHedgeConfig,
): Promise<BatchMtmSnapshot | null> {
  const batchId = config.currentBatchId;
  if (!batchId) return null;

  const batchSymbols = await loadBatchSymbolSet(prisma, batchId);
  const open = await fetchDeltaOpenPositions(apiKey, apiSecret);

  const legs: BatchMtmSnapshot["legs"] = [];
  let combinedMtm = 0;

  for (const pos of open) {
    if (!positionMatchesBatch(pos, batchSymbols, config)) continue;

    if (
      pos.unrealizedPnl == null ||
      !Number.isFinite(pos.unrealizedPnl)
    ) {
      return null;
    }

    combinedMtm += pos.unrealizedPnl;
    legs.push({
      symbol: pos.symbolKey,
      side: pos.side,
      contracts: pos.contracts,
      unrealizedPnl: pos.unrealizedPnl,
    });
  }

  return {
    batchId,
    combinedMtm,
    targetProfitUsd: config.targetProfitUsd,
    legCount: legs.length,
    legs,
  };
}

async function clearActiveBatch(
  prisma: PrismaClient,
  configId: string,
): Promise<void> {
  await prisma.futureHedgeConfig.update({
    where: { id: configId },
    data: {
      currentBatchId: null,
      lastEntryPrice: null,
      batchTrend: null,
      batchOptionProductId: null,
      batchOptionExpiryMs: null,
    },
  });
}

/**
 * Reset Future Hedge batch state when master is fully flat (auto-exit, manual close, etc.).
 * Prevents the engine from running grid adjustments against an empty exchange book.
 */
export async function clearFutureHedgeActiveBatch(
  prisma: PrismaClient,
  reason: string,
): Promise<boolean> {
  markPostExitEntryBlock();
  lastEntryAttemptAt = Date.now();

  const config = await prisma.futureHedgeConfig.findFirst({
    where: { strategy: { title: FUTURE_HEDGE_STRATEGY_TITLE } },
    select: { id: true, currentBatchId: true },
  });
  if (!config?.currentBatchId) {
    console.log(
      `[future-hedge-engine] post-exit entry cooldown (${reason}) — no active batch`,
    );
    return false;
  }

  await clearActiveBatch(prisma, config.id);
  lastLoggedMtm = null;

  console.log(
    `[future-hedge-engine] batch cleared (${reason}) — was id=${config.currentBatchId}`,
  );
  return true;
}

/**
 * Market-close every open leg belonging to the batch (reduce-only).
 */
export async function forceCloseBatchPositions(
  apiKey: string,
  apiSecret: string,
  legs: BatchMtmSnapshot["legs"],
): Promise<{ closed: number; errors: string[] }> {
  const errors: string[] = [];
  let closed = 0;

  for (const leg of legs) {
    const lots = Math.max(1, Math.round(Math.abs(leg.contracts)));
    const closeSide: TradeSide = leg.side === "BUY" ? "SELL" : "BUY";
    const symbol = leg.symbol;

    try {
      const res = await executeTrade(apiKey, apiSecret, symbol, closeSide, lots, {
        reduceOnly: true,
        orderSource: "future-hedge-engine:flatten",
      });
      if (!res.success) {
        errors.push(`${symbol}: ${res.error ?? "close failed"}`);
        continue;
      }
      closed += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${symbol}: ${msg}`);
    }
  }

  return { closed, errors };
}

/**
 * Target profit exit: close all batch legs and reset config for a new entry cycle.
 */
export async function tryExecuteTargetExit(
  _prisma: PrismaClient,
): Promise<FutureHedgeExitResult> {
  return { ok: false, error: AUTOMATION_DISABLED_MSG };
}

/**
 * UPTREND: trigger when price falls >= adjustmentPct from anchor.
 * DOWNTREND: trigger when price rises >= adjustmentPct from anchor.
 */
export function shouldTriggerAdjustment(
  batchTrend: FutureHedgeBatchTrend,
  anchorPrice: number,
  livePrice: number,
  adjustmentPct: number,
): boolean {
  if (
    !Number.isFinite(anchorPrice) ||
    anchorPrice <= 0 ||
    !Number.isFinite(livePrice) ||
    livePrice <= 0 ||
    !Number.isFinite(adjustmentPct) ||
    adjustmentPct <= 0
  ) {
    return false;
  }

  const factor = adjustmentPct / 100;

  if (batchTrend === FutureHedgeBatchTrend.UPTREND) {
    return livePrice <= anchorPrice * (1 - factor);
  }

  return livePrice >= anchorPrice * (1 + factor);
}

async function rollbackLeg(
  apiKey: string,
  apiSecret: string,
  symbol: string,
  openSide: TradeSide,
  lots: number,
): Promise<void> {
  const closeSide: TradeSide = openSide === "BUY" ? "SELL" : "BUY";
  try {
    await executeTrade(apiKey, apiSecret, symbol, closeSide, lots, {
      reduceOnly: true,
      orderSource: "future-hedge-engine:rollback",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[future-hedge-engine] rollback failed symbol=${symbol} side=${closeSide}:`,
      msg,
    );
  }
}

async function executePerpAndOption(
  prisma: PrismaClient,
  apiKey: string,
  apiSecret: string,
  perpSide: TradeSide,
  optionProductId: string,
  lots: number,
): Promise<{
  ok: boolean;
  perpFill: number | null;
  perpOrderId?: string;
  optOrderId?: string;
  error?: string;
}> {
  const openGate = await assertMasterHedgeOpensAllowed(prisma);
  if (!openGate.ok) {
    logMasterOpenBlocked(openGate.reason);
    return { ok: false, perpFill: null, error: openGate.reason };
  }

  const [perpRes, optRes] = await Promise.all([
    executeTrade(apiKey, apiSecret, FUTURE_HEDGE_BTC_SYMBOL, perpSide, lots, {
      orderSource: "future-hedge-engine:perp-open",
    }),
    executeTrade(apiKey, apiSecret, optionProductId, "SELL", lots, {
      orderSource: "future-hedge-engine:option-open",
    }),
  ]);

  if (!perpRes.success || !optRes.success) {
    if (perpRes.success) {
      await rollbackLeg(apiKey, apiSecret, FUTURE_HEDGE_BTC_SYMBOL, perpSide, lots);
    }
    if (optRes.success) {
      await rollbackLeg(apiKey, apiSecret, optionProductId, "SELL", lots);
    }
    const errParts = [
      !perpRes.success ? `perp: ${perpRes.error ?? "failed"}` : null,
      !optRes.success ? `option: ${optRes.error ?? "failed"}` : null,
    ].filter(Boolean);
    return {
      ok: false,
      perpFill: null,
      error: errParts.join("; ") || "Order failed",
    };
  }

  const perpFill =
    perpRes.fillPrice != null && Number.isFinite(perpRes.fillPrice)
      ? perpRes.fillPrice
      : null;

  const result: {
    ok: boolean;
    perpFill: number | null;
    perpOrderId?: string;
    optOrderId?: string;
  } = { ok: true, perpFill };
  if (perpRes.orderId) result.perpOrderId = perpRes.orderId;
  if (optRes.orderId) result.optOrderId = optRes.orderId;
  return result;
}

async function resolveOptionForBatch(
  batchTrend: FutureHedgeBatchTrend,
  spot: number,
  config: FutureHedgeConfig,
): Promise<AtmBtcOptionMatch | null> {
  const optionType =
    batchTrend === FutureHedgeBatchTrend.UPTREND ? "call" : "put";
  const expiryMs = expiryMsFromConfig(config);

  if (expiryMs != null) {
    const atm = await findAtmBtcOptionForExpiry(optionType, spot, expiryMs);
    if (atm) return atm;
  }

  return findAtmBtcOptionProductId(optionType, spot);
}

/**
 * Opens a fresh hedge batch: perp leg + short ATM option on nearest expiry.
 */
export async function tryExecuteFreshEntry(
  _prisma: PrismaClient,
): Promise<FutureHedgeEntryResult> {
  return { ok: false, error: AUTOMATION_DISABLED_MSG };
}

/**
 * Grid adjustment for an active batch when price moves by adjustmentPct from anchor.
 * Disabled — autonomous adjustments are off.
 */
export async function tryExecuteAdjustment(
  _prisma: PrismaClient,
): Promise<FutureHedgeAdjustmentResult> {
  return { ok: false, error: AUTOMATION_DISABLED_MSG };
}

/**
 * Boot hook — autonomous hedge timers are not started.
 * Master copy + SL/TP/breakeven run via tradeEngine / autoExitService.
 */
export function startFutureHedgeEngine(_prisma: PrismaClient): () => void {
  console.log(
    "[future-hedge-engine] DISABLED — no autonomous entry, grid adjustment, or MTM target exits. " +
      "Master exits: Strategy autoExitTarget / autoExitStopLoss, breakeven price, or admin manual close only.",
  );
  return () => undefined;
}
