import { Prisma, type PrismaClient } from "@prisma/client";
import cron from "node-cron";
import {
  DASHBOARD_PNL_DAY_TIMEZONE,
  calendarPartsInTimeZone,
  endOfDayInTimeZone,
  endOfMonthInTimeZone,
  startOfDayInTimeZone,
  startOfMonthInTimeZone,
} from "./dashboardMetricsService.js";
import {
  ATTRIBUTION_STATUS,
  countBillingOverlapTxnsInIstWindow,
  listEligibleStructurePnlUserIds,
} from "./structurePnlService.js";
import { scopedSimulatedFilter } from "./simulatedDataFilters.js";

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

/** Money to 2 decimal places — banker's rounding (ROUND_HALF_EVEN). */
export function roundMoneyHalfEven(
  value: Prisma.Decimal,
  decimalPlaces = 2,
): Prisma.Decimal {
  return value.toDecimalPlaces(decimalPlaces, Prisma.Decimal.ROUND_HALF_EVEN);
}

/**
 * Commission from billable profit × profit-share % — Decimal only, then
 * ROUND_HALF_EVEN to cents once. Never use IEEE-754 float on this path.
 */
export function computeCommissionAmount(
  billableProfit: Prisma.Decimal,
  profitSharePct: Prisma.Decimal,
): Prisma.Decimal {
  const raw = billableProfit.mul(profitSharePct).div(100);
  return roundMoneyHalfEven(maxDec(zero(), raw));
}

function sumStructureRealized(
  rows: Array<{ realizedPnl: Prisma.Decimal | null }>,
): Prisma.Decimal {
  return rows.reduce((sum, row) => {
    if (row.realizedPnl == null) return sum;
    return sum.add(row.realizedPnl);
  }, zero());
}

// ASYMMETRIC BY DESIGN. A suspect gain is never billed. A suspect
// loss still lowers the high-water mark. Resolving doubt in the
// customer's favour is the rule; symmetric exclusion charges a
// losing customer.
function isSuspectAttribution(status: string | null): boolean {
  return status === ATTRIBUTION_STATUS.SUSPECT_INCOMPLETE;
}

/** Structures that may contribute to this month's billable realized P&L (OK only). */
function billableStructuresFilter(): Prisma.StructurePnlWhereInput {
  return {
    NOT: { attributionStatus: ATTRIBUTION_STATUS.SUSPECT_INCOMPLETE },
  };
}

/**
 * Structures that feed lifetime cumulative / HWM:
 * OK rows, plus SUSPECT_INCOMPLETE rows with realizedPnl < 0.
 */
function cumulativeStructuresFilter(): Prisma.StructurePnlWhereInput {
  return {
    OR: [
      { NOT: { attributionStatus: ATTRIBUTION_STATUS.SUSPECT_INCOMPLETE } },
      {
        attributionStatus: ATTRIBUTION_STATUS.SUSPECT_INCOMPLETE,
        realizedPnl: { lt: 0 },
      },
    ],
  };
}

type ClosedStructureRow = {
  realizedPnl: Prisma.Decimal | null;
  attributionStatus: string | null;
};

async function structuresClosedInIstWindow(
  prisma: PrismaClient,
  userId: string,
  windowStart: Date,
  windowEndExclusive: Date,
  isSimulated?: boolean,
): Promise<ClosedStructureRow[]> {
  return prisma.structurePnl.findMany({
    where: {
      userId,
      ...(isSimulated !== undefined
        ? scopedSimulatedFilter(isSimulated)
        : {}),
      closedAt: { gte: windowStart, lt: windowEndExclusive },
      realizedPnl: { not: null },
    },
    select: { realizedPnl: true, attributionStatus: true },
  });
}

function partitionStructures(rows: ClosedStructureRow[]): {
  billable: ClosedStructureRow[];
  cumulative: ClosedStructureRow[];
  suspectCount: number;
  suspectLossesCountedCount: number;
  suspectLossesCountedAmount: Prisma.Decimal;
} {
  const billable: ClosedStructureRow[] = [];
  const cumulative: ClosedStructureRow[] = [];
  let suspectCount = 0;
  let suspectLossesCountedCount = 0;
  let suspectLossesCountedAmount = zero();

  for (const row of rows) {
    const suspect = isSuspectAttribution(row.attributionStatus);
    const pnl = row.realizedPnl;
    const isLoss = pnl != null && pnl.lessThan(0);

    if (suspect) {
      suspectCount += 1;
      if (isLoss) {
        cumulative.push(row);
        suspectLossesCountedCount += 1;
        suspectLossesCountedAmount = suspectLossesCountedAmount.add(pnl);
      }
      // suspect gains: excluded from billable AND cumulative
      continue;
    }

    billable.push(row);
    cumulative.push(row);
  }

  return {
    billable,
    cumulative,
    suspectCount,
    suspectLossesCountedCount,
    suspectLossesCountedAmount,
  };
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
): Promise<Prisma.Decimal> {
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
  if (sub?.profitShareOverride != null) {
    return sub.profitShareOverride;
  }
  return new Prisma.Decimal(sub?.strategy.profitShare ?? 0);
}

