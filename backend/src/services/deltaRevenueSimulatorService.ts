import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  calendarPartsInTimeZone,
  DASHBOARD_PNL_DAY_TIMEZONE,
  startOfDayInTimeZone,
} from "./dashboardMetricsService.js";
import { distributeRevenueShareCommissions } from "./affiliateCommissionService.js";
import { recomputeStructurePnlForUsers, ATTRIBUTION_STATUS } from "./structurePnlService.js";
import {
  computeMonthlyRevenueInvoiceForUser,
  runDailyPnlSnapshots,
} from "./structureRevenueService.js";
import {
  SIM_BOT_STRUCTURE_ID_BASE,
  SIM_PRODUCT_ID_BASE,
  SIM_SYMBOL_PREFIX,
} from "./simulatedDataFilters.js";

export type SimulationScenario =
  | "PROFIT"
  | "LOSS"
  | "PROFIT_THEN_LOSS_THEN_PROFIT";

export type SimulateStructureInput = {
  userId: string;
  scenario: SimulationScenario;
  realizedPnl?: number;
  closedAtIst?: string;
};

export class SimulationNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimulationNotAllowedError";
  }
}

export class SimulationPurgeBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimulationPurgeBlockedError";
  }
}

function zero(): Prisma.Decimal {
  return new Prisma.Decimal(0);
}

function dec(n: number): Prisma.Decimal {
  return new Prisma.Decimal(n);
}

async function assertUserAllowsSimulation(
  prisma: PrismaClient,
  userId: string,
): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { allowSimulation: true, email: true },
  });
  if (!user) throw new SimulationNotAllowedError("User not found");
  if (!user.allowSimulation) {
    throw new SimulationNotAllowedError(
      `User ${user.email} does not have allowSimulation — enable it manually before simulating`,
    );
  }
}

function parseClosedAtIst(raw: string | undefined, fallback: Date): Date {
  if (raw && raw.trim()) {
    const probe = new Date(`${raw.trim()}T12:00:00.000Z`);
    if (!Number.isNaN(probe.getTime())) {
      return startOfDayInTimeZone(probe, DASHBOARD_PNL_DAY_TIMEZONE);
    }
  }
  return fallback;
}

function scenarioTargets(
  scenario: SimulationScenario,
  override: number | undefined,
): number[] {
  if (scenario === "PROFIT") return [override ?? 100];
  if (scenario === "LOSS") return [override ?? -50];
  return override != null
    ? [override, -override * 0.4, override * 0.6]
    : [120, -45, 80];
}

async function nextSimStructureId(
  prisma: PrismaClient,
  userId: string,
): Promise<number> {
  const maxRow = await prisma.structurePnl.findFirst({
    where: { userId, botStructureId: { gte: SIM_BOT_STRUCTURE_ID_BASE } },
    orderBy: { botStructureId: "desc" },
    select: { botStructureId: true },
  });
  return maxRow ? maxRow.botStructureId + 1 : SIM_BOT_STRUCTURE_ID_BASE;
}

type SimLegSpec = {
  botLegId: number;
  productId: number;
  symbol: string;
  legRole: string;
  side: string;
  openedAt: Date;
  closedAt: Date;
  grossCashflow: Prisma.Decimal;
  commissionTotal: Prisma.Decimal;
};

