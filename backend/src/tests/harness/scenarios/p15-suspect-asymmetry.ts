import { Prisma, Role, SubscriptionStatus } from "@prisma/client";
import { ATTRIBUTION_STATUS } from "../../../services/structurePnlService.js";
import {
  boundedWorstCasePnl,
  computeMonthlyRevenueInvoiceForUser,
  structureCumulativeContribution,
} from "../../../services/structureRevenueService.js";
import { TEST_ID_PREFIX } from "../fixtures.js";
import type { HarnessScenario } from "../types.js";

/** Hand-verified Delta ledger anchors — must never move. */
const REF_STRUCTURE_2 = {
  botStructureId: 2,
  realizedPnl: "-0.3074494500",
  matchedTxnCount: 24,
  attributionStatus: "OK",
} as const;

const REF_STRUCTURE_4 = {
  botStructureId: 4,
  realizedPnl: "-0.2964989500",
  matchedTxnCount: 24,
  attributionStatus: "OK",
} as const;

/**
 * 15.1 / 15.2 — suspect structures use a bounded worst-case P&L so incomplete
 * "gains" never raise the HWM, while possible losses still lower it.
 */
export const p15SuspectAsymmetryScenario: HarnessScenario = {
  name: "p15-suspect-asymmetry",
  async run(ctx) {
    const { prisma, assert, fixtures } = ctx;

    // --- REGRESSION GUARD: real reference structures (read-only) ---
    const ref2 = await prisma.structurePnl.findFirst({
      where: {
        botStructureId: REF_STRUCTURE_2.botStructureId,
        isSimulated: false,
      },
      select: {
        realizedPnl: true,
        matchedTxnCount: true,
        attributionStatus: true,
      },
      orderBy: { computedAt: "desc" },
    });
    assert.assert(ref2 != null, "reference structure 2 exists");
    assert.equal(
      ref2!.realizedPnl?.toFixed(10) ?? null,
      REF_STRUCTURE_2.realizedPnl,
      "reference structure 2 realizedPnl unchanged",
    );
    assert.equal(
      ref2!.matchedTxnCount,
      REF_STRUCTURE_2.matchedTxnCount,
      "reference structure 2 matchedTxnCount unchanged",
    );
    assert.equal(
      ref2!.attributionStatus,
      REF_STRUCTURE_2.attributionStatus,
      "reference structure 2 attributionStatus OK",
    );

    const ref4 = await prisma.structurePnl.findFirst({
      where: {
        botStructureId: REF_STRUCTURE_4.botStructureId,
        isSimulated: false,
      },
      select: {
        realizedPnl: true,
        matchedTxnCount: true,
        attributionStatus: true,
      },
      orderBy: { computedAt: "desc" },
    });
    assert.assert(ref4 != null, "reference structure 4 exists");
    assert.equal(
      ref4!.realizedPnl?.toFixed(10) ?? null,
      REF_STRUCTURE_4.realizedPnl,
      "reference structure 4 realizedPnl unchanged",
    );
    assert.equal(
      ref4!.matchedTxnCount,
      REF_STRUCTURE_4.matchedTxnCount,
      "reference structure 4 matchedTxnCount unchanged",
    );
    assert.equal(
      ref4!.attributionStatus,
      REF_STRUCTURE_4.attributionStatus,
      "reference structure 4 attributionStatus OK",
    );

    // Unit check of the bound itself
    const bounded = boundedWorstCasePnl(
      new Prisma.Decimal(300),
      new Prisma.Decimal(800),
    );
    assert.near(bounded.toNumber(), -500, "bounded worst case: +300 with 800 dropped → -500");

    const user = await fixtures.createTestUser(
      `${TEST_ID_PREFIX}P15-SUS`,
      Role.USER,
    );

    let strategy = await prisma.strategy.findFirst({
      where: {
        AND: [
          { botStrategyType: { not: null } },
          { NOT: { botStrategyType: "" } },
        ],
      },
      select: { id: true },
    });
    if (!strategy) {
      strategy = await prisma.strategy.create({
        data: {
          title: `${TEST_ID_PREFIX}bot-strategy-p15`,
          description: "Harness bot strategy",
          monthlyFee: 0,
          profitShare: 20,
          minCapital: 100,
          botStrategyType: "short_strangle",
          isActive: true,
        },
        select: { id: true },
      });
    }

    await prisma.userStrategySubscription.create({
      data: {
        userId: user.id,
        strategyId: strategy.id,
        isActive: true,
        status: SubscriptionStatus.ACTIVE,
        profitSharePctSnapshot: new Prisma.Decimal(20),
        joinedDate: new Date(Date.UTC(2026, 0, 1)),
      },
    });

    const periodYear = 2026;
    const periodMonth = 7;
    const closedAt = new Date(Date.UTC(periodYear, periodMonth - 1, 12, 12));

    // Incomplete "gain" with dropped loss rows — must lower HWM, never bill.
    await prisma.structurePnl.create({
      data: {
        userId: user.id,
        botStructureId: 9_150_001,
        hedgePositionId: 9_150_001,
        underlying: "BTC",
        status: "closed",
        openedAt: new Date(closedAt.getTime() - 3_600_000),
        closedAt,
        grossCashflow: new Prisma.Decimal(300),
        commissionTotal: new Prisma.Decimal(0),
        realizedPnl: new Prisma.Decimal(300),
        attributionDroppedAmount: new Prisma.Decimal(800),
        legCount: 2,
        closedLegCount: 2,
        matchedTxnCount: 4,
        computedAt: new Date(),
        attributionStatus: ATTRIBUTION_STATUS.SUSPECT_INCOMPLETE,
        attributionNote: "overlap: dropped rows abs=800",
        isSimulated: false,
      },
    });

    // Closed structure with one open leg — partial loss, never null-and-forget.
    await prisma.structurePnl.create({
      data: {
        userId: user.id,
        botStructureId: 9_150_002,
        hedgePositionId: 9_150_002,
        underlying: "BTC",
        status: "closed",
        openedAt: new Date(closedAt.getTime() - 7_200_000),
        closedAt: new Date(closedAt.getTime() - 60_000),
        grossCashflow: new Prisma.Decimal(-40),
        commissionTotal: new Prisma.Decimal(-10),
        realizedPnl: new Prisma.Decimal(-50),
        attributionDroppedAmount: null,
        legCount: 2,
        closedLegCount: 1,
        matchedTxnCount: 2,
        computedAt: new Date(),
        attributionStatus: ATTRIBUTION_STATUS.SUSPECT_INCOMPLETE,
        attributionNote: "closed structure has open leg(s): [2]",
        isSimulated: false,
      },
    });

    // Clean structure — unaffected.
    await prisma.structurePnl.create({
      data: {
        userId: user.id,
        botStructureId: 9_150_003,
        hedgePositionId: 9_150_003,
        underlying: "BTC",
        status: "closed",
        openedAt: new Date(closedAt.getTime() - 10_800_000),
        closedAt: new Date(closedAt.getTime() - 120_000),
        grossCashflow: new Prisma.Decimal(25),
        commissionTotal: new Prisma.Decimal(0),
        realizedPnl: new Prisma.Decimal(25),
        attributionDroppedAmount: null,
        legCount: 2,
        closedLegCount: 2,
        matchedTxnCount: 8,
        computedAt: new Date(),
        attributionStatus: ATTRIBUTION_STATUS.OK,
        isSimulated: false,
      },
    });

    const contribSuspectGain = structureCumulativeContribution({
      realizedPnl: new Prisma.Decimal(300),
      attributionStatus: ATTRIBUTION_STATUS.SUSPECT_INCOMPLETE,
      attributionDroppedAmount: new Prisma.Decimal(800),
    });
    assert.assert(
      contribSuspectGain != null && contribSuspectGain.lessThan(0),
      "+300 with 800 dropped contributes a loss to cumulative",
    );
    assert.near(
      contribSuspectGain!.toNumber(),
      -500,
      "cumulative contribution is bounded -500 (not +300)",
    );

    const contribOpenLeg = structureCumulativeContribution({
      realizedPnl: new Prisma.Decimal(-50),
      attributionStatus: ATTRIBUTION_STATUS.SUSPECT_INCOMPLETE,
      attributionDroppedAmount: null,
    });
    assert.assert(
      contribOpenLeg != null && contribOpenLeg.eq(-50),
      "open-leg closed structure loss is included in cumulative",
    );

    const invoice = await computeMonthlyRevenueInvoiceForUser(
      prisma,
      user.id,
      periodYear,
      periodMonth,
    );

    assert.equal(
      invoice.structuresClosed,
      1,
      "only the clean structure is billable",
    );
    assert.near(
      invoice.realizedPnl.toNumber(),
      25,
      "billable month realized is clean +25 only",
    );
    assert.assert(
      (invoice.suspectStructuresCount ?? 0) >= 2,
      "both suspect structures are counted",
    );
    assert.assert(
      (invoice.suspectLossesCountedCount ?? 0) >= 2,
      "both suspect losses counted into cumulative/HWM",
    );

    // Cumulative = clean +25 + bounded(-500) + open-leg(-50) = -525
    assert.assert(
      invoice.cumulativeRealizedPnl != null,
      "cumulativeRealizedPnl is set",
    );
    assert.near(
      invoice.cumulativeRealizedPnl!.toNumber(),
      -525,
      "cumulative/HWM moves DOWN (bounded suspects + clean), never up on +300",
    );
    assert.assert(
      invoice.cumulativeRealizedPnl!.lt(0),
      "cumulative is negative — HWM path absorbed the bounded loss",
    );
    assert.assert(
      invoice.billableProfit.eq(0) || invoice.billableProfit.lte(0),
      "incomplete +300 is never billed as a gain",
    );
  },
};