function previousCalendarMonth(
  year: number,
  month: number,
): { year: number; month: number } {
  if (month <= 1) return { year: year - 1, month: 12 };
  return { year, month: month - 1 };
}

function istMonthBounds(
  periodYear: number,
  periodMonth: number,
): { monthStart: Date; monthEndExclusive: Date } {
  const monthProbe = new Date(
    Date.UTC(periodYear, periodMonth - 1, 15, 12, 0, 0),
  );
  return {
    monthStart: startOfMonthInTimeZone(monthProbe, BILLING_TIMEZONE),
    monthEndExclusive: endOfMonthInTimeZone(monthProbe, BILLING_TIMEZONE),
  };
}

/** Running lifetime HWM from all structures closed strictly before `monthStart`. */
async function runningHwmBeforeMonthStart(
  prisma: PrismaClient,
  userId: string,
  monthStart: Date,
  isSimulated: boolean,
): Promise<Prisma.Decimal> {
  const structures = await prisma.structurePnl.findMany({
    where: {
      userId,
      ...scopedSimulatedFilter(isSimulated),
      ...cumulativeStructuresFilter(),
      closedAt: { lt: monthStart },
      realizedPnl: { not: null },
    },
    select: { closedAt: true, realizedPnl: true },
    orderBy: { closedAt: "asc" },
  });

  let cumulative = zero();
  let hwm = zero();
  for (const row of structures) {
    if (row.realizedPnl == null) continue;
    cumulative = cumulative.add(row.realizedPnl);
    hwm = maxDec(hwm, cumulative);
  }
  return hwm;
}

/** Lifetime cumulative realized P&L through end of period (exclusive month end bound). */
async function lifetimeCumulativeRealizedToDate(
  prisma: PrismaClient,
  userId: string,
  periodEndExclusive: Date,
  isSimulated: boolean,
): Promise<Prisma.Decimal> {
  const rows = await prisma.structurePnl.findMany({
    where: {
      userId,
      ...scopedSimulatedFilter(isSimulated),
      ...cumulativeStructuresFilter(),
      closedAt: { lt: periodEndExclusive },
      realizedPnl: { not: null },
    },
    select: { realizedPnl: true },
  });
  return sumStructureRealized(rows);
}

async function resolveHwmBeforeForPeriod(
  prisma: PrismaClient,
  userId: string,
  periodYear: number,
  periodMonth: number,
  isSimulated: boolean,
): Promise<Prisma.Decimal> {
  const prior = previousCalendarMonth(periodYear, periodMonth);
  const priorInvoice = await prisma.monthlyRevenueInvoice.findUnique({
    where: {
      userId_periodYear_periodMonth: {
        userId,
        periodYear: prior.year,
        periodMonth: prior.month,
      },
    },
    select: { hwmAfter: true, isSimulated: true },
  });

  if (priorInvoice && priorInvoice.isSimulated === isSimulated) {
    return maxDec(zero(), priorInvoice.hwmAfter);
  }

  const { monthStart } = istMonthBounds(periodYear, periodMonth);
  return runningHwmBeforeMonthStart(prisma, userId, monthStart, isSimulated);
}

export type MonthlyInvoiceMetrics = {
  structuresClosed: number;
  suspectStructuresCount: number;
  suspectLossesCountedCount: number;
  suspectLossesCountedAmount: Prisma.Decimal;
  overlapTxnCount: number;
  realizedPnl: Prisma.Decimal;
  cumulativeRealizedPnl: Prisma.Decimal;
  hwmBefore: Prisma.Decimal;
  hwmAfter: Prisma.Decimal;
  billableProfit: Prisma.Decimal;
  profitSharePct: Prisma.Decimal;
  commissionAmount: Prisma.Decimal;
};

