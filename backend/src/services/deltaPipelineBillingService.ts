import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import {
  calendarPartsInTimeZone,
  DASHBOARD_PNL_DAY_TIMEZONE,
  endOfMonthInTimeZone,
  floorRevenueShareDue,
  startOfMonthInTimeZone,
} from "./dashboardMetricsService.js";
import { isBotStrategyType } from "./tradeBillingFilters.js";
import { excludeSimulatedFilter } from "./simulatedDataFilters.js";

function dec(value: Prisma.Decimal | null | undefined): number {
  if (value == null) return 0;
  return value.toNumber();
}

/** Live IST month-to-date P&L + commission from DailyPnlSnapshot. */
export async function getBotStrategyMtdFromSnapshots(
  prisma: PrismaClient,
  userId: string,
  ref = new Date(),
): Promise<{ cumulativePnl: number; estimatedDue: number }> {
  const monthStart = startOfMonthInTimeZone(ref, DASHBOARD_PNL_DAY_TIMEZONE);
  const snapshots = await prisma.dailyPnlSnapshot.findMany({
    where: {
      userId,
      snapshotDate: { gte: monthStart },
      ...excludeSimulatedFilter(false),
    },
    select: { realizedDelta: true, commissionAccrued: true },
  });

  const cumulativePnl = snapshots.reduce(
    (sum, row) => sum + dec(row.realizedDelta),
    0,
  );
  const estimatedDue = floorRevenueShareDue(
    snapshots.reduce((sum, row) => sum + dec(row.commissionAccrued), 0),
  );

  return { cumulativePnl, estimatedDue };
}

/** Sum Delta-pipeline invoice commission (and realized P&L) for a user. */
export async function sumDeltaPipelineInvoices(
  prisma: PrismaClient,
  userId: string,
  opts?: {
    periodYear?: number;
    periodMonth?: number;
    since?: Date | null;
  },
): Promise<{ grossPnl: number; appRevenue: number }> {
  const where: Prisma.MonthlyRevenueInvoiceWhereInput = {
    userId,
    ...excludeSimulatedFilter(false),
  };
  if (opts?.periodYear != null && opts?.periodMonth != null) {
    where.periodYear = opts.periodYear;
    where.periodMonth = opts.periodMonth;
  } else if (opts?.since) {
    where.generatedAt = { gte: opts.since };
  }

  const rows = await prisma.monthlyRevenueInvoice.findMany({
    where,
    select: { realizedPnl: true, commissionAmount: true },
  });

  const grossPnl = rows.reduce((sum, row) => sum + dec(row.realizedPnl), 0);
  const appRevenue = floorRevenueShareDue(
    rows.reduce((sum, row) => sum + dec(row.commissionAmount), 0),
  );

  return { grossPnl, appRevenue };
}

/** Platform-wide Delta pipeline commission for the current IST month. */
export async function sumDeltaPipelineCommissionForIstMonth(
  prisma: PrismaClient,
  periodYear: number,
  periodMonth: number,
): Promise<number> {
  const agg = await prisma.monthlyRevenueInvoice.aggregate({
    where: { periodYear, periodMonth, ...excludeSimulatedFilter(false) },
    _sum: { commissionAmount: true },
  });
  return floorRevenueShareDue(dec(agg._sum.commissionAmount));
}

export function currentIstCalendarParts(ref = new Date()): {
  year: number;
  month: number;
} {
  return calendarPartsInTimeZone(ref, DASHBOARD_PNL_DAY_TIMEZONE);
}

export async function isStrategyBotType(
  prisma: PrismaClient,
  strategyId: string,
): Promise<boolean> {
  const strategy = await prisma.strategy.findUnique({
    where: { id: strategyId },
    select: { botStrategyType: true },
  });
  return isBotStrategyType(strategy?.botStrategyType);
}

/** IST month window for legacy trade comparison in reconcile reports. */
export function istMonthWindow(
  periodYear: number,
  periodMonth: number,
): { start: Date; endExclusive: Date } {
  const probe = new Date(Date.UTC(periodYear, periodMonth - 1, 15, 12, 0, 0));
  const start = startOfMonthInTimeZone(probe, DASHBOARD_PNL_DAY_TIMEZONE);
  const endExclusive = endOfMonthInTimeZone(probe, DASHBOARD_PNL_DAY_TIMEZONE);
  return { start, endExclusive };
}

export async function countLegacyBotSyncTrades(
  prisma: PrismaClient,
): Promise<number> {
  return prisma.trade.count({
    where: { source: "BOT_SYNC_LEGACY" },
  });
}
