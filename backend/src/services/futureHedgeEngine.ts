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

const ENGINE_TICK_MS =
  Number(process.env.FUTURE_HEDGE_ENGINE_TICK_MS) || 5_000;
const MTM_TICK_MS = Number(process.env.FUTURE_HEDGE_MTM_TICK_MS) || 1_000;
const ENTRY_COOLDOWN_MS =
  Number(process.env.FUTURE_HEDGE_ENTRY_COOLDOWN_MS) || 120_000;
const BATCH_EXPIRY_MATCH_TOLERANCE_MS = 86_400_000;

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

/** Master hedge opens require an active strategy and at least one copy subscriber. */
async function assertMasterHedgeOpensAllowed(
  prisma: PrismaClient,
  strategy?: { isActive: boolean },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const strat =
    strategy ??
    (await prisma.strategy.findFirst({
      where: { title: FUTURE_HEDGE_STRATEGY_TITLE },
      select: { isActive: true },
    }));
  if (!strat?.isActive) {
    return { ok: false, reason: "strategy paused (isActive=false)" };
  }
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
 * When nobody is copying, never leave a bot-opened master book exposed.
 * Flattens reduce-only (throttled) and clears batch state.
 */
export async function enforceNoSubscriberMasterSafety(
  prisma: PrismaClient,
): Promise<void> {
  const subs = await findActiveFutureHedgeCopySubscribers(prisma);
  if (subs.length > 0) return;

  const strategy = await prisma.strategy.findFirst({
    where: { title: FUTURE_HEDGE_STRATEGY_TITLE },
    include: { futureHedgeConfig: true },
  });
  const apiKey = strategy?.masterApiKey?.trim() ?? "";
  const apiSecret = strategy?.masterApiSecret?.trim() ?? "";
  if (!apiKey || !apiSecret) return;

  let open: DeltaLivePosition[];
  try {
    open = await fetchDeltaOpenPositions(apiKey, apiSecret, { skipCache: true });
  } catch {
    return;
  }

  const liveLegs = open.filter((p) => Math.abs(p.contracts) >= 1e-12);
  if (liveLegs.length === 0) {
    if (strategy?.futureHedgeConfig?.currentBatchId) {
      await clearFutureHedgeActiveBatch(prisma, "no-subscribers-exchange-flat");
    }
    return;
  }

  const now = Date.now();
  if (now - lastNoSubscriberSafetyAt < NO_SUBSCRIBER_FLATTEN_COOLDOWN_MS) {
    return;
  }
  lastNoSubscriberSafetyAt = now;

  console.warn(
    `[future-hedge-engine] 0 copy subscribers but master has ${liveLegs.length} open leg(s) — ` +
      `flattening reduce-only to prevent orphan exposure`,
  );

  const { closed, errors } = await forceCloseBatchPositions(
    apiKey,
    apiSecret,
    liveLegs.map((p) => ({
      symbol: p.symbolKey,
      side: p.side,
      contracts: p.contracts,
      unrealizedPnl: p.unrealizedPnl ?? 0,
    })),
  );

  if (errors.length > 0) {
    console.error(
      `[future-hedge-engine] no-subscriber flatten partial closed=${closed}/${liveLegs.length}: ${errors.join("; ")}`,
    );
  } else {
    console.log(
      `[future-hedge-engine] no-subscriber flatten complete closed=${closed} leg(s)`,
    );
  }

  await clearFutureHedgeActiveBatch(prisma, "no-subscribers-flatten");
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

    const upnl =
      pos.unrealizedPnl != null && Number.isFinite(pos.unrealizedPnl)
        ? pos.unrealizedPnl
        : 0;

    combinedMtm += upnl;
    legs.push({
      symbol: pos.symbolKey,
      side: pos.side,
      contracts: pos.contracts,
      unrealizedPnl: upnl,
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
  const config = await prisma.futureHedgeConfig.findFirst({
    where: { strategy: { title: FUTURE_HEDGE_STRATEGY_TITLE } },
    select: { id: true, currentBatchId: true },
  });
  if (!config?.currentBatchId) return false;

  await clearActiveBatch(prisma, config.id);
  lastEntryAttemptAt = Date.now();
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
  prisma: PrismaClient,
): Promise<FutureHedgeExitResult> {
  if (closeInFlight || entryInFlight || adjustmentInFlight) {
    return { ok: false, error: "Another hedge operation in progress" };
  }

  closeInFlight = true;

  try {
    const strategy = await prisma.strategy.findFirst({
      where: { title: FUTURE_HEDGE_STRATEGY_TITLE },
      include: { futureHedgeConfig: true },
    });

    const config = strategy?.futureHedgeConfig;
    if (!strategy || !config?.currentBatchId) {
      return { ok: false, error: "No active batch" };
    }

    const apiKey = strategy.masterApiKey?.trim() ?? "";
    const apiSecret = strategy.masterApiSecret?.trim() ?? "";
    if (!apiKey || !apiSecret) {
      return { ok: false, error: "Master API keys not configured" };
    }

    const snapshot = await computeCombinedBatchMtm(
      prisma,
      apiKey,
      apiSecret,
      config,
    );
    if (!snapshot) {
      return { ok: false, error: "MTM snapshot unavailable" };
    }

    if (snapshot.combinedMtm < config.targetProfitUsd) {
      return {
        ok: false,
        error: "Target profit not reached",
        combinedMtm: snapshot.combinedMtm,
        targetProfitUsd: config.targetProfitUsd,
      };
    }

    const batchId = config.currentBatchId;

    console.log(
      `[future-hedge-engine] TARGET EXIT batch=${batchId} mtm=${snapshot.combinedMtm.toFixed(2)} ` +
        `target=${config.targetProfitUsd} legs=${snapshot.legCount}`,
    );

    const { closed, errors } = await forceCloseBatchPositions(
      apiKey,
      apiSecret,
      snapshot.legs,
    );

    if (snapshot.legCount > 0 && closed < snapshot.legCount) {
      return {
        ok: false,
        batchId,
        combinedMtm: snapshot.combinedMtm,
        targetProfitUsd: config.targetProfitUsd,
        error:
          errors.length > 0
            ? `Closed ${closed}/${snapshot.legCount}: ${errors.join("; ")}`
            : `Closed ${closed}/${snapshot.legCount} legs`,
      };
    }

    await prisma.futureHedgeExecution.createMany({
      data: snapshot.legs.map((leg) => ({
        batchId,
        configId: config.id,
        kind: "EXIT",
        leg: isBtcPerpSymbol(leg.symbol) ? "PERP" : "OPTION",
        side: leg.side === "BUY" ? "SELL" : "BUY",
        symbol: leg.symbol,
        lots: Math.max(1, Math.round(Math.abs(leg.contracts))),
        price: null,
        orderId: null,
      })),
    });

    await clearActiveBatch(prisma, config.id);

    lastLoggedMtm = null;

    console.log(
      `[future-hedge-engine] batch closed id=${batchId} closedLegs=${closed} — ready for next entry`,
    );

    return {
      ok: true,
      batchId,
      combinedMtm: snapshot.combinedMtm,
      targetProfitUsd: config.targetProfitUsd,
      closedLegs: closed,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[future-hedge-engine] target exit error: ${msg}`);
    return { ok: false, error: msg };
  } finally {
    closeInFlight = false;
  }
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
  prisma: PrismaClient,
): Promise<FutureHedgeEntryResult> {
  if (entryInFlight || adjustmentInFlight || closeInFlight) {
    return { ok: false, error: "Another hedge operation in progress" };
  }

  const now = Date.now();
  if (now - lastEntryAttemptAt < ENTRY_COOLDOWN_MS) {
    return { ok: false, error: "Entry cooldown active" };
  }

  entryInFlight = true;
  lastEntryAttemptAt = now;

  try {
    const strategy = await prisma.strategy.findFirst({
      where: { title: FUTURE_HEDGE_STRATEGY_TITLE },
      include: { futureHedgeConfig: true },
    });

    const config = strategy?.futureHedgeConfig;
    if (!strategy || !config) {
      return { ok: false, error: "Future Hedge strategy or config not found" };
    }
    if (!config.isAutoEnabled) {
      return { ok: false, error: "Automation disabled" };
    }
    if (!strategy.isActive) {
      return { ok: false, error: "Strategy paused (isActive=false)" };
    }
    const openGate = await assertMasterHedgeOpensAllowed(prisma, strategy);
    if (!openGate.ok) {
      logMasterOpenBlocked(openGate.reason);
      return { ok: false, error: openGate.reason };
    }
    if (config.currentBatchId) {
      return { ok: false, error: "Batch already active" };
    }

    const apiKey = strategy.masterApiKey?.trim() ?? "";
    const apiSecret = strategy.masterApiSecret?.trim() ?? "";
    if (!apiKey || !apiSecret) {
      return {
        ok: false,
        error: "Master Delta API key and secret must be set on the strategy",
      };
    }

    const openOnExchange = await fetchDeltaOpenPositions(apiKey, apiSecret, {
      skipCache: true,
    });
    const hasOpenLegs = openOnExchange.some(
      (p) => Math.abs(p.contracts) >= 1e-12,
    );
    if (hasOpenLegs) {
      return {
        ok: false,
        error: "Master still has open positions — skip fresh entry",
      };
    }

    const spot = getLiveFuturePrice();
    if (spot == null || spot <= 0) {
      return { ok: false, error: "Live BTC price unavailable" };
    }

    const entryTrend = getCurrentTrend();
    const lots = config.baseLots;
    if (!Number.isInteger(lots) || lots < 1) {
      return { ok: false, error: "Invalid baseLots on config" };
    }

    const optionType = entryTrend === "UPTREND" ? "call" : "put";
    const atm = await findAtmBtcOptionProductId(optionType, spot);
    if (!atm) {
      return {
        ok: false,
        error: `No ATM BTC ${optionType} option found for nearest expiry`,
      };
    }

    const perpSide: TradeSide = entryTrend === "UPTREND" ? "BUY" : "SELL";
    const batchTrend = trendToBatchEnum(entryTrend);

    console.log(
      `[future-hedge-engine] entry trend=${entryTrend} perp=${perpSide} ${lots} lots ` +
        `option=SELL ${atm.productId}`,
    );

    const exec = await executePerpAndOption(
      prisma,
      apiKey,
      apiSecret,
      perpSide,
      atm.productId,
      lots,
    );
    if (!exec.ok) {
      return {
        ok: false,
        trend: entryTrend,
        error: exec.error ?? "Order placement failed",
      };
    }

    const entryPrice = exec.perpFill ?? spot;
    const batchId = generateBatchId();

    await prisma.$transaction([
      prisma.futureHedgeConfig.update({
        where: { id: config.id },
        data: {
          currentBatchId: batchId,
          lastEntryPrice: entryPrice,
          batchTrend,
          batchOptionProductId: atm.productId,
          batchOptionExpiryMs: BigInt(atm.expiryMs),
        },
      }),
      prisma.futureHedgeExecution.createMany({
        data: [
          {
            batchId,
            configId: config.id,
            kind: "ENTRY",
            leg: "PERP",
            side: perpSide,
            symbol: FUTURE_HEDGE_BTC_SYMBOL,
            lots,
            price: entryPrice,
            orderId: exec.perpOrderId ?? null,
          },
          {
            batchId,
            configId: config.id,
            kind: "ENTRY",
            leg: "OPTION",
            side: "SELL",
            symbol: atm.productId,
            lots,
            price: exec.perpFill,
            orderId: exec.optOrderId ?? null,
          },
        ],
      }),
    ]);

    console.log(
      `[future-hedge-engine] batch opened id=${batchId} anchor=${entryPrice} trend=${entryTrend}`,
    );

    const success: FutureHedgeEntryResult = {
      ok: true,
      batchId,
      trend: entryTrend,
      lastEntryPrice: entryPrice,
      optionProductId: atm.productId,
    };
    if (exec.perpOrderId) success.perpOrderId = exec.perpOrderId;
    if (exec.optOrderId) success.optionOrderId = exec.optOrderId;
    return success;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[future-hedge-engine] entry error: ${msg}`);
    return { ok: false, error: msg };
  } finally {
    entryInFlight = false;
  }
}

/**
 * Grid adjustment for an active batch when price moves by adjustmentPct from anchor.
 */
export async function tryExecuteAdjustment(
  prisma: PrismaClient,
): Promise<FutureHedgeAdjustmentResult> {
  if (entryInFlight || adjustmentInFlight || closeInFlight) {
    return { ok: false, error: "Another hedge operation in progress" };
  }

  adjustmentInFlight = true;

  try {
    const strategy = await prisma.strategy.findFirst({
      where: { title: FUTURE_HEDGE_STRATEGY_TITLE },
      include: { futureHedgeConfig: true },
    });

    const config = strategy?.futureHedgeConfig;
    if (!strategy || !config) {
      return { ok: false, error: "Config not found" };
    }
    if (!config.isAutoEnabled || !config.currentBatchId) {
      return { ok: false, error: "No active batch" };
    }
    if (!strategy.isActive) {
      return { ok: false, error: "Strategy paused (isActive=false)" };
    }
    const openGate = await assertMasterHedgeOpensAllowed(prisma, strategy);
    if (!openGate.ok) {
      logMasterOpenBlocked(openGate.reason);
      return { ok: false, error: openGate.reason };
    }
    if (config.batchTrend == null) {
      return { ok: false, error: "Batch trend not set" };
    }

    const anchor = config.lastEntryPrice;
    if (anchor == null || !Number.isFinite(anchor) || anchor <= 0) {
      return { ok: false, error: "lastEntryPrice anchor missing" };
    }

    const live = getLiveFuturePrice();
    if (live == null || live <= 0) {
      return { ok: false, error: "Live BTC price unavailable" };
    }

    if (
      !shouldTriggerAdjustment(
        config.batchTrend,
        anchor,
        live,
        config.adjustmentPct,
      )
    ) {
      return { ok: false, error: "Adjustment threshold not met" };
    }

    const apiKey = strategy.masterApiKey?.trim() ?? "";
    const apiSecret = strategy.masterApiSecret?.trim() ?? "";
    if (!apiKey || !apiSecret) {
      return { ok: false, error: "Master API keys not configured" };
    }

    const lots = config.baseLots;
    const atm = await resolveOptionForBatch(config.batchTrend, live, config);
    if (!atm) {
      return { ok: false, error: "ATM option not found for batch expiry" };
    }

    const perpSide: TradeSide =
      config.batchTrend === FutureHedgeBatchTrend.UPTREND ? "BUY" : "SELL";

    console.log(
      `[future-hedge-engine] adjustment batch=${config.currentBatchId} ` +
        `trend=${config.batchTrend} anchor=${anchor} live=${live} pct=${config.adjustmentPct} ` +
        `perp=${perpSide} option=${atm.productId}`,
    );

    const exec = await executePerpAndOption(
      prisma,
      apiKey,
      apiSecret,
      perpSide,
      atm.productId,
      lots,
    );
    if (!exec.ok) {
      return { ok: false, error: exec.error ?? "Adjustment orders failed" };
    }

    const newAnchor = exec.perpFill ?? live;
    const batchId = config.currentBatchId;

    await prisma.$transaction([
      prisma.futureHedgeConfig.update({
        where: { id: config.id },
        data: {
          lastEntryPrice: newAnchor,
          batchOptionProductId: atm.productId,
        },
      }),
      prisma.futureHedgeExecution.createMany({
        data: [
          {
            batchId,
            configId: config.id,
            kind: "ADJUSTMENT",
            leg: "PERP",
            side: perpSide,
            symbol: FUTURE_HEDGE_BTC_SYMBOL,
            lots,
            price: newAnchor,
            orderId: exec.perpOrderId ?? null,
          },
          {
            batchId,
            configId: config.id,
            kind: "ADJUSTMENT",
            leg: "OPTION",
            side: "SELL",
            symbol: atm.productId,
            lots,
            price: exec.perpFill,
            orderId: exec.optOrderId ?? null,
          },
        ],
      }),
    ]);

    console.log(
      `[future-hedge-engine] adjustment done batch=${batchId} newAnchor=${newAnchor}`,
    );

    return {
      ok: true,
      batchId,
      newAnchorPrice: newAnchor,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[future-hedge-engine] adjustment error: ${msg}`);
    return { ok: false, error: msg };
  } finally {
    adjustmentInFlight = false;
  }
}

async function mtmTick(prisma: PrismaClient): Promise<void> {
  if (destroyed || entryInFlight || adjustmentInFlight || closeInFlight) return;

  try {
    await enforceNoSubscriberMasterSafety(prisma);

    const subs = await findActiveFutureHedgeCopySubscribers(prisma);
    if (subs.length === 0) {
      return;
    }

    const strategy = await prisma.strategy.findFirst({
      where: { title: FUTURE_HEDGE_STRATEGY_TITLE },
      include: { futureHedgeConfig: true },
    });

    const config = strategy?.futureHedgeConfig;
    if (!config?.isAutoEnabled || !config.currentBatchId) return;

    const apiKey = strategy?.masterApiKey?.trim() ?? "";
    const apiSecret = strategy?.masterApiSecret?.trim() ?? "";
    if (!apiKey || !apiSecret) return;

    const snapshot = await computeCombinedBatchMtm(
      prisma,
      apiKey,
      apiSecret,
      config,
    );
    if (!snapshot) return;

    const shouldLog =
      lastLoggedMtm === null ||
      Math.abs(snapshot.combinedMtm - lastLoggedMtm) >= 0.5;
    if (shouldLog) {
      lastLoggedMtm = snapshot.combinedMtm;
      console.log(
        `[future-hedge-engine] MTM batch=${snapshot.batchId} combined=$${snapshot.combinedMtm.toFixed(2)} ` +
          `target=$${snapshot.targetProfitUsd} legs=${snapshot.legCount}`,
      );
    }

    if (snapshot.combinedMtm >= config.targetProfitUsd) {
      const result = await tryExecuteTargetExit(prisma);
      if (!result.ok && result.error && result.error !== "Target profit not reached") {
        console.warn(`[future-hedge-engine] target exit: ${result.error}`);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[future-hedge-engine] MTM tick error: ${msg}`);
  }
}

async function engineTick(prisma: PrismaClient): Promise<void> {
  if (destroyed || entryInFlight || adjustmentInFlight || closeInFlight) return;

  try {
    await enforceNoSubscriberMasterSafety(prisma);

    const subs = await findActiveFutureHedgeCopySubscribers(prisma);
    if (subs.length === 0) {
      return;
    }

    const config = await prisma.futureHedgeConfig.findFirst({
      where: {
        strategy: { title: FUTURE_HEDGE_STRATEGY_TITLE },
        isAutoEnabled: true,
      },
    });
    if (!config) return;

    if (config.currentBatchId) {
      const strategy = await prisma.strategy.findFirst({
        where: { title: FUTURE_HEDGE_STRATEGY_TITLE },
        select: { masterApiKey: true, masterApiSecret: true },
      });
      const apiKey = strategy?.masterApiKey?.trim() ?? "";
      const apiSecret = strategy?.masterApiSecret?.trim() ?? "";
      if (apiKey && apiSecret) {
        const snapshot = await computeCombinedBatchMtm(
          prisma,
          apiKey,
          apiSecret,
          config,
        );
        if (snapshot && snapshot.legCount === 0) {
          await clearActiveBatch(prisma, config.id);
          lastEntryAttemptAt = Date.now();
          lastLoggedMtm = null;
          console.log(
            `[future-hedge-engine] batch ${config.currentBatchId} cleared — exchange flat (no batch legs)`,
          );
          return;
        }
      }

      const result = await tryExecuteAdjustment(prisma);
      if (
        !result.ok &&
        result.error &&
        result.error !== "Adjustment threshold not met" &&
        result.error !== "Another hedge operation in progress"
      ) {
        console.warn(`[future-hedge-engine] adjustment: ${result.error}`);
      }
      return;
    }

    const now = Date.now();
    if (now - lastEntryAttemptAt < ENTRY_COOLDOWN_MS) return;

    const result = await tryExecuteFreshEntry(prisma);
    if (
      !result.ok &&
      result.error &&
      !result.error.includes("cooldown") &&
      result.error !== "Another hedge operation in progress"
    ) {
      console.warn(`[future-hedge-engine] entry: ${result.error}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[future-hedge-engine] tick error: ${msg}`);
  }
}

/**
 * Full automation: entry, adjustment grid, and 1s MTM target-profit exits.
 */
export function startFutureHedgeEngine(prisma: PrismaClient): () => void {
  if (!destroyed) {
    console.warn("[future-hedge-engine] already running");
    return () => undefined;
  }

  destroyed = false;
  console.log(
    `[future-hedge-engine] started entry/adjust every ${ENGINE_TICK_MS}ms, MTM every ${MTM_TICK_MS}ms`,
  );

  void engineTick(prisma);
  void mtmTick(prisma);

  tickTimer = setInterval(() => {
    void engineTick(prisma);
  }, ENGINE_TICK_MS);

  mtmTimer = setInterval(() => {
    void mtmTick(prisma);
  }, MTM_TICK_MS);

  return () => {
    destroyed = true;
    if (tickTimer != null) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
    if (mtmTimer != null) {
      clearInterval(mtmTimer);
      mtmTimer = null;
    }
    lastLoggedMtm = null;
    console.log("[future-hedge-engine] stopped");
  };
}
