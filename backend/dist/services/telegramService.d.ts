import type { PrismaClient } from "@prisma/client";
export declare function notifyTradeExecuted(prisma: PrismaClient, args: {
    userId: string;
    strategyId: string;
    symbol: string;
    side: string;
    size: number;
    entryPrice: number;
}): Promise<void>;
export declare function sendDailyPnLSummaries(prisma: PrismaClient): Promise<void>;
export declare function initTelegramCronJobs(prisma: PrismaClient): void;
export declare function initTelegramBot(prisma: PrismaClient): void;
export declare function createTelegramLinkToken(): string;
export declare function telegramLinkExpiry(): Date;
//# sourceMappingURL=telegramService.d.ts.map