function buildLegLedgerAmounts(
  targetRealized: number,
  productBase: number,
  openedAt: Date,
  closedAt: Date,
): {
  legs: SimLegSpec[];
  ledgerRows: Array<{
    productId: number;
    type: "cashflow" | "commission";
    amount: Prisma.Decimal;
    occurredAt: Date;
  }>;
} {
  const halfGross = targetRealized * 0.525;
  const halfComm = -Math.abs(targetRealized * 0.025);

  const legs: SimLegSpec[] = [
    {
      botLegId: 1,
      productId: productBase + 1,
      symbol: `${SIM_SYMBOL_PREFIX}BTC-C`,
      legRole: "short_call",
      side: "sell",
      openedAt,
      closedAt,
      grossCashflow: dec(halfGross),
      commissionTotal: dec(halfComm),
    },
    {
      botLegId: 2,
      productId: productBase + 2,
      symbol: `${SIM_SYMBOL_PREFIX}BTC-P`,
      legRole: "short_put",
      side: "sell",
      openedAt,
      closedAt,
      grossCashflow: dec(halfGross),
      commissionTotal: dec(halfComm),
    },
  ];

  const ledgerRows: Array<{
    productId: number;
    type: "cashflow" | "commission";
    amount: Prisma.Decimal;
    occurredAt: Date;
  }> = [];

  for (const leg of legs) {
    ledgerRows.push({
      productId: leg.productId,
      type: "cashflow",
      amount: leg.grossCashflow,
      occurredAt: new Date(openedAt.getTime() + 1000),
    });
    ledgerRows.push({
      productId: leg.productId,
      type: "commission",
      amount: leg.commissionTotal,
      occurredAt: closedAt,
    });
  }

  return { legs, ledgerRows };
}

async function assertSimulationSlotsFree(
  prisma: PrismaClient,
  userId: string,
  snapshotDate: Date,
  periodYear: number,
  periodMonth: number,
): Promise<void> {
  const [realSnapshot, realInvoice] = await Promise.all([
    prisma.dailyPnlSnapshot.findFirst({
      where: { userId, snapshotDate, isSimulated: false },
      select: { id: true },
    }),
    prisma.monthlyRevenueInvoice.findFirst({
      where: {
        userId,
        periodYear,
        periodMonth,
        isSimulated: false,
      },
      select: { id: true },
    }),
  ]);

  if (realSnapshot) {
    throw new SimulationNotAllowedError(
      `Real daily snapshot already exists for ${snapshotDate.toISOString().slice(0, 10)} — ` +
        `pick a closedAtIst date with no real snapshot activity`,
    );
  }
  if (realInvoice) {
    throw new SimulationNotAllowedError(
      `Real monthly invoice already exists for ${periodYear}-${String(periodMonth).padStart(2, "0")} — ` +
        `pick a month with no real invoice row`,
    );
  }

  await prisma.dailyPnlSnapshot.deleteMany({
    where: { userId, snapshotDate, isSimulated: true },
  });
  await prisma.monthlyRevenueInvoice.deleteMany({
    where: { userId, periodYear, periodMonth, isSimulated: true },
  });
}

async function writeSimulatedStructure(
  prisma: PrismaClient,
  args: {
    userId: string;
    botStructureId: number;
    targetRealized: number;
    closedAt: Date;
  },
) {
  const openedAt = new Date(args.closedAt.getTime() - 3_600_000);
  const productBase =
    SIM_PRODUCT_ID_BASE + (args.botStructureId - SIM_BOT_STRUCTURE_ID_BASE) * 10;
  const { legs: legSpecs, ledgerRows } = buildLegLedgerAmounts(
    args.targetRealized,
    productBase,
    openedAt,
    args.closedAt,
  );

  for (const row of ledgerRows) {
    const leg =
      legSpecs.find((l) => l.productId === row.productId) ?? legSpecs[0]!;
    await prisma.deltaLedgerEntry.create({
      data: {
        userId: args.userId,
        deltaUuid: `sim-${randomUUID()}`,
        productId: row.productId,
        productSymbol: leg.symbol,
        transactionType: row.type,
        amount: row.amount,
        occurredAt: row.occurredAt,
        isSimulated: true,
        metaJson: { simulated: true, botStructureId: args.botStructureId },
      },
    });
  }

  const structGross = legSpecs.reduce((s, l) => s.add(l.grossCashflow), zero());
  const structCommission = legSpecs.reduce(
    (s, l) => s.add(l.commissionTotal),
    zero(),
  );
  const realized = structGross.add(structCommission);

  const structureRow = await prisma.structurePnl.create({
    data: {
      userId: args.userId,
      botStructureId: args.botStructureId,
      hedgePositionId: args.botStructureId,
      underlying: "BTC",
      status: "closed",
      openedAt,
      closedAt: args.closedAt,
      closeReason: "SIMULATED",
      grossCashflow: structGross,
      commissionTotal: structCommission,
      realizedPnl: realized,
      legCount: legSpecs.length,
      closedLegCount: legSpecs.length,
      matchedTxnCount: ledgerRows.length,
      computedAt: new Date(),
      attributionStatus: ATTRIBUTION_STATUS.OK,
      attributionNote: null,
      isSimulated: true,
    },
  });

  for (const leg of legSpecs) {
    await prisma.structureLegPnl.create({
      data: {
        structurePnlId: structureRow.id,
        botLegId: leg.botLegId,
        legRole: leg.legRole,
        productId: leg.productId,
        symbol: leg.symbol,
        strike: 95000,
        side: leg.side,
        quantity: 1,
        openedAt: leg.openedAt,
        closedAt: leg.closedAt,
        grossCashflow: leg.grossCashflow,
        commissionTotal: leg.commissionTotal,
        realizedPnl: leg.grossCashflow.add(leg.commissionTotal),
        matchedTxnCount: 2,
        isSimulated: true,
      },
    });
  }

  return {
    botStructureId: args.botStructureId,
    targetRealized: args.targetRealized,
    realized: realized.toNumber(),
    closedAt: args.closedAt.toISOString(),
    ledgerRows: ledgerRows.length,
  };
}

