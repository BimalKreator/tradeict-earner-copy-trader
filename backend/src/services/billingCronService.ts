import type { Prisma, PrismaClient } from "@prisma/client";
import { SubscriptionStatus } from "@prisma/client";
import { guardedCron } from "../utils/cronGuard.js";
import { raiseAlert } from "../utils/systemAlert.js";
import {
  calendarPartsInTimeZone,
  DASHBOARD_PNL_DAY_TIMEZONE,
} from "./dashboardMetricsService.js";
import { runDeltaLedgerSyncForUsers } from "./deltaLedgerService.js";
import { recomputeStructurePnlForUsers } from "./structurePnlService.js";
import {
  computeMonthlyRevenueInvoiceForUser,
  recomputeInvoiceChain,
} from "./structureRevenueService.js";

const MS_PER_HOUR = 3_600_000;

export function finalInvoiceDelayHours(): number {
  const raw = process.env.FINAL_INVOICE_DELAY_HOURS;
  if (raw != null && raw.trim() !== "") {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 24;
}

export function computeFinalInvoiceScheduledAt(pendingSince: Date): Date {
  return new Date(
    pendingSince.getTime() + finalInvoiceDelayHours() * MS_PER_HOUR,
  );
}

export type FinalInvoiceScheduleInfo = {
  pendingFinalInvoiceSince: string;
  finalInvoiceScheduledAt: string;
  finalInvoiceDelayHours: number;
  periodYear: number;
  periodMonth: number;
};

export async function schedulePendingFinalInvoice(
  prisma: PrismaClient,
  args: {
    userId: string;
    subscriptionId: string;
  },
): Promise<FinalInvoiceScheduleInfo> {
  const now = new Date();
  const parts = calendarPartsInTimeZone(now, DASHBOARD_PNL_DAY_TIMEZONE);

  await prisma.userStrategySubscription.update({
    where: { id: args.subscriptionId },
    data: {
      isActive: false,
      status: SubscriptionStatus.CANCELLED,
    },
  });

  await prisma.user.update({
    where: { id: args.userId },
    data: {
      pendingFinalInvoiceSince: now,
      pendingFinalInvoicePeriodYear: parts.year,
      pendingFinalInvoicePeriodMonth: parts.month,
    },
  });

  const scheduledAt = computeFinalInvoiceScheduledAt(now);
  console.info(
    `[Cancellation] scheduled final invoice user=${args.userId} ` +
      `period=${parts.year}-${String(parts.month).padStart(2, "0")} ` +
      `dueAt=${scheduledAt.toISOString()}`,
  );

  return {
    pendingFinalInvoiceSince: now.toISOString(),
    finalInvoiceScheduledAt: scheduledAt.toISOString(),
    finalInvoiceDelayHours: finalInvoiceDelayHours(),
    periodYear: parts.year,
    periodMonth: parts.month,
  };
}

export async function issuePendingFinalInvoiceForUser(
  prisma: PrismaClient,
  userId: string,
): Promise<{ invoiceId: string } | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      pendingFinalInvoiceSince: true,
      pendingFinalInvoicePeriodYear: true,
      pendingFinalInvoicePeriodMonth: true,
    },
  });
  if (
    !user?.pendingFinalInvoiceSince ||
    user.pendingFinalInvoicePeriodYear == null ||
    user.pendingFinalInvoicePeriodMonth == null
  ) {
    return null;
  }

  await runDeltaLedgerSyncForUsers(prisma, { userId });
  await recomputeStructurePnlForUsers(prisma, { userId });

  const invoice = await computeMonthlyRevenueInvoiceForUser(
    prisma,
    userId,
    user.pendingFinalInvoicePeriodYear,
    user.pendingFinalInvoicePeriodMonth,
  );

  const finalized = invoice.isFinal
    ? invoice
    : await prisma.monthlyRevenueInvoice.update({
        where: { id: invoice.id },
        data: { isFinal: true },
      });

  await prisma.user.update({
    where: { id: userId },
    data: {
      pendingFinalInvoiceSince: null,
      pendingFinalInvoicePeriodYear: null,
      pendingFinalInvoicePeriodMonth: null,
    },
  });

  console.info(
    `[BillingCron] final invoice issued user=${userId} invoice=${finalized.id} ` +
      `period=${finalized.periodYear}-${String(finalized.periodMonth).padStart(2, "0")}`,
  );

  return { invoiceId: finalized.id };
}

type FrozenPeriodAlert = {
  periodYear: number;
  periodMonth: number;
  fields: string[];
  detectedAt: string;
};

export async function appendRevenueFrozenPeriodAlerts(
  prisma: PrismaClient,
  userId: string,
  alerts: Array<{ periodYear: number; periodMonth: number; fields: string[] }>,
): Promise<void> {
  if (alerts.length === 0) return;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { revenueFrozenPeriodAlerts: true },
  });
  const existing = Array.isArray(user?.revenueFrozenPeriodAlerts)
    ? (user!.revenueFrozenPeriodAlerts as FrozenPeriodAlert[])
    : [];

  const now = new Date().toISOString();
  const merged = [...existing];
  for (const alert of alerts) {
    const key = `${alert.periodYear}-${alert.periodMonth}`;
    const hit = merged.find(
      (row) => `${row.periodYear}-${row.periodMonth}` === key,
    );
    if (hit) {
      hit.fields = [...new Set([...hit.fields, ...alert.fields])];
      hit.detectedAt = now;
    } else {
      merged.push({ ...alert, detectedAt: now });
    }
  }

  await prisma.user.update({
    where: { id: userId },
    data: { revenueFrozenPeriodAlerts: merged as Prisma.InputJsonValue },
  });
}

