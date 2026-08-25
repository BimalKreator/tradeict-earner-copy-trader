import { Prisma, Role, SubscriptionStatus } from "@prisma/client";
import { ATTRIBUTION_STATUS } from "../../../services/structurePnlService.js";
import { computeMonthlyRevenueInvoiceForUser } from "../../../services/structureRevenueService.js";
import { TEST_ID_PREFIX } from "../fixtures.js";
import type { HarnessScenario } from "../types.js";

export const p11CancelledFinalInvoiceScenario: HarnessScenario = {
  name: "p11-cancelled-final-invoice",
  async run(ctx) {
    const { prisma, assert, fixtures } = ctx;
    const user = await fixtures.createTestUser(TEST_ID_PREFIX, Role.USER);

    let strategy = await prisma.strategy.findFirst({
      where: {
        AND: [
          { botStrategyType: { not: null } },
          { NOT: { botStrategyType: "" } },
        ],
      },
      select: { id: true, profitShare: true },
    });

    if (!strategy) {
      strategy = await prisma.strategy.create({
        data: {
          title: `${TEST_ID_PREFIX}bot-strategy`,
          description: "Harness bot strategy",
          monthlyFee: 0,
          profitShare: 20,
          minCapital: 100,
          botStrategyType: "short_strangle",
          isActive: true,
        },
        select: { id: true, profitShare: true },
      });
    }

    const snapshotPct = new Prisma.Decimal(17.5);
    await prisma.userStrategySubscription.create({
      data: {
        userId: user.id,
        strategyId: strategy.id,
        isActive: false,
        status: SubscriptionStatus.CANCELLED,
        profitSharePctSnapshot: snapshotPct,
        profitShareOverride: null,
        joinedDate: new Date(Date.UTC(2026, 0, 1)),
      },
    });

    const periodYear = 2026;
    const periodMonth = 5;
    const closedAt = new Date(Date.UTC(periodYear, periodMonth - 1, 15, 12));

    await prisma.structurePnl.create({
      data: {
        userId: user.id,
        botStructureId: 9_100_001,
        hedgePositionId: 9_100_001,
        underlying: "BTC",
        status: "closed",
        openedAt: new Date(closedAt.getTime() - 3_600_000),
        closedAt,
        grossCashflow: new Prisma.Decimal(100),
        commissionTotal: new Prisma.Decimal(0),
        realizedPnl: new Prisma.Decimal(100),
        legCount: 1,
        closedLegCount: 1,
        matchedTxnCount: 1,
        computedAt: new Date(),
        attributionStatus: ATTRIBUTION_STATUS.OK,
        isSimulated: false,
      },
    });

    const invoice = await computeMonthlyRevenueInvoiceForUser(
      prisma,
      user.id,
      periodYear,
      periodMonth,
    );

    assert.equal(invoice.isSimulated, false, "final invoice is real");
    assert.near(
      invoice.profitSharePct.toNumber(),
      17.5,
      "cancelled subscription priced from profitSharePctSnapshot",
    );
    assert.assert(
      invoice.commissionAmount.gt(0),
      "final invoice carries a positive commission",
    );
  },
};
