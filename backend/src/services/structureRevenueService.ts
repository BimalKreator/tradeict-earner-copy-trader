import { Prisma, SubscriptionStatus, type PrismaClient } from "@prisma/client";
import { guardedCron } from "../utils/cronGuard.js";
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
import {
  INVOICE_STATUS,
  isInvoiceFrozen,
  transitionMonthlyRevenueInvoiceStatus,
} from "./monthlyRevenueInvoiceLifecycleService.js";
import { getUsdInrRate } from "./settingsService.js";
import { raiseAlert } from "../utils/systemAlert.js";

const BILLING_TIMEZONE = DASHBOARD_PNL_DAY_TIMEZONE;
const MS_PER_DAY = 86_400_000;
const SYSTEM_SETTINGS_ID = "global";

async function alertIfConfiguredUsdInrRateMissing(
  prisma: PrismaClient,
): Promise<void> {
  const settings = await prisma.systemSettings.findUnique({
    where: { id: SYSTEM_SETTINGS_ID },
    select: { usdInrRate: true },
  });
  const stored = settings?.usdInrRate;
  if (stored != null && Number.isFinite(stored) && stored > 0) return;
  void raiseAlert({
    key: "fx-rate-missing",
    severity: "CRITICAL",
    source: "structureRevenue",
    message:
      "USD/INR rate missing or invalid in SystemSettings — billing will use fallback rate",
    detail: { storedRate: stored ?? null },
  });
}

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
//
// NULL attributionStatus means "not checked / no problem found" — treat
// as OK. Only an explicit SUSPECT_INCOMPLETE is excluded from billable.
function isSuspectAttribution(status: string | null): boolean {
  return status === ATTRIBUTION_STATUS.SUSPECT_INCOMPLETE;
}

/**
 * Billable = not explicitly SUSPECT.
 * Prisma `NOT status = X` excludes NULLs in SQL — so include NULL explicitly.
 */
function billableStructuresFilter(): Prisma.StructurePnlWhereInput {
  return {
    OR: [
      { attributionStatus: null },
      {
        attributionStatus: {
          not: ATTRIBUTION_STATUS.SUSPECT_INCOMPLETE,
        },
      },
    ],
  };
}

/**
 * Cumulative / HWM = billable rows, plus SUSPECT losses (asymmetric rule).
 */
function cumulativeStructuresFilter(): Prisma.StructurePnlWhereInput {
  return {
    OR: [
      { attributionStatus: null },
      {
        attributionStatus: {
          not: ATTRIBUTION_STATUS.SUSPECT_INCOMPLETE,
        },
      },
      {
        attributionStatus: ATTRIBUTION_STATUS.SUSPECT_INCOMPLETE,
        realizedPnl: { lt: 0 },
      },
    ],
  };
}