async function triggerSimulatedAffiliateCommissions(
  prisma: PrismaClient,
  userId: string,
  appRevenueBase: number,
  profitDate: Date,
  strategyId: string,
) {
  const pnlRecord = await prisma.pnLRecord.create({
    data: {
      userId,
      strategyId,
      profitAmount: appRevenueBase,
      commissionAmount: appRevenueBase,
      isSimulated: true,
    },
  });

  const dist = await distributeRevenueShareCommissions(prisma, {
    sourceUserId: userId,
    pnlRecordId: pnlRecord.id,
    appRevenueBase,
    profitDate,
    isSimulated: true,
  });

  return {
    created: dist.created,
    skipped: dist.skipped,
    pnlRecordId: pnlRecord.id,
  };
}

export async function simulateDeltaRevenueStructure(
  prisma: PrismaClient,
  input: SimulateStructureInput,
) {
  await assertUserAllowsSimulation(prisma, input.userId);

  console.warn(
    `[Simulation] RUN user=${input.userId} scenario=${input.scenario} ` +
      `realizedPnl=${input.realizedPnl ?? "default"} closedAtIst=${input.closedAtIst ?? "today"}`,
  );

  const sub = await prisma.userStrategySubscription.findFirst({
    where: {
      userId: input.userId,
      strategy: {
        AND: [
          { botStrategyType: { not: null } },
          { NOT: { botStrategyType: "" } },
        ],
      },
    },
    orderBy: { joinedDate: "desc" },
    select: { strategyId: true },
  });
  if (!sub) {
    throw new SimulationNotAllowedError(
      "User has no bot-strategy subscription for affiliate chain testing",
    );
  }

  const targets = scenarioTargets(input.scenario, input.realizedPnl);
  const structures: Array<Record<string, unknown>> = [];
  let lastSnapshotDate: Date | null = null;
  let lastPeriod: { year: number; month: number } | null = null;

  for (let i = 0; i < targets.length; i += 1) {
    const target = targets[i]!;
    const closedAtBase = parseClosedAtIst(
      input.closedAtIst,
      startOfDayInTimeZone(new Date(), DASHBOARD_PNL_DAY_TIMEZONE),
    );
    const structureClosedAt = new Date(
      closedAtBase.getTime() + i * 86_400_000 + 12 * 3_600_000,
    );

    const botStructureId = await nextSimStructureId(prisma, input.userId);
    structures.push(
      await writeSimulatedStructure(prisma, {
        userId: input.userId,
        botStructureId,
        targetRealized: target,
        closedAt: structureClosedAt,
      }),
    );

    const snapshotDate = startOfDayInTimeZone(
      structureClosedAt,
      DASHBOARD_PNL_DAY_TIMEZONE,
    );
    const istParts = calendarPartsInTimeZone(
      structureClosedAt,
      DASHBOARD_PNL_DAY_TIMEZONE,
    );

    await assertSimulationSlotsFree(
      prisma,
      input.userId,
      snapshotDate,
      istParts.year,
      istParts.month,
    );

    await runDailyPnlSnapshots(prisma, {
      userId: input.userId,
      date: snapshotDate.toISOString().slice(0, 10),
    });
    await prisma.dailyPnlSnapshot.updateMany({
      where: { userId: input.userId, snapshotDate },
      data: { isSimulated: true },
    });

    const invoice = await computeMonthlyRevenueInvoiceForUser(
      prisma,
      input.userId,
      istParts.year,
      istParts.month,
      { isSimulated: true },
    );
    await prisma.monthlyRevenueInvoice.update({
      where: { id: invoice.id },
      data: { isSimulated: true },
    });

    lastSnapshotDate = snapshotDate;
    lastPeriod = { year: istParts.year, month: istParts.month };
  }

  let affiliate: Record<string, unknown> | null = null;
  if (lastPeriod && lastSnapshotDate) {
    const inv = await prisma.monthlyRevenueInvoice.findUnique({
      where: {
        userId_periodYear_periodMonth: {
          userId: input.userId,
          periodYear: lastPeriod.year,
          periodMonth: lastPeriod.month,
        },
      },
    });
    const commission = inv?.commissionAmount.toNumber() ?? 0;
    if (commission > 0) {
      affiliate = await triggerSimulatedAffiliateCommissions(
        prisma,
        input.userId,
        commission,
        lastSnapshotDate,
        sub.strategyId,
      );
    }
  }

  return {
    ok: true,
    scenario: input.scenario,
    structures,
    affiliate,
    chain: await getSimulationChainState(prisma, input.userId, true),
  };
}

