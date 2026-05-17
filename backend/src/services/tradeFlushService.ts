import { TradeStatus, type Prisma, type PrismaClient } from "@prisma/client";

type DbClient = PrismaClient | Prisma.TransactionClient;
import {
  endOfUtcDay,
  realizedTradePnl,
  startOfUtcDay,
} from "./dashboardMetricsService.js";

export type TradeFlushRow = {
  id: string;
  strategyId: string;
  tradePnl: number;
  pnl: number | null;
  createdAt: Date;
};

/** Remove PnL calendar / analytics rows tied to deleted trades. */
export async function purgeAnalyticsForDeletedTrades(
  prisma: DbClient,
  userId: string,
  trades: TradeFlushRow[],
  flushAllForUser: boolean,
): Promise<number> {
  if (flushAllForUser) {
    const out = await prisma.pnLRecord.deleteMany({ where: { userId } });
    return out.count;
  }

  let removed = 0;
  for (const t of trades) {
    const profit = realizedTradePnl(t);
    const dayStart = startOfUtcDay(t.createdAt);
    const dayEnd = endOfUtcDay(t.createdAt);

    const whereBase = {
      userId,
      strategyId: t.strategyId,
      timestamp: { gte: dayStart, lte: dayEnd },
    };

    if (Number.isFinite(profit) && profit !== 0) {
      const match = await prisma.pnLRecord.findFirst({
        where: { ...whereBase, profitAmount: profit },
        orderBy: { timestamp: "desc" },
        select: { id: true },
      });
      if (match) {
        await prisma.pnLRecord.delete({ where: { id: match.id } });
        removed += 1;
        continue;
      }
    }

    const dayRows = await prisma.pnLRecord.findMany({
      where: whereBase,
      select: { id: true },
    });
    if (dayRows.length === 1) {
      await prisma.pnLRecord.delete({ where: { id: dayRows[0]!.id } });
      removed += 1;
    }
  }
  return removed;
}

export function buildFlushableTradeWhere(
  userId: string,
  tradeIds?: string[],
): {
  userId: string;
  status: { not: TradeStatus };
  id?: { in: string[] };
} {
  const where = {
    userId,
    status: { not: TradeStatus.OPEN },
  };
  if (tradeIds && tradeIds.length > 0) {
    return { ...where, id: { in: tradeIds } };
  }
  return where;
}
