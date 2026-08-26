import { Prisma, Role, SubscriptionStatus } from "@prisma/client";
import {
  DASHBOARD_PNL_DAY_TIMEZONE,
  startOfDayInTimeZone,
} from "../../../services/dashboardMetricsService.js";
import { computeDailyPnlSnapshotForUser } from "../../../services/structureRevenueService.js";
import { TEST_ID_PREFIX } from "../fixtures.js";
import type { HarnessScenario } from "../types.js";

const BILLING_TZ = DASHBOARD_PNL_DAY_TIMEZONE;
const MS_PER_DAY = 86_400_000;

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
 * 15.5b — daily snapshot chain survives gaps: look up most recent prior
 * snapshot (not exactly yesterday), and seed from lifetime HWM/cumulative
 * when none exists.
 */
export const p15SnapshotChainScenario: HarnessScenario = {
  name: "p15-snapshot-chain",
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

    const userGap = await fixtures.createTestUser(
      `${TEST_ID_PREFIX}P15-SNAP-GAP`,
      Role.USER,
    );
    const userSeed = await fixtures.createTestUser(
      `${TEST_ID_PREFIX}P15-SNAP-SEED`,
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
          title: `${TEST_ID_PREFIX}bot-strategy-p15-snap`,
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

    for (const user of [userGap, userSeed]) {
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
    }

    // Anchor days in IST calendar space (far from live data collisions).
    const day1 = startOfDayInTimeZone(
      new Date(Date.UTC(2026, 2, 10, 12, 0, 0)),
      BILLING_TZ,
    );
    const day3 = startOfDayInTimeZone(
      new Date(day1.getTime() + 2 * MS_PER_DAY),
      BILLING_TZ,
    );

    // --- Gap: prior snapshot exists, middle day missing ---
    await prisma.dailyPnlSnapshot.create({
      data: {
        userId: userGap.id,
        snapshotDate: day1,
        realizedDelta: new Prisma.Decimal(3000),
        cumulativeRealized: new Prisma.Decimal(3000),
        highWaterMark: new Prisma.Decimal(3000),
        commissionAccrued: new Prisma.Decimal(0),
        commissionCumulative: new Prisma.Decimal(0),
        openStructureCount: 0,
        computedAt: new Date(),
        isSimulated: false,
      },
    });

    // Structure closed on day3 (+400) — day2 intentionally has no snapshot.
    const day3Close = new Date(day3.getTime() + 6 * 60 * 60 * 1000);
    await prisma.structurePnl.create({
      data: {
        userId: userGap.id,
        botStructureId: 9_155_001,
        hedgePositionId: 9_155_001,
        underlying: "BTC",
        status: "closed",
        openedAt: new Date(day3Close.getTime() - 3_600_000),
        closedAt: day3Close,
        grossCashflow: new Prisma.Decimal(400),
        commissionTotal: new Prisma.Decimal(0),
        realizedPnl: new Prisma.Decimal(400),
        legCount: 2,
        closedLegCount: 2,
        matchedTxnCount: 4,
        computedAt: new Date(),
        attributionStatus: "OK",
        isSimulated: false,
      },
    });

    const afterGap = await computeDailyPnlSnapshotForUser(
      prisma,
      userGap.id,
      day3,
      { isSimulated: false },
    );
    assert.near(
      afterGap.cumulativeRealized.toNumber(),
      3400,
      "gap day continues from last known cumulative 3000 + 400, not from zero",
    );
    assert.near(
      afterGap.highWaterMark.toNumber(),
      3400,
      "gap day HWM continues from last known 3000, not reset to 400",
    );

    // --- No snapshots at all: seed from lifetime structures, not zero ---
    const beforeSeedDay = startOfDayInTimeZone(
      new Date(Date.UTC(2026, 2, 1, 12, 0, 0)),
      BILLING_TZ,
    );
    const seedDay = startOfDayInTimeZone(
      new Date(Date.UTC(2026, 2, 5, 12, 0, 0)),
      BILLING_TZ,
    );
    await prisma.structurePnl.create({
      data: {
        userId: userSeed.id,
        botStructureId: 9_155_002,
        hedgePositionId: 9_155_002,
        underlying: "BTC",
        status: "closed",
        openedAt: new Date(beforeSeedDay.getTime() - 86_400_000),
        closedAt: new Date(beforeSeedDay.getTime() + 3_600_000),
        grossCashflow: new Prisma.Decimal(2500),
        commissionTotal: new Prisma.Decimal(0),
        realizedPnl: new Prisma.Decimal(2500),
        legCount: 2,
        closedLegCount: 2,
        matchedTxnCount: 4,
        computedAt: new Date(),
        attributionStatus: "OK",
        isSimulated: false,
      },
    });

    const seeded = await computeDailyPnlSnapshotForUser(
      prisma,
      userSeed.id,
      seedDay,
      { isSimulated: false },
    );
    assert.assert(
      seeded.cumulativeRealized.toNumber() >= 2500 - 1e-6,
      "no prior snapshots: cumulative falls back to lifetime (≥2500), not zero",
    );
    assert.assert(
      seeded.highWaterMark.toNumber() >= 2500 - 1e-6,
      "no prior snapshots: HWM falls back via runningHwmBeforeMonthStart, not zero",
    );
  },
};
