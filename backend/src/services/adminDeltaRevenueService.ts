import { Prisma, TradeStatus, type PrismaClient } from "@prisma/client";
import {
  BILLING_TXN_TYPES,
  findMatchingLegWindows,
  listEligibleStructurePnlUserIds,
  type LegWindowSpec,
} from "./structurePnlService.js";
import {
  countLegacyBotSyncTrades,
  istMonthWindow,
} from "./deltaPipelineBillingService.js";
import {
  calendarPartsInTimeZone,
  DASHBOARD_PNL_DAY_TIMEZONE,
  floorRevenueShareDue,
  realizedTradePnl,
  resolveStoredOrComputedTradeRevenueShare,
} from "./dashboardMetricsService.js";
import {
  computeFinalInvoiceScheduledAt,
  finalInvoiceDelayHours,
} from "./billingCronService.js";
import {
  TRADE_SOURCE_BOT_SYNC_LEGACY,
  botStrategyWhere,
} from "./tradeBillingFilters.js";
import { excludeSimulatedFilter } from "./simulatedDataFilters.js";

function dbLegToSpec(leg: {
  botLegId: number;
  productId: number;
  openedAt: Date;
  attributionFrom: Date | null;
  closedAt: Date | null;
  structure: { botStructureId: number };
}): LegWindowSpec {
  return {
    botStructureId: leg.structure.botStructureId,
    botLegId: leg.botLegId,
    productId: leg.productId,
    openedAt: leg.openedAt,
    attributionFrom: leg.attributionFrom,
    closedAt: leg.closedAt,
  };
}

export type UserLedgerHealth = {
  userId: string;
  ledgerRowCount: number;
  lastLedgerOccurredAt: string | null;
  lastLedgerSyncAt: string | null;
  structuresMatched: number;
  unmatchedTxnCount: number;
  zeroMatchStructureCount: number;
  overlapCount: number;
};

export async function computeUserLedgerHealth(
  prisma: PrismaClient,
  userId: string,
  includeSimulated = false,
): Promise<UserLedgerHealth> {
  const simFilter = excludeSimulatedFilter(includeSimulated);
  const [ledgerAgg, user, structures, legs, accountCursor] = await Promise.all([
    prisma.deltaLedgerEntry.aggregate({
      where: {
        userId,
        transactionType: { in: [...BILLING_TXN_TYPES] },
        ...simFilter,
      },
      _count: { _all: true },
      _max: { occurredAt: true },
    }),
    prisma.user.findUnique({
      where: { id: userId },
      select: { deltaLedgerSyncedUpTo: true },
    }),
    prisma.structurePnl.findMany({
      where: { userId, ...simFilter },
      select: {
        id: true,
        botStructureId: true,
        matchedTxnCount: true,
        status: true,
      },
    }),
    prisma.structureLegPnl.findMany({
      where: { structure: { userId, ...simFilter }, ...simFilter },
      select: {
        botLegId: true,
        productId: true,
        openedAt: true,
        attributionFrom: true,
        closedAt: true,
        structure: { select: { botStructureId: true } },
      },
    }),
    prisma.exchangeAccount.aggregate({
      where: { userId },
      _max: { deltaLedgerSyncedUpTo: true },
    }),
  ]);

  const dbLegs: LegWindowSpec[] = legs.map(dbLegToSpec);

  const ledgerRows = await prisma.deltaLedgerEntry.findMany({
    where: {
      userId,
      transactionType: { in: [...BILLING_TXN_TYPES] },
      productId: { not: null },
      ...simFilter,
    },
    select: {
      deltaUuid: true,
      productId: true,
      occurredAt: true,
    },
  });

  let unmatchedTxnCount = 0;
  let overlapCount = 0;
  let structuresMatched = 0;

  for (const txn of ledgerRows) {
    const pid = txn.productId;
    if (pid == null) continue;
    const matching = findMatchingLegWindows(
      { productId: pid, occurredAt: txn.occurredAt },
      dbLegs,
    );
    if (matching.length === 0) {
      unmatchedTxnCount += 1;
      continue;
    }
    if (matching.length > 1) overlapCount += 1;
    structuresMatched += 1;
  }

  const zeroMatchStructureCount = structures.filter(
    (s) => s.matchedTxnCount === 0 && s.status === "closed",
  ).length;

  const lastLedgerSyncAt =
    accountCursor._max.deltaLedgerSyncedUpTo ??
    user?.deltaLedgerSyncedUpTo ??
    null;

  return {
    userId,
    ledgerRowCount: ledgerAgg._count._all,
    lastLedgerOccurredAt: ledgerAgg._max.occurredAt?.toISOString() ?? null,
    lastLedgerSyncAt: lastLedgerSyncAt?.toISOString() ?? null,
    structuresMatched,
    unmatchedTxnCount,
    zeroMatchStructureCount,
    overlapCount,
  };
}

