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
            let exchangeAccountId = null;
            if (body.exchangeAccountId !== undefined &&
                body.exchangeAccountId !== null) {
                if (typeof body.exchangeAccountId !== "string") {
                    res.status(400).json({ error: "exchangeAccountId must be a string" });
                    return;
                }
                const trimmed = body.exchangeAccountId.trim();
                if (!trimmed) {
                    res.status(400).json({ error: "exchangeAccountId cannot be empty" });
                    return;
                }
                const account = await prisma.exchangeAccount.findFirst({
                    where: { id: trimmed, userId },
                });
                if (!account) {
                    res.status(400).json({
                        error: "Exchange account not found or does not belong to you",
                    });
                    return;
                }
                exchangeAccountId = trimmed;
            }
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
                    ...(exchangeAccountId !== null
                        ? { exchangeAccountId }
                        : {}),
                },
            });
            if (strategy.syncActiveTrades) {
                void import("../services/tradeEngine.js")
                    .then(({ lateJoinMirrorOpenPositionsForSubscriber }) => lateJoinMirrorOpenPositionsForSubscriber(prisma, {
                    strategyId,
                    userId,
                }))
                    .catch((err) => {
                    const msg = err instanceof Error ? err.message : String(err);
                    console.error(`[subscription] Late-join sync failed strategyId=${strategyId} userId=${userId}:`, msg);
                });
            }
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
    const strategySelectPublic = {
        id: true,
        title: true,
        description: true,
        monthlyFee: true,
        minCapital: true,
        profitShare: true,
        slippage: true,
        performanceMetrics: true,
        syncActiveTrades: true,
        createdAt: true,
    };
    /** Strategies available in the marketplace (all rows; schema has no archived flag). */
    async function listStrategies(_req, res, next) {
        try {
            const userId = _req.userId;
            if (!userId) {
                res.status(401).json({ error: "Unauthorized" });
                return;
            }
            const strategies = await prisma.strategy.findMany({
                orderBy: { createdAt: "desc" },
                select: strategySelectPublic,
            });
            res.json(strategies);
        }
        catch (err) {
            next(err);
        }
    }
    /** All subscription rows for the current user (any status), with strategy + exchange account. */
    async function listMySubscriptions(_req, res, next) {
        try {
            const userId = _req.userId;
            if (!userId) {
                res.status(401).json({ error: "Unauthorized" });
                return;
            }
            const rows = await prisma.userSubscription.findMany({
                where: { userId },
                orderBy: { joinedDate: "desc" },
                include: {
                    strategy: { select: strategySelectPublic },
                    exchangeAccount: {
                        select: { id: true, nickname: true, exchange: true },
                    },
                },
            });
            res.json({ subscriptions: rows });
        }
        catch (err) {
            next(err);
        }
    }
    async function getStrategy(req, res, next) {
        try {
            const userId = req.userId;
            if (!userId) {
                res.status(401).json({ error: "Unauthorized" });
                return;
            }
            const rawId = req.params.id;
            const id = Array.isArray(rawId) ? rawId[0] : rawId;
            if (typeof id !== "string" || !id.trim()) {
                res.status(400).json({ error: "id is required" });
                return;
            }
            const strategy = await prisma.strategy.findUnique({
                where: { id: id.trim() },
                select: strategySelectPublic,
            });
            if (!strategy) {
                res.status(404).json({ error: "Strategy not found" });
                return;
            }
            res.json(strategy);
        }
        catch (err) {
            next(err);
        }
    }
    return {
        subscribe,
        listStrategies,
        listMySubscriptions,
        getStrategy,
    };
}
//# sourceMappingURL=subscriptionController.js.map