export async function getSimulationChainState(
  prisma: PrismaClient,
  userId: string,
  simulatedOnly = true,
) {
  const simFilter = simulatedOnly ? { isSimulated: true } : { isSimulated: false };

  const [ledgerCount, ledgerSample, structures, snapshots, invoices, commissions] =
    await Promise.all([
      prisma.deltaLedgerEntry.count({ where: { userId, ...simFilter } }),
      prisma.deltaLedgerEntry.findMany({
        where: { userId, ...simFilter },
        orderBy: { occurredAt: "desc" },
        take: 12,
        select: {
          id: true,
          productId: true,
          productSymbol: true,
          transactionType: true,
          amount: true,
          occurredAt: true,
          isSimulated: true,
        },
      }),
      prisma.structurePnl.findMany({
        where: { userId, ...simFilter },
        orderBy: { closedAt: "desc" },
        take: 10,
        include: { legs: true },
      }),
      prisma.dailyPnlSnapshot.findMany({
        where: { userId, ...simFilter },
        orderBy: { snapshotDate: "asc" },
        take: 30,
      }),
      prisma.monthlyRevenueInvoice.findMany({
        where: { userId, ...simFilter },
        orderBy: [{ periodYear: "desc" }, { periodMonth: "desc" }],
        take: 6,
      }),
      prisma.commissionLedger.findMany({
        where: { sourceUserId: userId, ...simFilter },
        orderBy: { earnedAt: "desc" },
        take: 20,
      }),
    ]);

  return {
    ledgerRowCount: ledgerCount,
    ledgerSample: ledgerSample.map((row) => ({
      id: row.id,
      productId: row.productId,
      productSymbol: row.productSymbol,
      transactionType: row.transactionType,
      amount: row.amount.toNumber(),
      occurredAt: row.occurredAt.toISOString(),
      isSimulated: row.isSimulated,
    })),
    structures: structures.map((s) => ({
      botStructureId: s.botStructureId,
      status: s.status,
      realizedPnl: s.realizedPnl?.toNumber() ?? null,
      isSimulated: s.isSimulated,
      closedAt: s.closedAt?.toISOString() ?? null,
      legs: s.legs.length,
    })),
    snapshots: snapshots.map((s) => ({
      snapshotDate: s.snapshotDate.toISOString(),
      realizedDelta: s.realizedDelta.toNumber(),
      cumulativeRealized: s.cumulativeRealized.toNumber(),
      highWaterMark: s.highWaterMark.toNumber(),
      commissionAccrued: s.commissionAccrued.toNumber(),
      isSimulated: s.isSimulated,
    })),
    invoices: invoices.map((inv) => ({
      periodYear: inv.periodYear,
      periodMonth: inv.periodMonth,
      billableProfit: inv.billableProfit.toNumber(),
      commissionAmount: inv.commissionAmount.toNumber(),
      status: inv.status,
      isSimulated: inv.isSimulated,
    })),
    affiliateCommissions: commissions.map((c) => ({
      id: c.id,
      beneficiaryUserId: c.beneficiaryUserId,
      amount: c.amount,
      status: c.status,
      isSimulated: c.isSimulated,
    })),
  };
}