export async function computeAllUsersLedgerHealth(
  prisma: PrismaClient,
  userIds: string[],
  includeSimulated = false,
): Promise<UserLedgerHealth[]> {
  const results: UserLedgerHealth[] = [];
  for (const userId of userIds) {
    try {
      results.push(await computeUserLedgerHealth(prisma, userId, includeSimulated));
    } catch {
      results.push({
        userId,
        ledgerRowCount: 0,
        lastLedgerOccurredAt: null,
        lastLedgerSyncAt: null,
        structuresMatched: 0,
        unmatchedTxnCount: 0,
        zeroMatchStructureCount: 0,
        overlapCount: 0,
      });
    }
  }
  return results;
}

function dec(value: Prisma.Decimal | null | undefined): number {
  if (value == null) return 0;
  return value.toNumber();
}

export async function getAdminRevenueOverview(
  prisma: PrismaClient,
  periodYear: number,
  periodMonth: number,
  includeSimulated = false,
) {
  const simFilter = excludeSimulatedFilter(includeSimulated);
  const eligibleIds = await listEligibleStructurePnlUserIds(prisma);

  const [invoices, usersMeta] = await Promise.all([
    prisma.monthlyRevenueInvoice.findMany({
      where: { periodYear, periodMonth, ...simFilter },
      include: {
        user: { select: { id: true, email: true, name: true } },
      },
    }),
    prisma.user.findMany({
      where: { id: { in: eligibleIds } },
      select: { id: true, email: true, name: true },
      orderBy: { email: "asc" },
    }),
  ]);

  const invoiceByUser = new Map(invoices.map((inv) => [inv.userId, inv]));

  const users = usersMeta.map((u) => {
    const inv = invoiceByUser.get(u.id);
    return {
      userId: u.id,
      email: u.email,
      name: u.name,
      structuresClosed: inv?.structuresClosed ?? 0,
      realizedPnl: inv ? dec(inv.realizedPnl) : 0,
      hwmBefore: inv ? dec(inv.hwmBefore) : 0,
      hwmAfter: inv ? dec(inv.hwmAfter) : 0,
      billableProfit: inv ? dec(inv.billableProfit) : 0,
      profitSharePct: inv ? dec(inv.profitSharePct) : 0,
      commissionAmount: inv ? dec(inv.commissionAmount) : 0,
      invoiceStatus: inv?.status ?? "—",
      invoiceId: inv?.id ?? null,
      isSimulated: inv?.isSimulated ?? false,
    };
  });

  const totals = users.reduce(
    (acc, row) => ({
      structuresClosed: acc.structuresClosed + row.structuresClosed,
      realizedPnl: acc.realizedPnl + row.realizedPnl,
      billableProfit: acc.billableProfit + row.billableProfit,
      commissionAmount: acc.commissionAmount + row.commissionAmount,
    }),
    {
      structuresClosed: 0,
      realizedPnl: 0,
      billableProfit: 0,
      commissionAmount: 0,
    },
  );

  return { periodYear, periodMonth, users, totals };
}

