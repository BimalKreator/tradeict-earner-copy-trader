import { Prisma, type PrismaClient } from "@prisma/client";
import cron from "node-cron";
import {
  DASHBOARD_PNL_DAY_TIMEZONE,
  calendarPartsInTimeZone,
  endOfDayInTimeZone,
  endOfMonthInTimeZone,
  floorRevenueShareDue,
  startOfDayInTimeZone,
  startOfMonthInTimeZone,
} from "./dashboardMetricsService.js";
import { listEligibleStructurePnlUserIds } from "./structurePnlService.js";

const BILLING_TIMEZONE = DASHBOARD_PNL_DAY_TIMEZONE;
const MS_PER_DAY = 86_400_000;

const INVOICE_STATUS = {
  ACCRUED: "ACCRUED",
  INVOICED: "INVOICED",
  PAID: "PAID",
  VOID: "VOID",
} as const;

function zero(): Prisma.Decimal {
  return new Prisma.Decimal(0);
}

function dec(n: number | Prisma.Decimal): Prisma.Decimal {
  return n instanceof Prisma.Decimal ? n : new Prisma.Decimal(n);
}

function maxDec(a: Prisma.Decimal, b: Prisma.Decimal): Prisma.Decimal {
  return a.greaterThan(b) ? a : b;
}

function sumStructureRealized(
  rows: Array<{ realizedPnl: Prisma.Decimal | null }>,
): Prisma.Decimal {
  return rows.reduce((sum, row) => {
    if (row.realizedPnl == null) return sum;
    return sum.add(row.realizedPnl);
  }, zero());
}

/** IST calendar day that just ended relative to `ref` (for 00:05 IST daily job). */
export function istSnapshotDateForDayJustEnded(ref = new Date()): Date {
  const todayStart = startOfDayInTimeZone(ref, BILLING_TIMEZONE);
  return startOfDayInTimeZone(
    new Date(todayStart.getTime() - MS_PER_DAY),
    BILLING_TIMEZONE,
  );
}

/** Resolve optional admin `date` (YYYY-MM-DD) to IST midnight snapshotDate. */
export function resolveIstSnapshotDate(dateInput?: string): Date {
  if (dateInput && dateInput.trim().length > 0) {
    const trimmed = dateInput.trim();
    const probe = new Date(`${trimmed}T12:00:00.000Z`);
    if (!Number.isNaN(probe.getTime())) {
      return startOfDayInTimeZone(probe, BILLING_TIMEZONE);
    }
  }
  return istSnapshotDateForDayJustEnded();
}

async function resolveUserProfitSharePct(
  prisma: PrismaClient,
  userId: string,
): Promise<number> {
  const sub = await prisma.userStrategySubscription.findFirst({
    where: {
      userId,
      OR: [{ isActive: true }, { status: "ACTIVE" }],
      strategy: {
        AND: [
          { botStrategyType: { not: null } },
          { NOT: { botStrategyType: "" } },
        ],
      },
    },
    orderBy: { joinedDate: "desc" },
    include: { strategy: { select: { profitShare: true } } },
  });
  return sub?.strategy.profitShare ?? 0;
}

async function structuresClosedInIstWindow(
  prisma: PrismaClient,
  userId: string,
  windowStart: Date,
  windowEndExclusive: Date,
) {
  return prisma.structurePnl.findMany({
    where: {
      userId,
      closedAt: { gte: windowStart, lt: windowEndExclusive },
      realizedPnl: { not: null },
    },
    select: { realizedPnl: true },
  });
}

async function countOpenStructures(
  prisma: PrismaClient,
  userId: string,
): Promise<number> {
  return prisma.structurePnl.count({
    where: {
      userId,
      OR: [{ status: { not: "closed" } }, { closedAt: null }],
    },
  });
}

