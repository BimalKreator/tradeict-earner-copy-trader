import { Prisma, Role } from "@prisma/client";
import {
  DASHBOARD_PNL_DAY_TIMEZONE,
  startOfDayInTimeZone,
} from "../../../services/dashboardMetricsService.js";
import {
  computeDailyPnlSnapshotForUser,
  computeMonthlyRevenueInvoiceForUser,
} from "../../../services/structureRevenueService.js";
import {
  INVOICE_STATUS,
  transitionMonthlyRevenueInvoiceStatus,
} from "../../../services/monthlyRevenueInvoiceLifecycleService.js";
import { TEST_ID_PREFIX } from "../fixtures.js";
import type { HarnessScenario } from "../types.js";

export const p11SimulationIsolationScenario: HarnessScenario = {
  name: "p11-simulation-isolation",
  async run(ctx) {
    const { prisma, assert, fixtures } = ctx;
    const user = await fixtures.createTestUser(TEST_ID_PREFIX, Role.USER);

    const periodYear = 2026;
    const periodMonth = 6;

    const simInvoice = await computeMonthlyRevenueInvoiceForUser(
      prisma,
      user.id,
      periodYear,
      periodMonth,
      { isSimulated: true },
    );
    assert.equal(simInvoice.isSimulated, true, "simulated invoice stamped");
    assert.equal(
      simInvoice.status,
      INVOICE_STATUS.ACCRUED,
      "simulated invoice ACCRUED",
    );

    const realInvoice = await computeMonthlyRevenueInvoiceForUser(
      prisma,
      user.id,
      periodYear,
      periodMonth,
    );
    assert.equal(realInvoice.isSimulated, false, "real invoice not simulated");
    assert.assert(
      realInvoice.id !== simInvoice.id,
      "real and simulated invoices are different rows",
    );

    const issued = await transitionMonthlyRevenueInvoiceStatus(
      prisma,
      realInvoice.id,
      INVOICE_STATUS.INVOICED,
      { usdInrRate: 85 },
    );
    assert.equal(issued.status, INVOICE_STATUS.INVOICED, "real invoice issued");

    const simStill = await prisma.monthlyRevenueInvoice.findUniqueOrThrow({
      where: { id: simInvoice.id },
    });
    assert.equal(
      simStill.status,
      INVOICE_STATUS.ACCRUED,
      "simulated invoice untouched by real issue",
    );
    assert.equal(simStill.isSimulated, true, "simulated flag preserved");

    const day1 = startOfDayInTimeZone(
      new Date(Date.UTC(2026, 5, 10)),
      DASHBOARD_PNL_DAY_TIMEZONE,
    );
    const day2 = startOfDayInTimeZone(
      new Date(Date.UTC(2026, 5, 11)),
      DASHBOARD_PNL_DAY_TIMEZONE,
    );

    await prisma.dailyPnlSnapshot.create({
      data: {
        userId: user.id,
        snapshotDate: day1,
        realizedDelta: new Prisma.Decimal(500),
        cumulativeRealized: new Prisma.Decimal(500),
        highWaterMark: new Prisma.Decimal(500),
        commissionAccrued: new Prisma.Decimal(0),
        commissionCumulative: new Prisma.Decimal(0),
        openStructureCount: 0,
        computedAt: new Date(),
        isSimulated: true,
      },
    });

    const realDay2 = await computeDailyPnlSnapshotForUser(
      prisma,
      user.id,
      day2,
    );
    assert.equal(realDay2.isSimulated, false, "real daily snapshot stamped");
    assert.near(
      realDay2.cumulativeRealized.toNumber(),
      0,
      "real chain does not inherit simulated cumulative",
    );
    assert.near(
      realDay2.highWaterMark.toNumber(),
      0,
      "real chain does not inherit simulated HWM",
    );

    const bothDay1 = await prisma.dailyPnlSnapshot.findMany({
      where: { userId: user.id, snapshotDate: day1 },
    });
    assert.equal(
      bothDay1.filter((row) => row.isSimulated).length,
      1,
      "simulated day1 snapshot remains",
    );
  },
};