export async function getAdminRevenueUserDetail(
  prisma: PrismaClient,
  userId: string,
  includeSimulated = false,
) {
  const simFilter = excludeSimulatedFilter(includeSimulated);
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, allowSimulation: true },
  });
  if (!user) return null;

  const [snapshots, structures, invoices, subs] = await Promise.all([
    prisma.dailyPnlSnapshot.findMany({
      where: { userId, ...simFilter },
      orderBy: { snapshotDate: "asc" },
    }),
    prisma.structurePnl.findMany({
      where: { userId, ...simFilter },
      orderBy: { openedAt: "desc" },
      include: { legs: { where: simFilter, orderBy: { openedAt: "asc" } } },
    }),
    prisma.monthlyRevenueInvoice.findMany({
      where: { userId, ...simFilter },
      orderBy: [{ periodYear: "desc" }, { periodMonth: "desc" }],
    }),
    prisma.userStrategySubscription.findMany({
      where: {
        userId,
        strategy: { botStrategyType: { not: null } },
      },
      include: {
        strategy: { select: { id: true, title: true, profitShare: true } },
      },
    }),
  ]);

  return {
    user,
    allowSimulation: user.allowSimulation,
    profitShareOverride: subs[0]?.profitShareOverride?.toNumber() ?? null,
    strategyProfitShare: subs[0]?.strategy.profitShare ?? null,
    strategyTitle: subs[0]?.strategy.title ?? null,
    snapshots: snapshots.map((row) => ({
      snapshotDate: row.snapshotDate.toISOString(),
      realizedDelta: dec(row.realizedDelta),
      cumulativeRealized: dec(row.cumulativeRealized),
      highWaterMark: dec(row.highWaterMark),
      commissionAccrued: dec(row.commissionAccrued),
      commissionCumulative: dec(row.commissionCumulative),
      openStructureCount: row.openStructureCount,
      isSimulated: row.isSimulated,
    })),
    structures: structures.map((s) => {
      const fundingTotal = s.legs.reduce(
        (sum, leg) => sum + (leg.fundingTotal != null ? dec(leg.fundingTotal) : 0),
        0,
      );
      const settlementTotal = s.legs.reduce(
        (sum, leg) =>
          sum + (leg.settlementTotal != null ? dec(leg.settlementTotal) : 0),
        0,
      );
      const liquidationFeeTotal = s.legs.reduce(
        (sum, leg) =>
          sum +
          (leg.liquidationFeeTotal != null ? dec(leg.liquidationFeeTotal) : 0),
        0,
      );
      return {
      id: s.id,
      botStructureId: s.botStructureId,
      status: s.status,
      isSimulated: s.isSimulated,
      openedAt: s.openedAt.toISOString(),
      closedAt: s.closedAt?.toISOString() ?? null,
      realizedPnl: s.realizedPnl != null ? dec(s.realizedPnl) : null,
      grossCashflow: dec(s.grossCashflow),
      commissionTotal: dec(s.commissionTotal),
      fundingTotal,
      settlementTotal,
      liquidationFeeTotal,
      matchedTxnCount: s.matchedTxnCount,
      legs: s.legs.map((leg) => ({
        botLegId: leg.botLegId,
        legRole: leg.legRole,
        symbol: leg.symbol,
        productId: leg.productId,
        strike: leg.strike,
        side: leg.side,
        quantity: leg.quantity,
        openedAt: leg.openedAt.toISOString(),
        closedAt: leg.closedAt?.toISOString() ?? null,
        grossCashflow: dec(leg.grossCashflow),
        commissionTotal: dec(leg.commissionTotal),
        fundingTotal:
          leg.fundingTotal != null ? dec(leg.fundingTotal) : null,
        settlementTotal:
          leg.settlementTotal != null ? dec(leg.settlementTotal) : null,
        liquidationFeeTotal:
          leg.liquidationFeeTotal != null
            ? dec(leg.liquidationFeeTotal)
            : null,
        realizedPnl: leg.realizedPnl != null ? dec(leg.realizedPnl) : null,
        matchedTxnCount: leg.matchedTxnCount,
      })),
    };
    }),
    invoices: invoices.map((inv) => ({
      id: inv.id,
      periodYear: inv.periodYear,
      periodMonth: inv.periodMonth,
      structuresClosed: inv.structuresClosed,
      suspectStructuresCount: inv.suspectStructuresCount ?? null,
      suspectLossesCountedCount: inv.suspectLossesCountedCount ?? null,
      suspectLossesCountedAmount:
        inv.suspectLossesCountedAmount != null
          ? dec(inv.suspectLossesCountedAmount)
          : null,
      overlapTxnCount: inv.overlapTxnCount ?? null,
      realizedPnl: dec(inv.realizedPnl),
      cumulativeRealizedPnl: inv.cumulativeRealizedPnl
        ? dec(inv.cumulativeRealizedPnl)
        : null,
      hwmBefore: dec(inv.hwmBefore),
      hwmAfter: dec(inv.hwmAfter),
      billableProfit: dec(inv.billableProfit),
      profitSharePct: dec(inv.profitSharePct),
      commissionAmount: dec(inv.commissionAmount),
      creditNoteAmount:
        inv.creditNoteAmount != null ? dec(inv.creditNoteAmount) : null,
      creditNoteReason: inv.creditNoteReason ?? null,
      status: inv.status,
      invoicedAt: inv.invoicedAt?.toISOString() ?? null,
      dueDate: inv.dueDate?.toISOString() ?? null,
      paidAt: inv.paidAt?.toISOString() ?? null,
      voidedAt: inv.voidedAt?.toISOString() ?? null,
      voidReason: inv.voidReason ?? null,
      amountInr: inv.amountInr != null ? dec(inv.amountInr) : null,
      usdInrRate: inv.usdInrRate != null ? dec(inv.usdInrRate) : null,
      paymentReference: inv.paymentReference ?? null,
      isSimulated: inv.isSimulated,
    })),
  };
}

