import type { PrismaClient } from "@prisma/client";
import { clearFutureHedgeActiveBatch } from "./futureHedgeEngine.js";
import {
  EXIT_REASON,
  markBotInitiatedClose,
  setPendingStrategyExitReason,
} from "../constants/exitReasons.js";
import {
  FUTURE_HEDGE_BTC_SYMBOL,
  getLiveFuturePrice,
} from "./futureHedgeDataService.js";
import {
  executeTrade,
  fetchDeltaOpenPositions,
  fetchDeltaTicker,
  hydratePositionForLivePnl,
  seedTerminalQuotesForSymbols,
  type TradeSide,
} from "./exchangeService.js";
import type { DeltaLivePosition } from "./exchangeService.js";
import { registerSymbolsForLivePrices } from "./livePriceTracker.js";
import { onLiveBidAskTick } from "./liveMarkPriceCache.js";
import {
  latchBreakevenHedgeEntryBlock,
  markLegClosing,
  markMasterFlatting,
  markPostExitEntryBlock,
  POST_EXIT_ENTRY_BLOCK_MS,
  clearBreakevenHedgeEntryLatch,
} from "./subscriptionSyncService.js";

/** After a successful auto-exit close burst, ignore re-triggers briefly. */
const AUTO_EXIT_COOLDOWN_MS = 15_000;
/** Consecutive poll ticks above/below threshold before PnL auto-exit closes. */
const SUSTAINED_BREACH_TICKS = 3;
/** Breakeven exits fire on the first price tick past bounds (WS-driven). */
const BREAKEVEN_SUSTAINED_TICKS = 1;
/** In-memory breakeven strategy roster refresh interval. */
const BREAKEVEN_STRATEGY_CACHE_MS = 10_000;
/** Cached master legs TTL — avoids REST on every WS tick. */
const MASTER_LEGS_CACHE_TTL_MS = 4_000;
/** Pause after new master legs — margined UPNL can lag realtime overlay ~10s. */
const POSITION_SETTLE_GRACE_MS = 12_000;

/** strategyId → timestamp when auto-exit last fired (prevents duplicate close bursts). */
const lastAutoExitAt = new Map<string, number>();

/** strategyId → consecutive poll ticks where PnL stayed past target/stop. */
const breachCounters = new Map<string, number>();

/** strategyId → do not evaluate auto-exit until this timestamp (ms). */
const positionSettleUntil = new Map<string, number>();

/** strategyId → open leg count on previous tick (detect new basket legs). */
const lastLegCountByStrategy = new Map<string, number>();

/** strategyId → consecutive poll ticks where BTC price breached breakeven bounds. */
const breakevenBreachCounters = new Map<string, number>();

/** strategyId → last observed BTC price for single-level cross detection. */
const lastBtcPriceByStrategy = new Map<string, number>();

/** USD tolerance when a single breakeven level is configured. */
const BREAKEVEN_TOUCH_EPSILON_USD = 1.0;

type BreakevenWatchStrategy = {
  id: string;
  title: string;
  masterApiKey: string;
  masterApiSecret: string;
  futureHedgeConfig: {
    isBreakevenExitEnabled: boolean;
    breakevenPrice1: number | null;
    breakevenPrice2: number | null;
  } | null;
};

let breakevenWatchPrisma: PrismaClient | null = null;
let breakevenStrategyCache: BreakevenWatchStrategy[] = [];
let breakevenCacheTimer: ReturnType<typeof setInterval> | null = null;
const masterLegsCache = new Map<
  string,
  { legs: MasterLegCloseTarget[]; totalPnlUsd: number; fetchedAt: number }
>();
const breakevenExitInFlight = new Set<string>();
let lastBtcTickPrice = 0;
let lastBtcTickAt = 0;
/** strategyId → open leg symbol keys (for WS bid/ask targeted auto-exit). */
const legSymbolsByStrategy = new Map<string, Set<string>>();
/** strategyId → last bid/ask tick ms (debounce duplicate L2 updates). */
const lastBidAskTickByStrategy = new Map<string, number>();
let stopBidAskTickListener: (() => void) | null = null;

const AUTO_EXIT_BID_ASK_DEBOUNCE_MS = 40;