export async function computeDailyPnlSnapshotForUser(
  prisma: PrismaClient,
  userId: string,
  snapshotDate: Date,
): Promise<Prisma.DailyPnlSnapshotGetPayload<object>> {
  const existing = await prisma.dailyPnlSnapshot.findUnique({
    where: {
      userId_snapshotDate: { userId, snapshotDate },
    },
  });
  if (existing) return existing;

  const dayEnd = endOfDayInTimeZone(snapshotDate, BILLING_TIMEZONE);
  const closedToday = await structuresClosedInIstWindow(
    prisma,
    userId,
    snapshotDate,
    dayEnd,
  );
  const realizedDelta = sumStructureRealized(closedToday);

  const prevDate = startOfDayInTimeZone(
    new Date(snapshotDate.getTime() - MS_PER_DAY),
    BILLING_TIMEZONE,
  );
  const prev = await prisma.dailyPnlSnapshot.findUnique({
    where: { userId_snapshotDate: { userId, snapshotDate: prevDate } },
  });

  const prevCumulative = prev?.cumulativeRealized ?? zero();
  const prevHwm = prev?.highWaterMark ?? zero();
  const prevCommissionCumulative = prev?.commissionCumulative ?? zero();

  const cumulativeRealized = prevCumulative.add(realizedDelta);
  const highWaterMark = maxDec(prevHwm, cumulativeRealized);

  const profitSharePct = await resolveUserProfitSharePct(prisma, userId);
  const hwmIncrease = highWaterMark.sub(prevHwm);
  const commissionAccrued = dec(
    floorRevenueShareDue(
      hwmIncrease.toNumber() * (profitSharePct / 100),
    ),
  );
  const commissionCumulative = prevCommissionCumulative.add(commissionAccrued);
  const openStructureCount = await countOpenStructures(prisma, userId);
  const computedAt = new Date();

  return prisma.dailyPnlSnapshot.create({
    data: {
      userId,
      snapshotDate,
      realizedDelta,
      cumulativeRealized,
      highWaterMark,
      commissionAccrued,
      commissionCumulative,
      openStructureCount,
      computedAt,
    },
  });
}