/** Pad around leg windows for nearby unmatched ledger rows (forensic only). */
const STRUCTURE_LEDGER_NEARBY_PAD_MS = 6 * 60 * 60 * 1000;

export type StructureLedgerEntryRow = {
  deltaUuid: string;
  transactionType: string;
  amount: number;
  occurredAt: string;
  productId: number | null;
  productSymbol: string | null;
};

/**
 * Admin forensic view: Delta ledger rows matched to each leg window, plus
 * nearby unmatched rows. Read-only — does not change customer-facing P&L.
 */
export async function getStructureLedgerForensic(
  prisma: PrismaClient,
  structurePnlId: string,
  includeSimulated = false,
) {
  const simFilter = excludeSimulatedFilter(includeSimulated);
  const structure = await prisma.structurePnl.findFirst({
    where: { id: structurePnlId, ...simFilter },
    include: {
      legs: { where: simFilter, orderBy: { openedAt: "asc" } },
      user: { select: { id: true, email: true } },
    },
  });
  if (!structure) return null;

  const legSpecs: LegWindowSpec[] = structure.legs.map((leg) => ({
    botStructureId: structure.botStructureId,
    botLegId: leg.botLegId,
    productId: leg.productId,
    openedAt: leg.openedAt,
    attributionFrom: leg.attributionFrom,
    closedAt: leg.closedAt,
  }));

  let windowMin = structure.openedAt.getTime();
  let windowMax = (structure.closedAt ?? new Date()).getTime();
  for (const leg of structure.legs) {
    const start = (leg.attributionFrom ?? leg.openedAt).getTime();
    const end = (leg.closedAt ?? new Date()).getTime();
    windowMin = Math.min(windowMin, start);
    windowMax = Math.max(windowMax, end);
  }

  const rangeStart = new Date(windowMin - STRUCTURE_LEDGER_NEARBY_PAD_MS);
  const rangeEnd = new Date(windowMax + STRUCTURE_LEDGER_NEARBY_PAD_MS);

  const ledgerRows = await prisma.deltaLedgerEntry.findMany({
    where: {
      userId: structure.userId,
      transactionType: { in: [...BILLING_TXN_TYPES] },
      occurredAt: { gte: rangeStart, lte: rangeEnd },
      ...simFilter,
    },
    orderBy: { occurredAt: "asc" },
    select: {
      deltaUuid: true,
      transactionType: true,
      amount: true,
      occurredAt: true,
      productId: true,
      productSymbol: true,
    },
  });

  const toRow = (row: (typeof ledgerRows)[number]): StructureLedgerEntryRow => ({
    deltaUuid: row.deltaUuid,
    transactionType: row.transactionType,
    amount: dec(row.amount),
    occurredAt: row.occurredAt.toISOString(),
    productId: row.productId,
    productSymbol: row.productSymbol,
  });

  const matchedUuids = new Set<string>();
  const legs = structure.legs.map((leg) => {
    const matched = ledgerRows.filter((txn) => {
      const hits = findMatchingLegWindows(
        { productId: txn.productId, occurredAt: txn.occurredAt },
        legSpecs,
      );
      return hits.some((h) => h.botLegId === leg.botLegId);
    });
    for (const m of matched) matchedUuids.add(m.deltaUuid);
    return {
      botLegId: leg.botLegId,
      legRole: leg.legRole,
      symbol: leg.symbol,
      productId: leg.productId,
      openedAt: leg.openedAt.toISOString(),
      attributionFrom: leg.attributionFrom?.toISOString() ?? null,
      closedAt: leg.closedAt?.toISOString() ?? null,
      matchedTxnCount: leg.matchedTxnCount,
      matched: matched.map(toRow),
    };
  });

  const nearbyUnmatched = ledgerRows
    .filter((row) => !matchedUuids.has(row.deltaUuid))
    .map(toRow);

  return {
    structurePnlId: structure.id,
    botStructureId: structure.botStructureId,
    userId: structure.userId,
    userEmail: structure.user.email,
    status: structure.status,
    openedAt: structure.openedAt.toISOString(),
    closedAt: structure.closedAt?.toISOString() ?? null,
    realizedPnl: structure.realizedPnl != null ? dec(structure.realizedPnl) : null,
    matchedTxnCount: structure.matchedTxnCount,
    nearbyPadHours: STRUCTURE_LEDGER_NEARBY_PAD_MS / (60 * 60 * 1000),
    legs,
    nearbyUnmatched,
  };
}

