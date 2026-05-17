import type { PrismaClient } from "@prisma/client";
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

/** strategyId → timestamp when auto-exit last fired (prevents duplicate close bursts). */
const lastAutoExitAt = new Map<string, number>();

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

  if (legs.length === 0) return;

  const breach = evaluateAutoExitThresholds({
    totalPnlUsd,
    autoExitTarget: strategy.autoExitTarget,
    autoExitStopLoss: strategy.autoExitStopLoss,
  });
  if (!breach) return;

  console.warn(
    `[auto-exit] THRESHOLD BREACHED strategy="${strategy.title}" (${strategy.id}) ` +
      `reason=${breach.reason} totalPnl=${breach.totalPnlUsd.toFixed(2)} ` +
      `threshold=${breach.thresholdUsd} openLegs=${legs.length} — closing ALL master positions`,
  );

  lastAutoExitAt.set(strategy.id, Date.now());

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
