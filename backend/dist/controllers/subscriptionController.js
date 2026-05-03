import { SubscriptionStatus, } from "@prisma/client";
import { logUserActivity } from "../services/userActivityService.js";
/** Persists realized trade PnL for billing: stores profit and strategy profit-share commission. */
export async function recordTradePnl(prisma, args) {
    if (!Number.isFinite(args.tradeProfit)) {
        console.warn("[recordTradePnl] skip: tradeProfit is not finite");
        return;
    }
    const strategy = await prisma.strategy.findUnique({
        where: { id: args.strategyId },
        select: { profitShare: true },
    });
    if (!strategy) {
        console.warn(`[recordTradePnl] skip: strategy not found (${args.strategyId})`);
        return;
    }
    const commissionAmount = (args.tradeProfit * strategy.profitShare) / 100;
    await prisma.pnLRecord.create({
        data: {
            userId: args.userId,
            strategyId: args.strategyId,
            profitAmount: args.tradeProfit,
            commissionAmount,
        },
    });
}
export function createSubscriptionController(prisma) {
    async function subscribe(req, res, next) {
        try {
            const userId = req.userId;
            if (!userId) {
                res.status(401).json({ error: "Unauthorized" });
                return;
            }
            const body = req.body;
            const strategyId = typeof body.strategyId === "string" ? body.strategyId.trim() : "";
            const multiplier = typeof body.multiplier === "number"
                ? body.multiplier
                : typeof body.multiplier === "string"
                    ? Number(body.multiplier)
                    : NaN;
            if (!strategyId) {
                res.status(400).json({ error: "strategyId is required" });
                return;
            }
            if (!Number.isFinite(multiplier) || multiplier <= 0) {
                res.status(400).json({ error: "multiplier must be a positive number" });
                return;
            }
            const strategy = await prisma.strategy.findUnique({
                where: { id: strategyId },
            });
            if (!strategy) {
                res.status(404).json({ error: "Strategy not found" });
                return;
            }
            const existingActive = await prisma.userSubscription.findFirst({
                where: {
                    userId,
                    strategyId,
                    status: SubscriptionStatus.ACTIVE,
                },
            });
            if (existingActive) {
                res.status(409).json({
                    error: "You already have an active subscription for this strategy",
                });
                return;
            }
            const subscription = await prisma.userSubscription.create({
                data: {
                    userId,
                    strategyId,
                    multiplier,
                    status: SubscriptionStatus.ACTIVE,
                },
            });
            void logUserActivity(prisma, {
                userId,
                kind: "SUBSCRIPTION_CREATED",
                message: `Subscribed with multiplier ${multiplier}x`,
            });
            res.status(201).json(subscription);
        }
        catch (err) {
            next(err);
        }
    }
    return {
        subscribe,
    };
}
//# sourceMappingURL=subscriptionController.js.map