export async function getAdminRevenueReconcile(
  prisma: PrismaClient,
  periodYear: number,
  periodMonth: number,
  includeSimulated = false,
) {
  const simFilter = excludeSimulatedFilter(includeSimulated);
  const legacyBotSyncTradeCount = await countLegacyBotSyncTrades(prisma);
  const { start, endExclusive } = istMonthWindow(periodYear, periodMonth);
  const eligibleIds = await listEligibleStructurePnlUserIds(prisma);

  const usersMeta = await prisma.user.findMany({
    where: { id: { in: eligibleIds } },
    select: { id: true, email: true, name: true },
    orderBy: { email: "asc" },
  });

  const invoices = await prisma.monthlyRevenueInvoice.findMany({
    where: { periodYear, periodMonth, userId: { in: eligibleIds }, ...simFilter },
  });
  const invoiceByUser = new Map(invoices.map((inv) => [inv.userId, inv]));

  const users: Array<{
    userId: string;
    email: string;
    name: string | null;
    legacyCommission: number;
    deltaCommission: number;
    difference: number;
    legacyTradeCount: number;
  }> = [];

  let totalLegacy = 0;
  let totalDelta = 0;

  for (const user of usersMeta) {
    const legacyTrades = await prisma.trade.findMany({
      where: {
        userId: user.id,
        status: TradeStatus.CLOSED,
        OR: [
          { source: TRADE_SOURCE_BOT_SYNC_LEGACY },
          {
            exitReason: "BOT_SYNC_CLOSE",
            strategy: botStrategyWhere(),
          },
        ],
        updatedAt: { gte: start, lt: endExclusive },
      },
      select: {
        tradePnl: true,
        pnl: true,
        revenueShareAmt: true,
        strategy: { select: { profitShare: true } },
      },
    });

    let legacyCommissionRaw = 0;
    for (const t of legacyTrades) {
      const realized = realizedTradePnl(t);
      legacyCommissionRaw += resolveStoredOrComputedTradeRevenueShare({
        realizedPnl: realized,
        profitSharePct: t.strategy.profitShare,
        revenueShareAmt: t.revenueShareAmt,
      });
    }
    const legacyCommission = floorRevenueShareDue(legacyCommissionRaw);

    const inv = invoiceByUser.get(user.id);
    const deltaCommission = inv ? dec(inv.commissionAmount) : 0;
    const difference = deltaCommission - legacyCommission;

    totalLegacy += legacyCommission;
    totalDelta += deltaCommission;

    users.push({
      userId: user.id,
      email: user.email,
      name: user.name,
      legacyCommission,
      deltaCommission,
      difference,
      legacyTradeCount: legacyTrades.length,
    });
  }

  return {
    periodYear,
    periodMonth,
    legacyBotSyncTradeCount,
    users,
    totals: {
      legacyCommission: totalLegacy,
      deltaCommission: totalDelta,
      difference: totalDelta - totalLegacy,
    },
  };
}

