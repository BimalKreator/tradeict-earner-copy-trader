import type { PrismaClient } from "@prisma/client";
import {
  FUTURE_HEDGE_STRATEGY_TITLE,
  isLegacyCryptoOptionsStrategyTitle,
  LEGACY_CRYPTO_OPTIONS_STRATEGY_TITLES,
} from "../constants/strategyTitles.js";
import {
  resolveCanonicalFutureHedgeStrategy,
  resolveFutureHedgeStrategy,
} from "./futureHedgeService.js";

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

/** Hard-delete a strategy row by exact title (cascades dependents). */
export async function hardDeleteStrategyByExactTitle(
  prisma: PrismaClient,
  title: string,
): Promise<StrategyRemovalSummary | null> {
  const row = await prisma.strategy.findFirst({
    where: { title },
    select: { id: true, title: true },
  });
  if (!row) return null;
  const counts = await deleteStrategyGraph(prisma, row.id);
  const summary: StrategyRemovalSummary = {
    strategyId: row.id,
    title: row.title,
    ...counts,
  };
  console.log(
    `[strategy-cleanup] hard-deleted "${row.title}" (${row.id}) — ` +
      `trades=${counts.trades} subs=${counts.subscriptions}`,
  );
  return summary;
}

/**
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

/**
 * Merge duplicate "Future Hedge Strategy" rows into one canonical strategy
 * (master keys + copy subscribers). Safe to run on every boot.
 */
export async function consolidateDuplicateFutureHedgeStrategies(
  prisma: PrismaClient,
): Promise<{
  canonicalId: string;
  mergedSubscriptions: number;
  removed: number;
}> {
  const rows = await prisma.strategy.findMany({
    where: { title: FUTURE_HEDGE_STRATEGY_TITLE },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      masterApiKey: true,
      masterApiSecret: true,
    },
  });

  if (rows.length <= 1) {
    const canonical = await resolveCanonicalFutureHedgeStrategy(prisma);
    return {
      canonicalId: canonical?.id ?? rows[0]?.id ?? "",
      mergedSubscriptions: 0,
      removed: 0,
    };
  }

  const canonical = await resolveCanonicalFutureHedgeStrategy(prisma);
  if (!canonical) {
    return { canonicalId: "", mergedSubscriptions: 0, removed: 0 };
  }

  const duplicates = rows.filter((r) => r.id !== canonical.id);
  let mergedSubscriptions = 0;

  for (const dup of duplicates) {
    const subs = await prisma.userStrategySubscription.findMany({
      where: { strategyId: dup.id },
    });

    for (const sub of subs) {
      const onCanonical = await prisma.userStrategySubscription.findUnique({
        where: {
          userId_strategyId: { userId: sub.userId, strategyId: canonical.id },
        },
      });

      if (onCanonical) {
        const dupDeployed =
          sub.isActive && sub.exchangeAccountId != null && sub.exchangeAccountId !== "";
        const canonDeployed =
          onCanonical.isActive &&
          onCanonical.exchangeAccountId != null &&
          onCanonical.exchangeAccountId !== "";
        if (dupDeployed && !canonDeployed) {
          await prisma.userStrategySubscription.update({
            where: { id: onCanonical.id },
            data: {
              exchangeAccountId: sub.exchangeAccountId,
              multiplier: sub.multiplier,
              isActive: sub.isActive,
              status: sub.status,
              syncStatus: sub.syncStatus,
              syncError: sub.syncError,
            },
          });
          mergedSubscriptions += 1;
        }
        await prisma.userStrategySubscription.delete({ where: { id: sub.id } });
      } else {
        await prisma.userStrategySubscription.update({
          where: { id: sub.id },
          data: { strategyId: canonical.id },
        });
        mergedSubscriptions += 1;
      }
    }

    if (
      !canonical.masterApiKey?.trim() &&
      dup.masterApiKey?.trim() &&
      dup.masterApiSecret?.trim()
    ) {
      await prisma.strategy.update({
        where: { id: canonical.id },
        data: {
          masterApiKey: dup.masterApiKey,
          masterApiSecret: dup.masterApiSecret,
        },
      });
    }

    await prisma.trade.updateMany({
      where: { strategyId: dup.id },
      data: { strategyId: canonical.id },
    });
    await prisma.tradePosition.updateMany({
      where: { strategyId: dup.id },
      data: { strategyId: canonical.id },
    });
    await prisma.pnLRecord.updateMany({
      where: { strategyId: dup.id },
      data: { strategyId: canonical.id },
    });
    await prisma.invoice.updateMany({
      where: { strategyId: dup.id },
      data: { strategyId: canonical.id },
    });

    const dupConfig = await prisma.futureHedgeConfig.findUnique({
      where: { strategyId: dup.id },
    });
    if (dupConfig && !canonical.futureHedgeConfig) {
      await prisma.futureHedgeConfig.update({
        where: { id: dupConfig.id },
        data: { strategyId: canonical.id },
      });
    } else if (dupConfig) {
      await prisma.futureHedgeConfig.delete({ where: { id: dupConfig.id } });
    }

    await prisma.strategy.delete({ where: { id: dup.id } });
    console.log(
      `[strategy-cleanup] merged duplicate Future Hedge (${dup.id}) → canonical (${canonical.id})`,
    );
  }

  return {
    canonicalId: canonical.id,
    mergedSubscriptions,
    removed: duplicates.length,
  };
}
