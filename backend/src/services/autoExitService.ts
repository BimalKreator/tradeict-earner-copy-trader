import type { PrismaClient } from "@prisma/client";
import {
  EXIT_REASON,
  markBotInitiatedClose,
  setPendingStrategyExitReason,
} from "../constants/exitReasons.js";
import {
  executeTrade,
  fetchDeltaOpenPositions,
  type TradeSide,
} from "./exchangeService.js";
import type { DeltaLivePosition } from "./exchangeService.js";
import {
  deltaContractSizeFallback,
  estimateLivePnlUsd,
  resolveLiveMarkPrice,
} from "./liveMarkPriceCache.js";
import { registerSymbolsForLivePrices } from "./livePriceTracker.js";

const AUTO_EXIT_COOLDOWN_MS = 60_000;
/** Consecutive 1s poll ticks the threshold must stay breached before closing. */
const SUSTAINED_BREACH_TICKS = 3;
/** Ignore auto-exit right after new legs appear (basket / partial fills settling). */
const POSITION_SETTLE_GRACE_MS = 5_000;

/** strategyId → timestamp when auto-exit last fired (prevents duplicate close bursts). */
const lastAutoExitAt = new Map<string, number>();

/** strategyId → consecutive poll ticks where PnL stayed past target/stop. */
const breachCounters = new Map<string, number>();

/** strategyId → do not evaluate auto-exit until this timestamp (ms). */
const positionSettleUntil = new Map<string, number>();

/** strategyId → open leg count on previous tick (detect new basket legs). */
const lastLegCountByStrategy = new Map<string, number>();

function resolveMarkForPosition(pos: DeltaLivePosition): number | null {
  const cached = resolveLiveMarkPrice(pos.symbolKey);
  if (cached != null) return cached;
  if (
    pos.markPrice != null &&
    Number.isFinite(pos.markPrice) &&
    pos.markPrice > 0
  ) {
    return pos.markPrice;
  }
  return null;
}

function legPnlUsd(pos: DeltaLivePosition, mark: number | null): number {
  if (mark == null) {
    const u = pos.unrealizedPnl;
    return u != null && Number.isFinite(u) ? u : 0;
  }
  const entry =
    pos.entryPrice != null && Number.isFinite(pos.entryPrice)
      ? pos.entryPrice
      : mark;
  const cs =
    pos.realBaseSize > 0 && pos.contracts > 0
      ? pos.realBaseSize / Math.abs(pos.contracts)
      : deltaContractSizeFallback(pos.symbolKey);
  return estimateLivePnlUsd({
    symbolKey: pos.symbolKey,
    side: pos.side,
    entryPrice: entry,
    contracts: Math.abs(pos.contracts),
    markPrice: mark,
    contractSize: cs,
  });
}

export type MasterLegCloseTarget = {
  symbolKey: string;
  side: TradeSide;
  contracts: number;
};

export async function fetchMasterLegsWithTotalLivePnl(
  apiKeyStored: string,
  apiSecretStored: string,
): Promise<{ totalPnlUsd: number; legs: MasterLegCloseTarget[] }> {
  const positions = await fetchDeltaOpenPositions(apiKeyStored, apiSecretStored);
  registerSymbolsForLivePrices(positions.map((p) => p.symbolKey));

  const legs: MasterLegCloseTarget[] = [];
  let totalPnlUsd = 0;

  for (const pos of positions) {
    const contracts = Math.abs(pos.contracts);
    if (!Number.isFinite(contracts) || contracts < 1e-12) continue;

    const mark = resolveMarkForPosition(pos);
    totalPnlUsd += legPnlUsd(pos, mark);

    legs.push({
      symbolKey: pos.symbolKey,
      side: pos.side,
      contracts,
    });
  }

  return { totalPnlUsd, legs };
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

export async function closeAllMasterPositionsMarket(
  apiKeyStored: string,
  apiSecretStored: string,
  legs: MasterLegCloseTarget[],
): Promise<{ closed: number; errors: string[] }> {
  const errors: string[] = [];
  let closed = 0;

  for (const leg of legs) {
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
      closed += 1;
    } else {
      errors.push(`${leg.symbolKey} ${leg.side}: ${result.error ?? "unknown"}`);
    }
  }

  return { closed, errors };
}

/**
 * Poll-driven auto-exit: compare total master unrealized PnL to strategy thresholds
 * and market-close every open master leg when breached.
 */
export async function runStrategyAutoExitCheck(
  prisma: PrismaClient,
  strategy: {
    id: string;
    title: string;
    masterApiKey: string;
    masterApiSecret: string;
    autoExitTarget: number | null;
    autoExitStopLoss: number | null;
  },
): Promise<void> {
  if (
    strategy.autoExitTarget == null &&
    strategy.autoExitStopLoss == null
  ) {
    return;
  }

  const key = strategy.masterApiKey?.trim() ?? "";
  const secret = strategy.masterApiSecret?.trim() ?? "";
  if (!key || !secret) return;

  const last = lastAutoExitAt.get(strategy.id) ?? 0;
  if (Date.now() - last < AUTO_EXIT_COOLDOWN_MS) return;

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
    breachCounters.set(strategyId, 0);
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

  console.warn(
    `[auto-exit] Threshold breached for strategy ${strategyId}. Verifying... (${count}/${SUSTAINED_BREACH_TICKS} seconds) ` +
      `reason=${breach.reason} totalPnl=${breach.totalPnlUsd.toFixed(2)} threshold=${breach.thresholdUsd}`,
  );

  if (count < SUSTAINED_BREACH_TICKS) {
    return;
  }

  breachCounters.set(strategyId, 0);

  const exitReason =
    breach.reason === "target"
      ? EXIT_REASON.AUTO_EXIT_TARGET
      : EXIT_REASON.AUTO_EXIT_STOP_LOSS;

  for (const leg of legs) {
    markBotInitiatedClose(strategyId, leg.symbolKey, exitReason);
  }
  setPendingStrategyExitReason(strategyId, exitReason);

  console.warn(
    `[auto-exit] SUSTAINED THRESHOLD CONFIRMED strategy="${strategy.title}" (${strategyId}) ` +
      `reason=${breach.reason} totalPnl=${breach.totalPnlUsd.toFixed(2)} ` +
      `threshold=${breach.thresholdUsd} openLegs=${legs.length} — closing ALL master positions`,
  );

  lastAutoExitAt.set(strategyId, Date.now());

  const { closed, errors } = await closeAllMasterPositionsMarket(
    strategy.masterApiKey,
    strategy.masterApiSecret,
    legs,
  );

  if (errors.length > 0) {
    console.error(
      `[auto-exit] partial close strategyId=${strategy.id} closed=${closed}/${legs.length} errors=${errors.join("; ")}`,
    );
  } else {
    console.log(
      `[auto-exit] master flat complete strategyId=${strategy.id} closed=${closed} leg(s); WS will fan out to followers`,
    );
  }
}

export async function runAllStrategyAutoExitChecks(
  prisma: PrismaClient,
): Promise<void> {
  const strategies = await prisma.strategy.findMany({
    where: {
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
      autoExitTarget: true,
      autoExitStopLoss: true,
    },
  });

  for (const strat of strategies) {
    await runStrategyAutoExitCheck(prisma, strat);
  }
}