export async function runPendingFinalInvoiceCron(
  prisma: PrismaClient,
): Promise<{ processed: number; skipped: number; errors: number }> {
  const cutoff = new Date(Date.now() - finalInvoiceDelayHours() * MS_PER_HOUR);
  let processed = 0;
  let errors = 0;

  const users = await prisma.user.findMany({
    where: {
      pendingFinalInvoiceSince: { not: null, lte: cutoff },
    },
    select: { id: true },
    orderBy: { pendingFinalInvoiceSince: "asc" },
  });

  for (const user of users) {
    try {
      const result = await issuePendingFinalInvoiceForUser(prisma, user.id);
      if (result) processed += 1;
    } catch (err) {
      errors += 1;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[BillingCron] pending final invoice failed user=${user.id}: ${msg}`,
      );
      await prisma.user.update({
        where: { id: user.id },
        data: {
          pendingFinalInvoiceSince: null,
          pendingFinalInvoicePeriodYear: null,
          pendingFinalInvoicePeriodMonth: null,
        },
      });
      void raiseAlert({
        key: `final-invoice-failed:${user.id}`,
        severity: "CRITICAL",
        source: "billingCron",
        message: `Final invoice permanently failed for user ${user.id}: ${msg}`,
        detail: { userId: user.id, error: msg },
      });
    }
  }

  if (processed > 0 || errors > 0) {
    console.info(
      `[BillingCron] pending final invoice cycle complete eligible=${users.length} processed=${processed} errors=${errors}`,
    );
  } else {
    console.info(
      `[BillingCron] pending final invoice cycle complete eligible=0`,
    );
  }

  return { processed, skipped: users.length - processed - errors, errors };
}

export async function runLateLedgerRecomputeCron(
  prisma: PrismaClient,
): Promise<{
  processed: number;
  frozenAlerts: number;
  errors: number;
}> {
  let processed = 0;
  let frozenAlerts = 0;
  let errors = 0;

  const users = await prisma.user.findMany({
    where: { deltaLedgerRecomputeRequired: true },
    select: { id: true },
    orderBy: { id: "asc" },
  });

  console.info(
    `[BillingCron] late ledger recompute flagged users=${users.length}` +
      ` ids=[${users.map((u) => u.id).join(",")}]`,
  );

  for (const user of users) {
    try {
      await runDeltaLedgerSyncForUsers(prisma, { userId: user.id });
      await recomputeStructurePnlForUsers(prisma, { userId: user.id });
      const result = await recomputeInvoiceChain(prisma, user.id, false);

      if (result.frozenPeriodLateData.length > 0) {
        frozenAlerts += result.frozenPeriodLateData.length;
        for (const alert of result.frozenPeriodLateData) {
          console.error(
            `[Revenue] frozen period ${alert.periodYear}-${String(alert.periodMonth).padStart(2, "0")} ` +
              `user=${user.id} has late data — manual credit note or void may be required ` +
              `fields=${alert.fields.join(",")}`,
          );
        }
        await appendRevenueFrozenPeriodAlerts(
          prisma,
          user.id,
          result.frozenPeriodLateData,
        );
      }

      await prisma.user.update({
        where: { id: user.id },
        data: { deltaLedgerRecomputeRequired: false },
      });
      processed += 1;
    } catch (err) {
      errors += 1;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[BillingCron] late ledger recompute failed user=${user.id}: ${msg}`,
      );
    }
  }

  if (processed > 0 || frozenAlerts > 0 || errors > 0) {
    console.info(
      `[BillingCron] late ledger recompute cycle complete flagged=${users.length} ` +
        `processed=${processed} frozenAlerts=${frozenAlerts} errors=${errors}`,
    );
  } else {
    console.info(`[BillingCron] late ledger recompute cycle complete flagged=0`);
  }

  return { processed, frozenAlerts, errors };
}

export function initDelayedInvoiceCronJobs(prisma: PrismaClient): void {
  guardedCron(
    "billing-pending-final-invoice",
    "0 * * * *",
    async () => {
      await runPendingFinalInvoiceCron(prisma);
    },
    { timezone: DASHBOARD_PNL_DAY_TIMEZONE },
  );

  guardedCron(
    "billing-late-ledger-recompute",
    "0 * * * *",
    async () => {
      await runLateLedgerRecomputeCron(prisma);
    },
    { timezone: DASHBOARD_PNL_DAY_TIMEZONE },
  );

  console.log(
    `[BillingCron] Cron: pending final invoice + late ledger recompute @ hourly (IST); ` +
      `FINAL_INVOICE_DELAY_HOURS=${finalInvoiceDelayHours()}`,
  );
}
