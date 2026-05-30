import type { PrismaClient } from "@prisma/client";
import {
  FUTURE_HEDGE_STRATEGY_TITLE,
  isLegacyCryptoOptionsStrategyTitle,
  LEGACY_CRYPTO_OPTIONS_STRATEGY_TITLES,
} from "../constants/strategyTitles.js";
import { resolveFutureHedgeStrategy } from "./futureHedgeService.js";

export type StrategyRemovalSummary = {
  strategyId: string;
  title: string;
  tradePositions: number;
  trades: number;
  invoices: number;
  pnlRecords: number;
  subscriptions: number;
};

async function deleteStrategyGraph(
  prisma: PrismaClient,
  strategyId: string,
): Promise<Omit<StrategyRemovalSummary, "strategyId" | "title">> {
  const [tradePositions, trades, invoices, pnlRecords, subscriptions] =
    await prisma.$transaction([
      prisma.tradePosition.deleteMany({ where: { strategyId } }),
      prisma.trade.deleteMany({ where: { strategyId } }),
      prisma.invoice.deleteMany({ where: { strategyId } }),
      prisma.pnLRecord.deleteMany({ where: { strategyId } }),
      prisma.userStrategySubscription.deleteMany({ where: { strategyId } }),
    ]);

  await prisma.strategy.delete({ where: { id: strategyId } });

  return {
    tradePositions: tradePositions.count,
    trades: trades.count,
    invoices: invoices.count,
    pnlRecords: pnlRecords.count,
    subscriptions: subscriptions.count,
  };
}

/** Find every legacy Crypto Options strategy row (exact + fuzzy title match). */
export async function findLegacyCryptoOptionsStrategies(
  prisma: PrismaClient,
): Promise<Array<{ id: string; title: string }>> {
  const exact = await prisma.strategy.findMany({
    where: {
      title: { in: [...LEGACY_CRYPTO_OPTIONS_STRATEGY_TITLES] },
    },
    select: { id: true, title: true },
  });

  const fuzzy = await prisma.strategy.findMany({
    where: {
      title: {
        contains: "Crypto Options",
        mode: "insensitive",
      },
      NOT: { title: FUTURE_HEDGE_STRATEGY_TITLE },
    },
    select: { id: true, title: true },
  });

  const byId = new Map<string, { id: string; title: string }>();
  for (const row of [...exact, ...fuzzy]) {
    if (!isLegacyCryptoOptionsStrategyTitle(row.title)) continue;
    byId.set(row.id, row);
  }
  return Array.from(byId.values());
}

/**
 * Remove all legacy Crypto Options strategies and ensure Future Hedge exists.
 * Safe to run multiple times (idempotent when legacy rows are already gone).
 */
export async function removeLegacyCryptoOptionsStrategies(
  prisma: PrismaClient,
): Promise<{
  removed: StrategyRemovalSummary[];
  primaryStrategyId: string;
  primaryStrategyTitle: string;
}> {
  const legacy = await findLegacyCryptoOptionsStrategies(prisma);
  const removed: StrategyRemovalSummary[] = [];

  for (const strat of legacy) {
    const counts = await deleteStrategyGraph(prisma, strat.id);
    removed.push({
      strategyId: strat.id,
      title: strat.title,
      ...counts,
    });
    console.log(
      `[strategy-cleanup] removed "${strat.title}" (${strat.id}) — ` +
        `trades=${counts.trades} subs=${counts.subscriptions} positions=${counts.tradePositions}`,
    );
  }

  const primary = await resolveFutureHedgeStrategy(prisma);

  return {
    removed,
    primaryStrategyId: primary.id,
    primaryStrategyTitle: primary.title,
  };
}
