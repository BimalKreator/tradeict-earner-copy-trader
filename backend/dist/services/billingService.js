import { InvoiceStatus, SubscriptionStatus } from "@prisma/client";
import cron from "node-cron";
/** 30-day billing window length (milliseconds). */
const BILLING_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Days after invoice creation until payment is due. */
const INVOICE_DUE_DAYS = 14;
/** UNPAID invoices with dueDate older than this many days trigger subscription pause. */
const OVERDUE_PAUSE_DAYS = 5;
async function generateSubscriptionInvoices(prisma) {
    const now = new Date();
    const subscriptions = await prisma.userSubscription.findMany({
        where: { status: SubscriptionStatus.ACTIVE },
    });
    for (const sub of subscriptions) {
        const joined = sub.joinedDate.getTime();
        const elapsed = now.getTime() - joined;
        const periodsEnded = Math.floor(elapsed / BILLING_PERIOD_MS);
        if (periodsEnded < 1)
            continue;
        for (let periodIndex = 0; periodIndex < periodsEnded; periodIndex++) {
            const periodStart = new Date(joined + periodIndex * BILLING_PERIOD_MS);
            const periodEnd = new Date(joined + (periodIndex + 1) * BILLING_PERIOD_MS);
            const existing = await prisma.invoice.findUnique({
                where: {
                    subscriptionId_billingPeriodEnd: {
                        subscriptionId: sub.id,
                        billingPeriodEnd: periodEnd,
                    },
                },
            });
            if (existing)
                continue;
            const agg = await prisma.pnLRecord.aggregate({
                where: {
                    userId: sub.userId,
                    strategyId: sub.strategyId,
                    timestamp: {
                        gte: periodStart,
                        lt: periodEnd,
                    },
                },
                _sum: { commissionAmount: true },
            });
            const totalCommission = agg._sum.commissionAmount ?? 0;
            if (totalCommission <= 0)
                continue;
            const dueDate = new Date(now.getTime() + INVOICE_DUE_DAYS * MS_PER_DAY);
            await prisma.invoice.create({
                data: {
                    userId: sub.userId,
                    amount: totalCommission,
                    status: InvoiceStatus.UNPAID,
                    dueDate,
                    subscriptionId: sub.id,
                    billingPeriodEnd: periodEnd,
                },
            });
        }
    }
}
async function pauseSubscriptionsForOverdueInvoices(prisma) {
    const overdueCutoff = new Date(Date.now() - OVERDUE_PAUSE_DAYS * MS_PER_DAY);
    const overdue = await prisma.invoice.findMany({
        where: {
            status: InvoiceStatus.UNPAID,
            dueDate: { lt: overdueCutoff },
        },
        select: { userId: true },
    });
    const userIds = [...new Set(overdue.map((row) => row.userId))];
    for (const userId of userIds) {
        await prisma.userSubscription.updateMany({
            where: {
                userId,
                status: { not: SubscriptionStatus.PAUSED },
            },
            data: { status: SubscriptionStatus.PAUSED },
        });
    }
}
export async function runBillingCycle(prisma) {
    await generateSubscriptionInvoices(prisma);
    await pauseSubscriptionsForOverdueInvoices(prisma);
}
/**
 * Schedules daily billing tasks at 00:00 UTC (invoice generation + auto-pause).
 */
export function initBillingCronJobs(prisma) {
    cron.schedule("0 0 * * *", () => {
        void runBillingCycle(prisma).catch((err) => {
            console.error("[billing] scheduled run failed:", err);
        });
    }, { timezone: "Etc/UTC" });
    console.log("[billing] Cron: daily at 00:00 UTC (invoices + overdue pause)");
}
//# sourceMappingURL=billingService.js.map