/** Users with closed (real) structures in an IST month but no real invoice row. */
export async function getUnbilledRevenueUsers(prisma: PrismaClient) {
  const closedStructures = await prisma.structurePnl.findMany({
    where: {
      status: "closed",
      closedAt: { not: null },
      isSimulated: false,
    },
    select: { userId: true, closedAt: true },
  });

  const periodsByUser = new Map<string, Set<string>>();
  for (const row of closedStructures) {
    if (!row.closedAt) continue;
    const parts = calendarPartsInTimeZone(row.closedAt, DASHBOARD_PNL_DAY_TIMEZONE);
    const periodKey = `${parts.year}-${parts.month}`;
    const set = periodsByUser.get(row.userId) ?? new Set<string>();
    set.add(periodKey);
    periodsByUser.set(row.userId, set);
  }

  const gapRows: Array<{
    userId: string;
    missingPeriods: Array<{ periodYear: number; periodMonth: number }>;
  }> = [];

  for (const [userId, periodKeys] of periodsByUser) {
    const missingPeriods: Array<{ periodYear: number; periodMonth: number }> =
      [];
    for (const periodKey of periodKeys) {
      const [yearRaw, monthRaw] = periodKey.split("-");
      const periodYear = Number.parseInt(yearRaw ?? "", 10);
      const periodMonth = Number.parseInt(monthRaw ?? "", 10);
      if (!Number.isFinite(periodYear) || !Number.isFinite(periodMonth)) {
        continue;
      }
      const invoice = await prisma.monthlyRevenueInvoice.findUnique({
        where: {
          userId_periodYear_periodMonth: { userId, periodYear, periodMonth },
        },
        select: { id: true, isSimulated: true },
      });
      if (!invoice || invoice.isSimulated) {
        missingPeriods.push({ periodYear, periodMonth });
      }
    }
    if (missingPeriods.length > 0) {
      gapRows.push({ userId, missingPeriods });
    }
  }

  const usersMeta = await prisma.user.findMany({
    where: { id: { in: gapRows.map((row) => row.userId) } },
    select: { id: true, email: true, name: true },
  });
  const metaById = new Map(usersMeta.map((u) => [u.id, u]));

  const users = gapRows.map((row) => ({
    userId: row.userId,
    email: metaById.get(row.userId)?.email ?? null,
    name: metaById.get(row.userId)?.name ?? null,
    missingPeriods: row.missingPeriods.sort(
      (a, b) =>
        a.periodYear !== b.periodYear
          ? a.periodYear - b.periodYear
          : a.periodMonth - b.periodMonth,
    ),
  }));

  const pendingFinalInvoiceUsers = await prisma.user.findMany({
    where: { pendingFinalInvoiceSince: { not: null } },
    select: {
      id: true,
      email: true,
      name: true,
      pendingFinalInvoiceSince: true,
      pendingFinalInvoicePeriodYear: true,
      pendingFinalInvoicePeriodMonth: true,
    },
    orderBy: { pendingFinalInvoiceSince: "asc" },
  });

  const frozenPeriodAlertUsers = await prisma.user.findMany({
    where: {
      revenueFrozenPeriodAlerts: { not: Prisma.DbNull },
    },
    select: {
      id: true,
      email: true,
      name: true,
      revenueFrozenPeriodAlerts: true,
    },
  });

  type FrozenAlertRow = {
    periodYear: number;
    periodMonth: number;
    fields: string[];
    detectedAt: string;
  };

  const frozenPeriodLateData = frozenPeriodAlertUsers
    .map((user) => {
      const alerts = Array.isArray(user.revenueFrozenPeriodAlerts)
        ? (user.revenueFrozenPeriodAlerts as FrozenAlertRow[])
        : [];
      if (alerts.length === 0) return null;
      return {
        userId: user.id,
        email: user.email,
        name: user.name,
        alerts,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row != null);

  return {
    count: users.length,
    users,
    pendingFinalInvoices: {
      count: pendingFinalInvoiceUsers.length,
      users: pendingFinalInvoiceUsers.map((user) => ({
        userId: user.id,
        email: user.email,
        name: user.name,
        pendingFinalInvoiceSince:
          user.pendingFinalInvoiceSince?.toISOString() ?? null,
        finalInvoiceScheduledAt: user.pendingFinalInvoiceSince
          ? computeFinalInvoiceScheduledAt(user.pendingFinalInvoiceSince).toISOString()
          : null,
        finalInvoiceDelayHours: finalInvoiceDelayHours(),
        periodYear: user.pendingFinalInvoicePeriodYear,
        periodMonth: user.pendingFinalInvoicePeriodMonth,
      })),
    },
    frozenPeriodLateData: {
      count: frozenPeriodLateData.length,
      users: frozenPeriodLateData,
    },
  };
}