type ClosedStructureRow = {
  id: string;
  botStructureId: number;
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
    select: {
      id: true,
      botStructureId: true,
      realizedPnl: true,
      attributionStatus: true,
    },
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
    if (row.attributionStatus == null) {
      console.error(
        `[StructureRevenue] closed structure ${row.botStructureId} (id=${row.id}) ` +
          `has NULL attributionStatus -- treated as OK, but this should never happen`,
      );
    }

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

export class MissingProfitShareError extends Error {
  readonly userId: string;
  readonly periodYear: number;
  readonly periodMonth: number;

  constructor(userId: string, periodYear: number, periodMonth: number) {
    super(
      `Cannot resolve profitSharePct for user=${userId} period=${periodYear}-${String(periodMonth).padStart(2, "0")} — refusing zero-commission billing`,
    );
    this.name = "MissingProfitShareError";
    this.userId = userId;
    this.periodYear = periodYear;
    this.periodMonth = periodMonth;
  }
}

const botStrategySubscriptionFilter = {
  AND: [
    { botStrategyType: { not: null } },
    { NOT: { botStrategyType: "" } },
  ],
};

/** Lock profit-share % at subscribe time for billing when subscription is paused. */
export function profitSharePctSnapshotFromStrategy(
  strategyProfitShare: number,
  override?: Prisma.Decimal | null,
): Prisma.Decimal {
  if (override != null) return override;
  return new Prisma.Decimal(strategyProfitShare);
}

async function resolveUserProfitSharePct(
  prisma: PrismaClient,
  userId: string,
  periodYear: number,
  periodMonth: number,
  opts?: { requirePositive?: boolean },
): Promise<Prisma.Decimal> {
  const { monthEndExclusive } = istMonthBounds(periodYear, periodMonth);

  let sub = await prisma.userStrategySubscription.findFirst({
    where: {
      userId,
      joinedDate: { lt: monthEndExclusive },
      status: { not: SubscriptionStatus.CANCELLED },
      strategy: botStrategySubscriptionFilter,
    },
    orderBy: { joinedDate: "desc" },
    include: { strategy: { select: { profitShare: true } } },
  });

  if (!sub) {
    sub = await prisma.userStrategySubscription.findFirst({
      where: {
        userId,
        status: { not: SubscriptionStatus.CANCELLED },
        strategy: botStrategySubscriptionFilter,
      },
      orderBy: { joinedDate: "desc" },
      include: { strategy: { select: { profitShare: true } } },
    });
  }

  if (!sub) {
    if (opts?.requirePositive) {
      throw new MissingProfitShareError(userId, periodYear, periodMonth);
    }
    return zero();
  }

  const pct =
    sub.profitShareOverride ??
    sub.profitSharePctSnapshot ??
    new Prisma.Decimal(sub.strategy.profitShare);

  if (opts?.requirePositive && pct.lte(0)) {
    throw new MissingProfitShareError(userId, periodYear, periodMonth);
  }

  return pct;
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

  const profitSharePct = await resolveUserProfitSharePct(
    prisma,
    userId,
    periodYear,
    periodMonth,
    {
      requirePositive:
        billable.length > 0 || billableProfit.gt(0) || realizedPnl.gt(0),
    },
  );
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
  frozenPeriodLateData: Array<{
    periodYear: number;
    periodMonth: number;
    fields: string[];
  }>;
};

function compareInvoiceMetricsDrift(
  existing: {
    realizedPnl: Prisma.Decimal;
    cumulativeRealizedPnl: Prisma.Decimal | null;
    hwmBefore: Prisma.Decimal;
    hwmAfter: Prisma.Decimal;
    billableProfit: Prisma.Decimal;
    commissionAmount: Prisma.Decimal;
  },
  metrics: MonthlyInvoiceMetrics,
): string[] {
  const fields: string[] = [];
  if (!existing.realizedPnl.eq(metrics.realizedPnl)) fields.push("realizedPnl");
  const existingCum = existing.cumulativeRealizedPnl ?? zero();
  if (!existingCum.eq(metrics.cumulativeRealizedPnl)) {
    fields.push("cumulativeRealizedPnl");
  }
  if (!existing.hwmBefore.eq(metrics.hwmBefore)) fields.push("hwmBefore");
  if (!existing.hwmAfter.eq(metrics.hwmAfter)) fields.push("hwmAfter");
  if (!existing.billableProfit.eq(metrics.billableProfit)) {
    fields.push("billableProfit");
  }
  if (!existing.commissionAmount.eq(metrics.commissionAmount)) {
    fields.push("commissionAmount");
  }
  return fields;
}

/** Recompute all invoices chronologically — required after late-arriving structure data. */
export async function recomputeInvoiceChain(
  prisma: PrismaClient,
  userId: string,
  isSimulated: boolean,
): Promise<RecomputeInvoiceChainResult> {
  const simFilter = scopedSimulatedFilter(isSimulated);

  await alertIfConfiguredUsdInrRateMissing(prisma);

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
  const frozenPeriodLateData: RecomputeInvoiceChainResult["frozenPeriodLateData"] =
    [];
  const generatedAt = new Date();

  for (const period of periods) {
    const existing = existingInvoices.find(
      (inv) =>
        inv.periodYear === period.year && inv.periodMonth === period.month,
    );

    if (existing && isInvoiceFrozen(existing.status)) {
      let metrics: MonthlyInvoiceMetrics;
      try {
        metrics = await computeMonthlyInvoiceMetrics(
          prisma,
          userId,
          period.year,
          period.month,
          isSimulated,
          existing.hwmBefore,
        );
      } catch (err) {
        if (err instanceof MissingProfitShareError) {
          after.push(invoiceToSummary(existing));
          hwmCarry = maxDec(zero(), existing.hwmAfter);
          continue;
        }
        throw err;
      }

      const driftFields = compareInvoiceMetricsDrift(existing, metrics);
      if (driftFields.length > 0) {
        frozenPeriodLateData.push({
          periodYear: period.year,
          periodMonth: period.month,
          fields: driftFields,
        });
        console.error(
          `[Revenue] frozen period ${period.year}-${String(period.month).padStart(2, "0")} ` +
            `user=${userId} has late data -- manual credit note or void may be required ` +
            `fields=${driftFields.join(",")}`,
        );
      }

      after.push(invoiceToSummary(existing));
      hwmCarry = maxDec(zero(), existing.hwmAfter);
      continue;
    }

    let metrics: MonthlyInvoiceMetrics;
    try {
      metrics = await computeMonthlyInvoiceMetrics(
        prisma,
        userId,
        period.year,
        period.month,
        isSimulated,
        hwmCarry,
      );
    } catch (err) {
      if (err instanceof MissingProfitShareError) {
        console.error(`[StructureRevenue] recompute skip: ${err.message}`);
        if (existing) {
          after.push(invoiceToSummary(existing));
          hwmCarry = maxDec(zero(), existing.hwmAfter);
        }
        continue;
      }
      throw err;
    }
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

  return {
    ok: true,
    userId,
    isSimulated,
    before,
    after,
    changed,
    frozenPeriodLateData,
  };
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
  if (existing && isInvoiceFrozen(existing.status)) {
    return existing;
  }

  const isSimulated = opts?.isSimulated ?? existing?.isSimulated ?? false;
  let metrics: MonthlyInvoiceMetrics;
  try {
    metrics = await computeMonthlyInvoiceMetrics(
      prisma,
      userId,
      periodYear,
      periodMonth,
      isSimulated,
    );
  } catch (err) {
    if (err instanceof MissingProfitShareError) {
      console.error(`[StructureRevenue] ${err.message}`);
      if (existing) return existing;
      throw err;
    }
    throw err;
  }
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

  const istParts = calendarPartsInTimeZone(snapshotDate, BILLING_TIMEZONE);
  const profitSharePct = await resolveUserProfitSharePct(
    prisma,
    userId,
    istParts.year,
    istParts.month,
    { requirePositive: realizedDelta.gt(0) },
  );
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

/** True when the period is strictly before the current IST calendar month. */
export function isPastIstCalendarMonth(
  periodYear: number,
  periodMonth: number,
  ref = new Date(),
): boolean {
  const current = calendarPartsInTimeZone(ref, BILLING_TIMEZONE);
  return (
    periodYear < current.year ||
    (periodYear === current.year && periodMonth < current.month)
  );
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

  const shouldIssue = isPastIstCalendarMonth(period.year, period.month);
  if (shouldIssue) {
    await alertIfConfiguredUsdInrRateMissing(prisma);
  }
  const usdInrRate = shouldIssue ? await getUsdInrRate(prisma) : null;

  const results: Record<string, Prisma.MonthlyRevenueInvoiceGetPayload<object>> =
    {};

  for (const userId of userIds) {
    try {
      let invoice = await computeMonthlyRevenueInvoiceForUser(
        prisma,
        userId,
        period.year,
        period.month,
      );

      if (
        shouldIssue &&
        invoice.status === INVOICE_STATUS.ACCRUED &&
        !invoice.isSimulated &&
        usdInrRate != null
      ) {
        invoice = await transitionMonthlyRevenueInvoiceStatus(
          prisma,
          invoice.id,
          INVOICE_STATUS.INVOICED,
          { usdInrRate },
        );
      }

      results[userId] = invoice;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[StructureRevenue] monthly invoice failed user=${userId}: ${msg}`,
      );
    }
  }

  console.log(
    `[StructureRevenue] monthly invoice ${period.year}-${String(period.month).padStart(2, "0")} users=${userIds.length} issued=${shouldIssue}`,
  );
  return results;
}

export function initStructureRevenueCronJobs(prisma: PrismaClient): void {
  guardedCron(
    "structure-revenue-daily-snapshot",
    "5 0 * * *",
    async () => {
      await runDailyPnlSnapshots(prisma);
    },
    { timezone: BILLING_TIMEZONE },
  );

  guardedCron(
    "structure-revenue-monthly-invoice",
    "0 0 1 * *",
    async () => {
      await runMonthlyRevenueInvoices(prisma);
    },
    { timezone: BILLING_TIMEZONE },
  );

  console.log(
    `[StructureRevenue] Cron: daily snapshot @ 00:05 IST; monthly invoice @ 00:00 IST on 1st`,
  );
}