export async function purgeSimulatedDeltaRevenue(
  prisma: PrismaClient,
  userId?: string,
) {
  const userFilter = userId ? { userId } : {};

  const blocked = await prisma.monthlyRevenueInvoice.findFirst({
    where: {
      isSimulated: true,
      status: { in: ["INVOICED", "PAID"] },
      ...userFilter,
    },
    select: { id: true, status: true },
  });
  if (blocked) {
    throw new SimulationPurgeBlockedError(
      `Refusing purge: simulated invoice ${blocked.id} is ${blocked.status}`,
    );
  }

  console.warn(`[Simulation] PURGE user=${userId ?? "ALL"}`);

  const affectedUsers = userId
    ? [userId]
    : (
        await prisma.structurePnl.findMany({
          where: { isSimulated: true },
          select: { userId: true },
          distinct: ["userId"],
        })
      ).map((r) => r.userId);

  const deleted = {
    commissionLedger: (
      await prisma.commissionLedger.deleteMany({
        where: { isSimulated: true, ...(userId ? { sourceUserId: userId } : {}) },
      })
    ).count,
    pnlRecords: (
      await prisma.pnLRecord.deleteMany({
        where: { isSimulated: true, ...userFilter },
      })
    ).count,
    monthlyRevenueInvoices: (
      await prisma.monthlyRevenueInvoice.deleteMany({
        where: { isSimulated: true, ...userFilter },
      })
    ).count,
    dailyPnlSnapshots: (
      await prisma.dailyPnlSnapshot.deleteMany({
        where: { isSimulated: true, ...userFilter },
      })
    ).count,
    structureLegPnl: (
      await prisma.structureLegPnl.deleteMany({
        where: { isSimulated: true, ...(userId ? { structure: { userId } } : {}) },
      })
    ).count,
    structurePnl: (
      await prisma.structurePnl.deleteMany({
        where: { isSimulated: true, ...userFilter },
      })
    ).count,
    deltaLedgerEntries: (
      await prisma.deltaLedgerEntry.deleteMany({
        where: { isSimulated: true, ...userFilter },
      })
    ).count,
  };

  for (const uid of affectedUsers) {
    await recomputeStructurePnlForUsers(prisma, { userId: uid });
    const realSnapshots = await prisma.dailyPnlSnapshot.findMany({
      where: { userId: uid, isSimulated: false },
      select: { snapshotDate: true },
    });
    for (const snap of realSnapshots) {
      await runDailyPnlSnapshots(prisma, {
        userId: uid,
        date: snap.snapshotDate.toISOString().slice(0, 10),
      });
    }
    const nowParts = calendarPartsInTimeZone(new Date(), DASHBOARD_PNL_DAY_TIMEZONE);
    await computeMonthlyRevenueInvoiceForUser(
      prisma,
      uid,
      nowParts.year,
      nowParts.month,
    );
  }

  return { ok: true, userId: userId ?? null, deleted, affectedUsers };
}