export async function computeMonthlyInvoiceMetrics(
  prisma: PrismaClient,
  userId: string,
  periodYear: number,
  periodMonth: number,
  isSimulated: boolean,
  hwmBeforeOverride?: Prisma.Decimal,
): Promise<MonthlyInvoiceMetrics> {
  const { monthStart, monthEndExclusive } = istMonthBounds(
    periodYear,
    periodMonth,
  );

  const closedInMonth = await structuresClosedInIstWindow(
    prisma,
    userId,
    monthStart,
    monthEndExclusive,
    isSimulated,
  );
    const {
    billable,
    suspectCount,
    suspectLossesCountedCount,
    suspectLossesCountedAmount,
  } = partitionStructures(closedInMonth);
  // Month realizedPnl is billable-only (suspect losses omitted on purpose —
  // they still affect cumulative / HWM via cumulativeStructuresFilter).
  const realizedPnl = sumStructureRealized(billable);
  const overlapTxnCount = await countBillingOverlapTxnsInIstWindow(
    prisma,
    userId,
    monthStart,
    monthEndExclusive,
    isSimulated,
  );
  const cumulativeRealizedPnl = await lifetimeCumulativeRealizedToDate(
    prisma,
    userId,
    monthEndExclusive,
    isSimulated,
  );

  const hwmBefore =
    hwmBeforeOverride ??
    (await resolveHwmBeforeForPeriod(
      prisma,
      userId,
      periodYear,
      periodMonth,
      isSimulated,
    ));
  const hwmAfter = maxDec(hwmBefore, cumulativeRealizedPnl);
  const billableProfit = maxDec(zero(), hwmAfter.sub(hwmBefore));

  const profitSharePct = await resolveUserProfitSharePct(prisma, userId);
  const commissionAmount = computeCommissionAmount(
    billableProfit,
    profitSharePct,
  );

  return {
    structuresClosed: billable.length,
    suspectStructuresCount: suspectCount,
    suspectLossesCountedCount,
    suspectLossesCountedAmount,
    overlapTxnCount,
    realizedPnl,
    cumulativeRealizedPnl,
    hwmBefore,
    hwmAfter,
    billableProfit,
    profitSharePct,
    commissionAmount,
  };
}

function invoiceToSummary(
  inv: {
    periodYear: number;
    periodMonth: number;
    realizedPnl: Prisma.Decimal;
    cumulativeRealizedPnl: Prisma.Decimal | null;
    hwmBefore: Prisma.Decimal;
    hwmAfter: Prisma.Decimal;
    billableProfit: Prisma.Decimal;
    commissionAmount: Prisma.Decimal;
  },
): {
  periodYear: number;
  periodMonth: number;
  realizedPnl: number;
  cumulativeRealizedPnl: number;
  hwmBefore: number;
  hwmAfter: number;
  billableProfit: number;
  commissionAmount: number;
} {
  return {
    periodYear: inv.periodYear,
    periodMonth: inv.periodMonth,
    realizedPnl: inv.realizedPnl.toNumber(),
    cumulativeRealizedPnl: inv.cumulativeRealizedPnl?.toNumber() ?? 0,
    hwmBefore: inv.hwmBefore.toNumber(),
    hwmAfter: inv.hwmAfter.toNumber(),
    billableProfit: inv.billableProfit.toNumber(),
    commissionAmount: inv.commissionAmount.toNumber(),
  };
}

export type RecomputeInvoiceChainResult = {
  ok: true;
  userId: string;
  isSimulated: boolean;
  before: ReturnType<typeof invoiceToSummary>[];
  after: ReturnType<typeof invoiceToSummary>[];
  changed: Array<{
    periodYear: number;
    periodMonth: number;
    fields: string[];
  }>;
};