/** Boot WS-driven breakeven watcher (call once from trade engine). */
export function initBreakevenExitWatcher(prisma: PrismaClient): () => void {
  breakevenWatchPrisma = prisma;
  void refreshBreakevenStrategyCache(prisma);
  breakevenCacheTimer = setInterval(() => {
    void refreshBreakevenStrategyCache(prisma);
  }, BREAKEVEN_STRATEGY_CACHE_MS);

  stopBidAskTickListener = onLiveBidAskTick((symbolKey, update) => {
    void notifyLiveBidAskTickForAutoExit(prisma, symbolKey, update);
  });

  return () => {
    breakevenWatchPrisma = null;
    if (breakevenCacheTimer != null) {
      clearInterval(breakevenCacheTimer);
      breakevenCacheTimer = null;
    }
    if (stopBidAskTickListener != null) {
      stopBidAskTickListener();
      stopBidAskTickListener = null;
    }
    breakevenStrategyCache = [];
    masterLegsCache.clear();
    breakevenExitInFlight.clear();
    legSymbolsByStrategy.clear();
    lastBidAskTickByStrategy.clear();
  };
}

async function loadBreakevenStrategies(
  prisma: PrismaClient,
): Promise<BreakevenWatchStrategy[]> {
  return prisma.strategy.findMany({
    where: {
      isActive: true,
      futureHedgeConfig: {
        is: {
          isBreakevenExitEnabled: true,
          OR: [
            { breakevenPrice1: { not: null } },
            { breakevenPrice2: { not: null } },
          ],
        },
      },
    },
    select: {
      id: true,
      title: true,
      masterApiKey: true,
      masterApiSecret: true,
      futureHedgeConfig: {
        select: {
          isBreakevenExitEnabled: true,
          breakevenPrice1: true,
          breakevenPrice2: true,
        },
      },
    },
  });
}

