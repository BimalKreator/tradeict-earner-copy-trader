import {
  TradeStatus,
  type Prisma,
  type PrismaClient,
} from "@prisma/client";

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

export type PurgeAnalyticsResult = {
  pnlRecordsRemoved: number;
  commissionLedgersRemoved: number;
};

/** Remove PnL rows and partner commission ledger entries tied to deleted trades. */
export async function purgeAnalyticsForDeletedTrades(
  prisma: DbClient,
  userId: string,
  trades: TradeFlushRow[],
  flushAllForUser: boolean,
): Promise<PurgeAnalyticsResult> {
  if (flushAllForUser) {
    const commissionOut = await prisma.commissionLedger.deleteMany({
      where: {
        OR: [{ sourceUserId: userId }, { pnlRecord: { userId } }],
      },
    });
    const pnlOut = await prisma.pnLRecord.deleteMany({ where: { userId } });
    return {
      pnlRecordsRemoved: pnlOut.count,
      commissionLedgersRemoved: commissionOut.count,
    };
  }

  let pnlRecordsRemoved = 0;
  let commissionLedgersRemoved = 0;

  type Slice = { strategyId: string; dayStart: Date; dayEnd: Date };
  const slices = new Map<string, Slice>();

  for (const t of trades) {
    const dayStart = startOfUtcDay(t.createdAt);
    const dayEnd = endOfUtcDay(t.createdAt);
    const key = `${t.strategyId}:${dayStart.getTime()}`;
    if (!slices.has(key)) {
      slices.set(key, { strategyId: t.strategyId, dayStart, dayEnd });
    }
  }

  const purgedPnlIds = new Set<string>();

  for (const slice of slices.values()) {
    const remainingTrades = await prisma.trade.count({
      where: {
        userId,
        strategyId: slice.strategyId,
        status: { not: TradeStatus.OPEN },
        createdAt: { gte: slice.dayStart, lte: slice.dayEnd },
      },
    });

    if (remainingTrades === 0) {
      const pnls = await prisma.pnLRecord.findMany({
        where: {
          userId,
          strategyId: slice.strategyId,
          timestamp: { gte: slice.dayStart, lte: slice.dayEnd },
        },
        select: { id: true },
      });
      const pnlIds = pnls.map((p) => p.id);
      if (pnlIds.length > 0) {
        const comm = await prisma.commissionLedger.deleteMany({
          where: { pnlRecordId: { in: pnlIds } },
        });
        commissionLedgersRemoved += comm.count;
        const pnlDel = await prisma.pnLRecord.deleteMany({
          where: { id: { in: pnlIds } },
        });
        pnlRecordsRemoved += pnlDel.count;
        for (const id of pnlIds) purgedPnlIds.add(id);
      }
      const orphanComm = await prisma.commissionLedger.deleteMany({
        where: {
          sourceUserId: userId,
          profitDate: slice.dayStart,
        },
      });
      commissionLedgersRemoved += orphanComm.count;
      continue;
    }

    const tradesInSlice = trades.filter(
      (t) =>
        t.strategyId === slice.strategyId &&
        t.createdAt >= slice.dayStart &&
        t.createdAt <= slice.dayEnd,
    );

    for (const t of tradesInSlice) {
      const profit = realizedTradePnl(t);
      const whereBase = {
        userId,
        strategyId: t.strategyId,
        timestamp: { gte: slice.dayStart, lte: slice.dayEnd },
        ...(purgedPnlIds.size > 0
          ? { id: { notIn: [...purgedPnlIds] } }
          : {}),
      };

      let matchId: string | null = null;
      if (Number.isFinite(profit)) {
        const match = await prisma.pnLRecord.findFirst({
          where: { ...whereBase, profitAmount: profit },
          orderBy: { timestamp: "desc" },
          select: { id: true },
        });
        matchId = match?.id ?? null;
      }

      if (!matchId) {
        const dayRows = await prisma.pnLRecord.findMany({
          where: whereBase,
          select: { id: true },
        });
        if (dayRows.length === 1) {
          matchId = dayRows[0]!.id;
        }
      }

      if (matchId && !purgedPnlIds.has(matchId)) {
        const comm = await prisma.commissionLedger.deleteMany({
          where: { pnlRecordId: matchId },
        });
        commissionLedgersRemoved += comm.count;
        await prisma.pnLRecord.delete({ where: { id: matchId } });
        pnlRecordsRemoved += 1;
        purgedPnlIds.add(matchId);
      }
    }
  }

  return { pnlRecordsRemoved, commissionLedgersRemoved };
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