/** Recompute all invoices chronologically — required after late-arriving structure data. */
export async function recomputeInvoiceChain(
  prisma: PrismaClient,
  userId: string,
  isSimulated: boolean,
): Promise<RecomputeInvoiceChainResult> {
  const simFilter = scopedSimulatedFilter(isSimulated);

  const [existingInvoices, structureCloses] = await Promise.all([
    prisma.monthlyRevenueInvoice.findMany({
      where: { userId, ...simFilter },
      orderBy: [{ periodYear: "asc" }, { periodMonth: "asc" }],
    }),
    prisma.structurePnl.findMany({
      where: {
        userId,
        ...simFilter,
        status: "closed",
        closedAt: { not: null },
        realizedPnl: { not: null },
      },
      select: { closedAt: true },
    }),
  ]);

  const before = existingInvoices.map(invoiceToSummary);
  const periodKeys = new Map<string, { year: number; month: number }>();

  for (const inv of existingInvoices) {
    periodKeys.set(`${inv.periodYear}-${inv.periodMonth}`, {
      year: inv.periodYear,
      month: inv.periodMonth,
    });
  }

  for (const row of structureCloses) {
    if (!row.closedAt) continue;
    const parts = calendarPartsInTimeZone(row.closedAt, BILLING_TIMEZONE);
    periodKeys.set(`${parts.year}-${parts.month}`, {
      year: parts.year,
      month: parts.month,
    });
  }

  const periods = Array.from(periodKeys.values()).sort((a, b) =>
    a.year !== b.year ? a.year - b.year : a.month - b.month,
  );

  let hwmCarry: Prisma.Decimal | undefined;
  const after: ReturnType<typeof invoiceToSummary>[] = [];
  const generatedAt = new Date();

  for (const period of periods) {
    const existing = existingInvoices.find(
      (inv) =>
        inv.periodYear === period.year && inv.periodMonth === period.month,
    );

    if (
      existing &&
      (existing.status === INVOICE_STATUS.INVOICED ||
        existing.status === INVOICE_STATUS.PAID)
    ) {
      after.push(invoiceToSummary(existing));
      hwmCarry = maxDec(zero(), existing.hwmAfter);
      continue;
    }

    const metrics = await computeMonthlyInvoiceMetrics(
      prisma,
      userId,
      period.year,
      period.month,
      isSimulated,
      hwmCarry,
    );
    hwmCarry = metrics.hwmAfter;

    const data = {
      structuresClosed: metrics.structuresClosed,
      suspectStructuresCount: metrics.suspectStructuresCount,
      suspectLossesCountedCount: metrics.suspectLossesCountedCount,
      suspectLossesCountedAmount: metrics.suspectLossesCountedAmount,
      overlapTxnCount: metrics.overlapTxnCount,
      realizedPnl: metrics.realizedPnl,
      cumulativeRealizedPnl: metrics.cumulativeRealizedPnl,
      hwmBefore: metrics.hwmBefore,
      hwmAfter: metrics.hwmAfter,
      billableProfit: metrics.billableProfit,
      profitSharePct: metrics.profitSharePct,
      commissionAmount: metrics.commissionAmount,
      status: INVOICE_STATUS.ACCRUED,
      isSimulated,
      generatedAt,
    };

    const saved = existing
      ? await prisma.monthlyRevenueInvoice.update({
          where: { id: existing.id },
          data,
        })
      : await prisma.monthlyRevenueInvoice.create({
          data: {
            userId,
            periodYear: period.year,
            periodMonth: period.month,
            ...data,
          },
        });

    after.push(invoiceToSummary(saved));
  }

  const changed: RecomputeInvoiceChainResult["changed"] = [];
  for (const post of after) {
    const pre = before.find(
      (row) =>
        row.periodYear === post.periodYear &&
        row.periodMonth === post.periodMonth,
    );
    if (!pre) {
      changed.push({
        periodYear: post.periodYear,
        periodMonth: post.periodMonth,
        fields: ["created"],
      });
      continue;
    }
    const fields: string[] = [];
    if (pre.realizedPnl !== post.realizedPnl) fields.push("realizedPnl");
    if (pre.cumulativeRealizedPnl !== post.cumulativeRealizedPnl) {
      fields.push("cumulativeRealizedPnl");
    }
    if (pre.hwmBefore !== post.hwmBefore) fields.push("hwmBefore");
    if (pre.hwmAfter !== post.hwmAfter) fields.push("hwmAfter");
    if (pre.billableProfit !== post.billableProfit) fields.push("billableProfit");
    if (pre.commissionAmount !== post.commissionAmount) {
      fields.push("commissionAmount");
    }
    if (fields.length > 0) {
      changed.push({
        periodYear: post.periodYear,
        periodMonth: post.periodMonth,
        fields,
      });
    }
  }

  return { ok: true, userId, isSimulated, before, after, changed };
}

export async function computeMonthlyRevenueInvoiceForUser(
  prisma: PrismaClient,
  userId: string,
  periodYear: number,
  periodMonth: number,
  opts?: { isSimulated?: boolean },
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

  const isSimulated = opts?.isSimulated ?? existing?.isSimulated ?? false;
  const metrics = await computeMonthlyInvoiceMetrics(
    prisma,
    userId,
    periodYear,
    periodMonth,
    isSimulated,
  );
  const generatedAt = new Date();

  const data = {
    structuresClosed: metrics.structuresClosed,
    suspectStructuresCount: metrics.suspectStructuresCount,
    suspectLossesCountedCount: metrics.suspectLossesCountedCount,
    suspectLossesCountedAmount: metrics.suspectLossesCountedAmount,
    overlapTxnCount: metrics.overlapTxnCount,
    realizedPnl: metrics.realizedPnl,
    cumulativeRealizedPnl: metrics.cumulativeRealizedPnl,
    hwmBefore: metrics.hwmBefore,
    hwmAfter: metrics.hwmAfter,
    billableProfit: metrics.billableProfit,
    profitSharePct: metrics.profitSharePct,
    commissionAmount: metrics.commissionAmount,
    status: INVOICE_STATUS.ACCRUED,
    isSimulated,
    generatedAt,
  };

  if (existing) {
    return prisma.monthlyRevenueInvoice.update({
      where: { id: existing.id },
      data,
    });
  }

  return prisma.monthlyRevenueInvoice.create({
    data: {
      userId,
      periodYear,
      periodMonth,
      ...data,
    },
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
  const commissionAccrued = computeCommissionAmount(hwmIncrease, profitSharePct);
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