async function refreshBreakevenStrategyCache(prisma: PrismaClient): Promise<void> {
  try {
    breakevenStrategyCache = await loadBreakevenStrategies(prisma);
    for (const strat of breakevenStrategyCache) {
      void prefetchMasterLegsCache(
        strat.id,
        strat.masterApiKey,
        strat.masterApiSecret,
      );
    }
  } catch (err) {
    console.warn(
      "[breakeven-exit] strategy cache refresh failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

async function prefetchMasterLegsCache(
  strategyId: string,
  masterApiKey: string,
  masterApiSecret: string,
): Promise<void> {
  try {
    const snap = await fetchMasterLegsWithTotalLivePnl(
      masterApiKey,
      masterApiSecret,
    );
    masterLegsCache.set(strategyId, {
      legs: snap.legs,
      totalPnlUsd: snap.totalPnlUsd,
      fetchedAt: Date.now(),
    });
    rememberLegSymbolsForStrategy(strategyId, snap.legs);
  } catch {
    /* optional prefetch */
  }
}

async function resolveCachedMasterLegs(
  strategyId: string,
  masterApiKey: string,
  masterApiSecret: string,
): Promise<{ legs: MasterLegCloseTarget[]; totalPnlUsd: number }> {
  const cached = masterLegsCache.get(strategyId);
  if (cached && Date.now() - cached.fetchedAt < MASTER_LEGS_CACHE_TTL_MS) {
    return { legs: cached.legs, totalPnlUsd: cached.totalPnlUsd };
  }
  const snap = await fetchMasterLegsWithTotalLivePnl(
    masterApiKey,
    masterApiSecret,
  );
  masterLegsCache.set(strategyId, {
    legs: snap.legs,
    totalPnlUsd: snap.totalPnlUsd,
    fetchedAt: Date.now(),
  });
  return snap;
}

/** Instant breakeven evaluation on Delta WS BTC tick (no poll delay). */
export function notifyLiveBtcPriceTick(livePrice: number): void {
  if (
    !breakevenWatchPrisma ||
    !Number.isFinite(livePrice) ||
    livePrice <= 0
  ) {
    return;
  }
  const now = Date.now();
  if (livePrice === lastBtcTickPrice && now - lastBtcTickAt < 50) {
    return;
  }
  lastBtcTickPrice = livePrice;
  lastBtcTickAt = now;

  const prisma = breakevenWatchPrisma;
  for (const strat of breakevenStrategyCache) {
    void runBreakevenExitCheckOnPrice(prisma, strat, livePrice, "ws");
  }
}

/** Instant auto-exit re-check when L2 best bid/ask updates for a watched symbol. */
async function notifyLiveBidAskTickForAutoExit(
  prisma: PrismaClient,
  symbolKey: string,
  update: { bid?: number; ask?: number },
): Promise<void> {
  if (!update.bid && !update.ask) return;

  const sym = symbolKey.trim();
  if (!sym) return;

  const symUpper = sym.toUpperCase();
  const now = Date.now();

  const strategies = await prisma.strategy.findMany({
    where: {
      isActive: true,
      autoExitEnabled: true,
      OR: [
        { autoExitTarget: { not: null } },
        { autoExitStopLoss: { not: null } },
      ],
    },
    select: {
      id: true,
      title: true,
      masterApiKey: true,
      masterApiSecret: true,
      autoExitEnabled: true,
      autoExitTarget: true,
      autoExitStopLoss: true,
    },
  });

  for (const strat of strategies) {
    const watched = legSymbolsByStrategy.get(strat.id);
    if (!watched) continue;

    const matches = [...watched].some((s) => {
      const u = s.toUpperCase();
      return u === symUpper || u.endsWith(symUpper) || symUpper.endsWith(u);
    });
    if (!matches) continue;

    const lastTick = lastBidAskTickByStrategy.get(strat.id) ?? 0;
    if (now - lastTick < AUTO_EXIT_BID_ASK_DEBOUNCE_MS) continue;
    lastBidAskTickByStrategy.set(strat.id, now);

    masterLegsCache.delete(strat.id);
    void runStrategyAutoExitCheck(prisma, strat);
  }
}

/** Terminal UPNL — atomic quote sync; null when bid/ask missing for options. */
async function legPnlUsd(pos: DeltaLivePosition): Promise<number | null> {
  const { livePnl } = await hydratePositionForLivePnl(pos);
  return livePnl;
}

export type MasterLegCloseTarget = {
  symbolKey: string;
  side: TradeSide;
  contracts: number;
  entryPrice: number;
};

export async function fetchMasterLegsWithTotalLivePnl(
  apiKeyStored: string,
  apiSecretStored: string,
): Promise<{ totalPnlUsd: number; legs: MasterLegCloseTarget[] }> {
  const positions = await fetchDeltaOpenPositions(apiKeyStored, apiSecretStored, {
    skipCache: true,
  });
  registerSymbolsForLivePrices(positions.map((p) => p.symbolKey));
  await seedTerminalQuotesForSymbols(positions.map((p) => p.symbolKey));

  const legs: MasterLegCloseTarget[] = [];
  let totalPnlUsd = 0;

  for (const pos of positions) {
    const contracts = Math.abs(pos.contracts);
    if (!Number.isFinite(contracts) || contracts < 1e-12) continue;

    const legUpnl = await legPnlUsd(pos);
    if (legUpnl != null) {
      totalPnlUsd += legUpnl;
    }

    const entryPrice =
      pos.entryPrice != null && Number.isFinite(pos.entryPrice)
        ? pos.entryPrice
        : pos.markPrice != null && Number.isFinite(pos.markPrice)
          ? pos.markPrice
          : 0;

    legs.push({
      symbolKey: pos.symbolKey,
      side: pos.side,
      contracts,
      entryPrice,
    });
  }

  return { totalPnlUsd, legs };
}

function rememberLegSymbolsForStrategy(
  strategyId: string,
  legs: MasterLegCloseTarget[],
): void {
  legSymbolsByStrategy.set(
    strategyId,
    new Set(legs.map((l) => l.symbolKey.trim()).filter(Boolean)),
  );
}

export type AutoExitBreached = {
  reason: "target" | "stop_loss";
  totalPnlUsd: number;
  thresholdUsd: number;
};

export function evaluateAutoExitThresholds(args: {
  totalPnlUsd: number;
  autoExitTarget: number | null;
  autoExitStopLoss: number | null;
}): AutoExitBreached | null {
  const { totalPnlUsd, autoExitTarget, autoExitStopLoss } = args;
  if (
    autoExitTarget != null &&
    Number.isFinite(autoExitTarget) &&
    totalPnlUsd >= autoExitTarget
  ) {
    return { reason: "target", totalPnlUsd, thresholdUsd: autoExitTarget };
  }
  if (
    autoExitStopLoss != null &&
    Number.isFinite(autoExitStopLoss) &&
    autoExitStopLoss > 0 &&
    totalPnlUsd <= -Math.abs(autoExitStopLoss)
  ) {
    return {
      reason: "stop_loss",
      totalPnlUsd,
      thresholdUsd: autoExitStopLoss,
    };
  }
  return null;
}

export async function resolveLiveBtcUsdPrice(): Promise<number | null> {
  const cached = getLiveFuturePrice();
  if (cached != null && Number.isFinite(cached) && cached > 0) {
    return cached;
  }
  try {
    const tick = await fetchDeltaTicker(FUTURE_HEDGE_BTC_SYMBOL);
    const last = tick.last;
    if (last != null && Number.isFinite(last) && last > 0) {
      return last;
    }
  } catch {
    /* fall through */
  }
  return null;
}

export function evaluateBreakevenPriceBreach(args: {
  livePrice: number;
  prevPrice?: number | null;
  breakevenPrice1: number | null;
  breakevenPrice2: number | null;
}): boolean {
  const levels = [args.breakevenPrice1, args.breakevenPrice2].filter(
    (p): p is number => p != null && Number.isFinite(p) && p > 0,
  );
  if (levels.length === 0) return false;

  if (levels.length >= 2) {
    const low = Math.min(levels[0]!, levels[1]!);
    const high = Math.max(levels[0]!, levels[1]!);
    return args.livePrice <= low || args.livePrice >= high;
  }

  const level = levels[0]!;
  if (Math.abs(args.livePrice - level) <= BREAKEVEN_TOUCH_EPSILON_USD) {
    return true;
  }
  const prev = args.prevPrice;
  if (prev != null && Number.isFinite(prev)) {
    return (
      (prev < level && args.livePrice >= level) ||
      (prev > level && args.livePrice <= level)
    );
  }
  return false;
}

async function executeMasterFlatAutoExit(args: {
  prisma: PrismaClient;
  strategyId: string;
  strategyTitle: string;
  masterApiKey: string;
  masterApiSecret: string;
  legs: MasterLegCloseTarget[];
  exitReason: (typeof EXIT_REASON)[keyof typeof EXIT_REASON];
  logTag: string;
  logDetail: string;
}): Promise<void> {
  const {
    prisma,
    strategyId,
    strategyTitle,
    masterApiKey,
    masterApiSecret,
    legs,
    exitReason,
    logTag,
    logDetail,
  } = args;

  markMasterFlatting(strategyId, POST_EXIT_ENTRY_BLOCK_MS);
  markPostExitEntryBlock();
  if (exitReason === EXIT_REASON.AUTO_EXIT_BREAKEVEN) {
    latchBreakevenHedgeEntryBlock();
  }
  for (const leg of legs) {
    markLegClosing(strategyId, leg.symbolKey, leg.side);
    markBotInitiatedClose(strategyId, leg.symbolKey, exitReason);
  }
  setPendingStrategyExitReason(strategyId, exitReason);

  console.warn(
    `[${logTag}] THRESHOLD HIT strategy="${strategyTitle}" (${strategyId}) ` +
      `${logDetail} openLegs=${legs.length} — closing ALL master positions`,
  );

  const { closed, errors } = await closeAllMasterPositionsMarket(
    masterApiKey,
    masterApiSecret,
    legs,
  );

  if (closed > 0 || errors.length === 0) {
    lastAutoExitAt.set(strategyId, Date.now());
  }

  if (errors.length > 0) {
    console.error(
      `[${logTag}] partial close strategyId=${strategyId} closed=${closed}/${legs.length} errors=${errors.join("; ")}`,
    );
  } else {
    console.log(
      `[${logTag}] master flat complete strategyId=${strategyId} closed=${closed} leg(s)`,
    );
  }

  if (closed > 0) {
    try {
      await clearFutureHedgeActiveBatch(prisma, `${logTag}:flat`);
    } catch (batchErr) {
      console.warn(
        `[${logTag}] Future Hedge batch reset failed strategyId=${strategyId}:`,
        batchErr instanceof Error ? batchErr.message : batchErr,
      );
    }

    try {
      const { fanOutMasterFlatCloses } = await import("./tradeEngine.js");
      await fanOutMasterFlatCloses(prisma, strategyId, legs, exitReason);
    } catch (err) {
      console.error(
        `[${logTag}] follower fan-out failed strategyId=${strategyId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

export async function closeAllMasterPositionsMarket(
  apiKeyStored: string,
  apiSecretStored: string,
  legs: MasterLegCloseTarget[],
): Promise<{ closed: number; errors: string[] }> {
  const errors: string[] = [];
  let closed = 0;

  const outcomes = await Promise.allSettled(
    legs.map(async (leg) => {
      const closeSide: TradeSide = leg.side === "BUY" ? "SELL" : "BUY";
      const result = await executeTrade(
        apiKeyStored,
        apiSecretStored,
        leg.symbolKey,
        closeSide,
        leg.contracts,
        { reduceOnly: true },
      );
      if (result.success) {
        return { ok: true as const };
      }
      return {
        ok: false as const,
        error: `${leg.symbolKey} ${leg.side}: ${result.error ?? "unknown"}`,
      };
    }),
  );

  for (const outcome of outcomes) {
    if (outcome.status === "fulfilled") {
      if (outcome.value.ok) {
        closed += 1;
      } else {
        errors.push(outcome.value.error);
      }
    } else {
      errors.push(
        outcome.reason instanceof Error
          ? outcome.reason.message
          : String(outcome.reason),
      );
    }
  }

  return { closed, errors };
}

/**
 * Poll-driven auto-exit: compare total master unrealized PnL to strategy thresholds
 * and market-close every open master leg when breached.
 *
 * Hard gate: `Strategy.autoExitEnabled` must be true (also enforced in
 * {@link runAllStrategyAutoExitChecks} DB query). When disabled, no local PnL exits run.
 */
export async function runStrategyAutoExitCheck(
  prisma: PrismaClient,
  strategy: {
    id: string;
    title: string;
    masterApiKey: string;
    masterApiSecret: string;
    autoExitEnabled: boolean;
    autoExitTarget: number | null;
    autoExitStopLoss: number | null;
  },
): Promise<void> {
  if (!strategy.autoExitEnabled) {
    return;
  }

  if (
    strategy.autoExitTarget == null &&
    strategy.autoExitStopLoss == null
  ) {
    return;
  }

  const key = strategy.masterApiKey?.trim() ?? "";
  const secret = strategy.masterApiSecret?.trim() ?? "";
  if (!key || !secret) return;

  let totalPnlUsd: number;
  let legs: MasterLegCloseTarget[];
  try {
    const snap = await fetchMasterLegsWithTotalLivePnl(
      strategy.masterApiKey,
      strategy.masterApiSecret,
    );
    totalPnlUsd = snap.totalPnlUsd;
    legs = snap.legs;
  } catch (err) {
    console.warn(
      `[auto-exit] master snapshot failed strategyId=${strategy.id}:`,
      err instanceof Error ? err.message : err,
    );
    return;
  }

  rememberLegSymbolsForStrategy(strategy.id, legs);

  const strategyId = strategy.id;
  const prevLegCount = lastLegCountByStrategy.get(strategyId) ?? 0;

  if (legs.length === 0) {
    breachCounters.set(strategyId, 0);
    lastLegCountByStrategy.delete(strategyId);
    positionSettleUntil.delete(strategyId);
    return;
  }

  if (legs.length > prevLegCount) {
    positionSettleUntil.set(strategyId, Date.now() + POSITION_SETTLE_GRACE_MS);
    console.log(
      `[auto-exit] New/changed legs detected strategyId=${strategyId} ` +
        `(${prevLegCount} → ${legs.length}) — ${POSITION_SETTLE_GRACE_MS / 1000}s settle grace`,
    );
  }
  lastLegCountByStrategy.set(strategyId, legs.length);

  const settleUntil = positionSettleUntil.get(strategyId) ?? 0;
  if (Date.now() < settleUntil) {
    return;
  }

  const breach = evaluateAutoExitThresholds({
    totalPnlUsd,
    autoExitTarget: strategy.autoExitTarget,
    autoExitStopLoss: strategy.autoExitStopLoss,
  });

  if (!breach) {
    breachCounters.set(strategyId, 0);
    return;
  }

  const count = (breachCounters.get(strategyId) ?? 0) + 1;
  breachCounters.set(strategyId, count);

  try {
    const positions = await fetchDeltaOpenPositions(
      strategy.masterApiKey,
      strategy.masterApiSecret,
      { skipCache: true },
    );
    const legSummary = positions
      .filter((p) => Math.abs(p.contracts) >= 1e-12)
      .map(
        (p) =>
          `${p.symbolKey}:${p.unrealizedPnl != null ? `$${p.unrealizedPnl.toFixed(4)}` : "n/a"}`,
      )
      .join(", ");
    console.warn(
      `[auto-exit] leg PnL snapshot: ${legSummary || "none"} | total=$${totalPnlUsd.toFixed(2)}`,
    );
  } catch {
    /* diagnostic only */
  }

  console.warn(
    `[auto-exit] Threshold breached for strategy ${strategyId}. Verifying... (${count}/${SUSTAINED_BREACH_TICKS} ticks) ` +
      `reason=${breach.reason} totalPnl=${breach.totalPnlUsd.toFixed(2)} threshold=${breach.thresholdUsd}`,
  );

  if (count < SUSTAINED_BREACH_TICKS) {
    return;
  }

  const lastExit = lastAutoExitAt.get(strategyId) ?? 0;
  if (Date.now() - lastExit < AUTO_EXIT_COOLDOWN_MS) {
    return;
  }

  breachCounters.set(strategyId, 0);

  const exitReason =
    breach.reason === "target"
      ? EXIT_REASON.AUTO_EXIT_TARGET
      : EXIT_REASON.AUTO_EXIT_STOP_LOSS;

  await executeMasterFlatAutoExit({
    prisma,
    strategyId,
    strategyTitle: strategy.title,
    masterApiKey: strategy.masterApiKey,
    masterApiSecret: strategy.masterApiSecret,
    legs,
    exitReason,
    logTag: "auto-exit",
    logDetail:
      `reason=${breach.reason} totalPnl=${breach.totalPnlUsd.toFixed(2)} ` +
      `threshold=${breach.thresholdUsd}`,
  });
}

/**
 * Breakeven exit: compare live BTCUSD price to configured bounds
 * and market-close every open master leg when breached.
 */
async function runBreakevenExitCheckOnPrice(
  prisma: PrismaClient,
  strategy: BreakevenWatchStrategy,
  livePrice: number,
  source: "ws" | "poll",
): Promise<void> {
  const config = strategy.futureHedgeConfig;
  if (!config?.isBreakevenExitEnabled) return;

  const p1 = config.breakevenPrice1;
  const p2 = config.breakevenPrice2;
  const hasP1 = p1 != null && Number.isFinite(p1) && p1 > 0;
  const hasP2 = p2 != null && Number.isFinite(p2) && p2 > 0;
  if (!hasP1 && !hasP2) return;

  const key = strategy.masterApiKey?.trim() ?? "";
  const secret = strategy.masterApiSecret?.trim() ?? "";
  if (!key || !secret) return;

  const strategyId = strategy.id;
  if (breakevenExitInFlight.has(strategyId)) return;

  const prevPrice = lastBtcPriceByStrategy.get(strategyId) ?? null;
  lastBtcPriceByStrategy.set(strategyId, livePrice);

  let totalPnlUsd: number;
  let legs: MasterLegCloseTarget[];
  try {
    const snap = await resolveCachedMasterLegs(
      strategyId,
      strategy.masterApiKey,
      strategy.masterApiSecret,
    );
    totalPnlUsd = snap.totalPnlUsd;
    legs = snap.legs;
  } catch (err) {
    console.warn(
      `[breakeven-exit] master snapshot failed strategyId=${strategyId}:`,
      err instanceof Error ? err.message : err,
    );
    return;
  }

  if (legs.length === 0) {
    breakevenBreachCounters.set(strategyId, 0);
    const breachedAtZero = evaluateBreakevenPriceBreach({
      livePrice,
      prevPrice,
      breakevenPrice1: hasP1 ? p1 : null,
      breakevenPrice2: hasP2 ? p2 : null,
    });
    if (!breachedAtZero) {
      clearBreakevenHedgeEntryLatch();
    }
    return;
  }

  const prevLegCount = lastLegCountByStrategy.get(strategyId) ?? 0;
  if (legs.length > prevLegCount) {
    positionSettleUntil.set(strategyId, Date.now() + POSITION_SETTLE_GRACE_MS);
  }
  lastLegCountByStrategy.set(strategyId, legs.length);

  const settleUntil = positionSettleUntil.get(strategyId) ?? 0;
  if (Date.now() < settleUntil) {
    return;
  }

  const breached = evaluateBreakevenPriceBreach({
    livePrice,
    prevPrice,
    breakevenPrice1: hasP1 ? p1 : null,
    breakevenPrice2: hasP2 ? p2 : null,
  });

  if (!breached) {
    breakevenBreachCounters.set(strategyId, 0);
    clearBreakevenHedgeEntryLatch();
    return;
  }

  const count = (breakevenBreachCounters.get(strategyId) ?? 0) + 1;
  breakevenBreachCounters.set(strategyId, count);

  if (source === "poll") {
    console.warn(
      `[breakeven-exit] Price breach (poll backstop) strategy ${strategyId} ` +
        `(${count}/${BREAKEVEN_SUSTAINED_TICKS}) livePrice=${livePrice.toFixed(2)}`,
    );
  }

  if (count < BREAKEVEN_SUSTAINED_TICKS) {
    return;
  }

  const lastExit = lastAutoExitAt.get(strategyId) ?? 0;
  if (Date.now() - lastExit < AUTO_EXIT_COOLDOWN_MS) {
    return;
  }

  breakevenBreachCounters.set(strategyId, 0);
  breakevenExitInFlight.add(strategyId);

  try {
    console.warn(
      `[breakeven-exit] THRESHOLD HIT strategyId=${strategyId} source=${source} ` +
        `livePrice=${livePrice.toFixed(2)} p1=${hasP1 ? p1 : "—"} p2=${hasP2 ? p2 : "—"} ` +
        `totalPnl=$${totalPnlUsd.toFixed(2)} openLegs=${legs.length}`,
    );

    await executeMasterFlatAutoExit({
      prisma,
      strategyId,
      strategyTitle: strategy.title,
      masterApiKey: strategy.masterApiKey,
      masterApiSecret: strategy.masterApiSecret,
      legs,
      exitReason: EXIT_REASON.AUTO_EXIT_BREAKEVEN,
      logTag: "breakeven-exit",
      logDetail:
        `livePrice=${livePrice.toFixed(2)} breakeven1=${hasP1 ? p1 : "—"} ` +
        `breakeven2=${hasP2 ? p2 : "—"} source=${source}`,
    });
  } finally {
    breakevenExitInFlight.delete(strategyId);
  }
}

export async function runBreakevenExitCheck(
  prisma: PrismaClient,
  strategy: BreakevenWatchStrategy,
): Promise<void> {
  const livePrice = await resolveLiveBtcUsdPrice();
  if (livePrice == null) return;
  await runBreakevenExitCheckOnPrice(prisma, strategy, livePrice, "poll");
}

export async function runAllBreakevenExitChecks(
  prisma: PrismaClient,
): Promise<void> {
  const strategies =
    breakevenStrategyCache.length > 0
      ? breakevenStrategyCache
      : await loadBreakevenStrategies(prisma);

  await Promise.all(
    strategies.map((strat) => runBreakevenExitCheck(prisma, strat)),
  );
}

export async function runAllStrategyAutoExitChecks(
  prisma: PrismaClient,
): Promise<void> {
  const strategies = await prisma.strategy.findMany({
    where: {
      isActive: true,
      autoExitEnabled: true,
      OR: [
        { autoExitTarget: { not: null } },
        { autoExitStopLoss: { not: null } },
      ],
    },
    select: {
      id: true,
      title: true,
      masterApiKey: true,
      masterApiSecret: true,
      autoExitEnabled: true,
      autoExitTarget: true,
      autoExitStopLoss: true,
    },
  });

  for (const strat of strategies) {
    await runStrategyAutoExitCheck(prisma, strat);
  }
}
