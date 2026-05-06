import type { NextFunction, Request, Response } from "express";
import {
  type PrismaClient,
  SubscriptionStatus,
} from "@prisma/client";
import { STRATEGY_SELECT_SUBSCRIBE_GATE } from "../prisma/strategySelect.js";
import { logUserActivity } from "../services/userActivityService.js";

/** Persists realized trade PnL for billing: stores profit and strategy profit-share commission. */
export async function recordTradePnl(
  prisma: PrismaClient,
  args: {
    userId: string;
    strategyId: string;
    tradeProfit: number;
  },
): Promise<void> {
  if (!Number.isFinite(args.tradeProfit)) {
    console.warn("[recordTradePnl] skip: tradeProfit is not finite");
    return;
  }

  const strategy = await prisma.strategy.findUnique({
    where: { id: args.strategyId },
    select: { profitShare: true },
  });

  if (!strategy) {
    console.warn(
      `[recordTradePnl] skip: strategy not found (${args.strategyId})`,
    );
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

export function createSubscriptionController(prisma: PrismaClient) {
  async function subscribe(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = req.userId;
      if (!userId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const body = req.body as {
        strategyId?: unknown;
        multiplier?: unknown;
        exchangeAccountId?: unknown;
      };

      const strategyId =
        typeof body.strategyId === "string" ? body.strategyId.trim() : "";

      const multiplier =
        typeof body.multiplier === "number"
          ? body.multiplier
          : typeof body.multiplier === "string"
            ? Number(body.multiplier)
            : NaN;

      let exchangeAccountId: string | null = null;
      if (
        body.exchangeAccountId !== undefined &&
        body.exchangeAccountId !== null
      ) {
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
        select: STRATEGY_SELECT_SUBSCRIBE_GATE,
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

      console.log(
        `[subscription] Subscription created id=${subscription.id} userId=${userId} strategyId=${strategyId} multiplier=${multiplier}x`,
      );
      console.log(
        `[subscription] Strategy syncActiveTrades=${String(strategy.syncActiveTrades)} (late-join runs only when true)`,
      );

      if (strategy.syncActiveTrades) {
        console.log(
          `[subscription] Late-join path: scheduling lateJoinMirrorOpenPositionsForSubscriber for user ${userId}`,
        );
        void import("../services/tradeEngine.js")
          .then(({ lateJoinMirrorOpenPositionsForSubscriber }) => {
            console.log(
              `[subscription] Late-join path: calling lateJoinMirrorOpenPositionsForSubscriber userId=${userId} strategyId=${strategyId}`,
            );
            return lateJoinMirrorOpenPositionsForSubscriber(prisma, {
              strategyId,
              userId,
            });
          })
          .then(() => {
            console.log(
              `[subscription] Late-join path: lateJoinMirrorOpenPositionsForSubscriber finished userId=${userId} strategyId=${strategyId}`,
            );
          })
          .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(
              `[subscription] Late-join sync failed strategyId=${strategyId} userId=${userId}:`,
              msg,
            );
          });
      } else {
        console.log(
          `[subscription] Late-join skipped: syncActiveTrades is false for strategy ${strategyId}`,
        );
      }

      void logUserActivity(prisma, {
        userId,
        kind: "SUBSCRIPTION_CREATED",
        message: `Subscribed with multiplier ${multiplier}x`,
      });

      res.status(201).json(subscription);
    } catch (err) {
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
  } as const;

  /** Strategies available in the marketplace (all rows; schema has no archived flag). */
  async function listStrategies(
    _req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
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
    } catch (err) {
      next(err);
    }
  }

  /** All subscription rows for the current user (any status), with strategy + exchange account. */
  async function listMySubscriptions(
    _req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
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
    } catch (err) {
      next(err);
    }
  }

  async function getStrategy(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
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
    } catch (err) {
      next(err);
    }
  }

  async function unsubscribe(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = req.userId;
      if (!userId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const raw = req.params.strategyId;
      const strategyId = Array.isArray(raw) ? raw[0] : raw;
      if (typeof strategyId !== "string" || !strategyId.trim()) {
        res.status(400).json({ error: "strategyId is required" });
        return;
      }

      const sub = await prisma.userSubscription.findFirst({
        where: {
          userId,
          strategyId: strategyId.trim(),
          status: SubscriptionStatus.ACTIVE,
        },
        select: { id: true },
      });

      if (!sub) {
        res.status(404).json({ error: "Active subscription not found" });
        return;
      }

      await prisma.userSubscription.update({
        where: { id: sub.id },
        data: { status: SubscriptionStatus.CANCELLED },
      });

      void logUserActivity(prisma, {
        userId,
        kind: "SUBSCRIPTION_CANCELLED",
        message: `Unsubscribed from strategy ${strategyId.trim()}`,
      });

      res.status(204).send();
    } catch (err) {
      next(err);
    }
  }

  return {
    subscribe,
    unsubscribe,
    listStrategies,
    listMySubscriptions,
    getStrategy,
  };
}
