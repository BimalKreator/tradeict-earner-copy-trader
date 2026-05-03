import type { NextFunction, Request, Response } from "express";
import { type PrismaClient } from "@prisma/client";
/** Persists realized trade PnL for billing: stores profit and strategy profit-share commission. */
export declare function recordTradePnl(prisma: PrismaClient, args: {
    userId: string;
    strategyId: string;
    tradeProfit: number;
}): Promise<void>;
export declare function createSubscriptionController(prisma: PrismaClient): {
    subscribe: (req: Request, res: Response, next: NextFunction) => Promise<void>;
    listStrategies: (_req: Request, res: Response, next: NextFunction) => Promise<void>;
    getStrategy: (req: Request, res: Response, next: NextFunction) => Promise<void>;
};
//# sourceMappingURL=subscriptionController.d.ts.map