export async function runDailyPnlSnapshots(
  prisma: PrismaClient,
  opts?: { userId?: string; date?: string },
): Promise<Record<string, Prisma.DailyPnlSnapshotGetPayload<object>>> {
  let userIds = await listEligibleStructurePnlUserIds(prisma);
  if (opts?.userId) userIds = userIds.filter((id) => id === opts.userId);

  const snapshotDate = resolveIstSnapshotDate(opts?.date);
  const results: Record<string, Prisma.DailyPnlSnapshotGetPayload<object>> = {};

  for (const userId of userIds) {
    try {
      results[userId] = await computeDailyPnlSnapshotForUser(
        prisma,
        userId,
        snapshotDate,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[StructureRevenue] daily snapshot failed user=${userId}: ${msg}`);
    }
  }

  console.log(
    `[StructureRevenue] daily snapshot date=${snapshotDate.toISOString()} users=${userIds.length}`,
  );
  return results;
}

export async function computeMonthlyRevenueInvoiceForUser(
  prisma: PrismaClient,
  userId: string,
  periodYear: number,
  periodMonth: number,
): Promise<Prisma.MonthlyRevenueInvoiceGetPayload<object>> {
  const existing = await prisma.monthlyRevenueInvoice.findUnique({
    where: {
      userId_periodYear_periodMonth: { userId, periodYear, periodMonth },
    },
  });
  if (
    existing &&
    (existing.status === INVOICE_STATUS.INVOICED ||
      existing.status === INVOICE_STATUS.PAID)
  ) {
    return existing;
  }

  const monthProbe = new Date(Date.UTC(periodYear, periodMonth - 1, 15, 12, 0, 0));
  const monthStart = startOfMonthInTimeZone(monthProbe, BILLING_TIMEZONE);
  const monthEnd = endOfMonthInTimeZone(monthProbe, BILLING_TIMEZONE);

  const closedInMonth = await structuresClosedInIstWindow(
    prisma,
    userId,
    monthStart,
    monthEnd,
  );
  const realizedPnl = sumStructureRealized(closedInMonth);
  const structuresClosed = closedInMonth.length;

  const priorMonthEnd = startOfDayInTimeZone(
    new Date(monthStart.getTime() - MS_PER_DAY),
    BILLING_TIMEZONE,
  );
  const priorSnap = await prisma.dailyPnlSnapshot.findUnique({
    where: {
      userId_snapshotDate: { userId, snapshotDate: priorMonthEnd },
    },
  });

  const hwmBefore = priorSnap?.highWaterMark ?? zero();
  const cumulativeBefore = priorSnap?.cumulativeRealized ?? zero();
  const cumulativeAfter = cumulativeBefore.add(realizedPnl);
  const hwmAfter = maxDec(hwmBefore, cumulativeAfter);
  const billableProfit = maxDec(zero(), hwmAfter.sub(hwmBefore));

  const profitSharePct = await resolveUserProfitSharePct(prisma, userId);
  const commissionAmount = dec(
    billableProfit.toNumber() * (profitSharePct / 100),
  );
  const generatedAt = new Date();

  if (existing) {
    return prisma.monthlyRevenueInvoice.update({
      where: { id: existing.id },
      data: {
        structuresClosed,
        realizedPnl,
        hwmBefore,
        hwmAfter,
        billableProfit,
        profitSharePct: dec(profitSharePct),
        commissionAmount,
        status: INVOICE_STATUS.ACCRUED,
        generatedAt,
      },
    });
  }

  return prisma.monthlyRevenueInvoice.create({
    data: {
      userId,
      periodYear,
      periodMonth,
      structuresClosed,
      realizedPnl,
      hwmBefore,
      hwmAfter,
      billableProfit,
      profitSharePct: dec(profitSharePct),
      commissionAmount,
      status: INVOICE_STATUS.ACCRUED,
      generatedAt,
    },
  });
}

/** Previous IST calendar month relative to `ref`. */
export function previousIstCalendarMonth(ref = new Date()): {
  year: number;
  month: number;
} {
  const monthStart = startOfMonthInTimeZone(ref, BILLING_TIMEZONE);
  const priorDay = startOfDayInTimeZone(
    new Date(monthStart.getTime() - MS_PER_DAY),
    BILLING_TIMEZONE,
  );
  const parts = calendarPartsInTimeZone(priorDay, BILLING_TIMEZONE);
  return { year: parts.year, month: parts.month };
}

export async function runMonthlyRevenueInvoices(
  prisma: PrismaClient,
  opts?: { userId?: string; year?: number; month?: number },
): Promise<Record<string, Prisma.MonthlyRevenueInvoiceGetPayload<object>>> {
  let userIds = await listEligibleStructurePnlUserIds(prisma);
  if (opts?.userId) userIds = userIds.filter((id) => id === opts.userId);

  const period =
    opts?.year != null && opts?.month != null
      ? { year: opts.year, month: opts.month }
      : previousIstCalendarMonth();

  const results: Record<string, Prisma.MonthlyRevenueInvoiceGetPayload<object>> =
    {};

  for (const userId of userIds) {
    try {
      results[userId] = await computeMonthlyRevenueInvoiceForUser(
        prisma,
        userId,
        period.year,
        period.month,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[StructureRevenue] monthly invoice failed user=${userId}: ${msg}`,
      );
    }
  }

  console.log(
    `[StructureRevenue] monthly invoice ${period.year}-${String(period.month).padStart(2, "0")} users=${userIds.length}`,
  );
  return results;
}

export function initStructureRevenueCronJobs(prisma: PrismaClient): void {
  cron.schedule(
    "5 0 * * *",
    () => {
      void runDailyPnlSnapshots(prisma).catch((err) => {
        console.error("[StructureRevenue] Daily snapshot cron failed:", err);
      });
    },
    { timezone: BILLING_TIMEZONE },
  );

  cron.schedule(
    "0 0 1 * *",
    () => {
      void runMonthlyRevenueInvoices(prisma).catch((err) => {
        console.error("[StructureRevenue] Monthly invoice cron failed:", err);
      });
    },
    { timezone: BILLING_TIMEZONE },
  );

  console.log(
    `[StructureRevenue] Cron: daily snapshot @ 00:05 IST; monthly invoice @ 00:00 IST on 1st`,
  );
}
