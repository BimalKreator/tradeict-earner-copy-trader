import type { PrismaClient } from "@prisma/client";
export declare function runBillingCycle(prisma: PrismaClient): Promise<void>;
/**
 * Schedules daily billing tasks at 00:00 UTC (invoice generation + auto-pause).
 */
export declare function initBillingCronJobs(prisma: PrismaClient): void;
//# sourceMappingURL=billingService.d.ts.map