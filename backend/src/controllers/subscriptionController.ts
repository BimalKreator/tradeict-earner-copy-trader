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
  const USER_PAUSED_STATUS = SubscriptionStatus.PAUSED_DUE_TO_FUNDS;

  async function validateExchangeAccountOwnership(
    userId: string,
    exchangeAccountId: unknown,
  ): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
    if (typeof exchangeAccountId !== "string") {
      return { ok: false, error: "exchangeAccountId must be a string" };
    }
    const trimmed = exchangeAccountId.trim();
    if (!trimmed) {
      return { ok: false, error: "exchangeAccountId cannot be empty" };
    }
    const account = await prisma.exchangeAccount.findFirst({
      where: { id: trimmed, userId },
      select: { id: true },
    });
    if (!account) {
      return {
        ok: false,
        error: "Exchange account not found or does not belong to you",
      };
    }
    return { ok: true, id: trimmed };
  }

  function parsePositiveMultiplier(v: unknown): number | null {
    const n =
      typeof v === "number"
        ? v
        : typeof v === "string"
          ? Number(v)
          : NaN;
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
  }

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
      };

      const strategyId =
        typeof body.strategyId === "string" ? body.strategyId.trim() : "";

      if (!strategyId) {
        res.status(400).json({ error: "strategyId is required" });
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

      const existing = await prisma.userSubscription.findFirst({
        where: {
          userId,
          strategyId,
          status: {
            in: [SubscriptionStatus.ACTIVE, USER_PAUSED_STATUS],
          },
        },
      });

      if (existing) {
        res.status(409).json({
          error: "You already have this strategy in My Strategies",
        });
        return;
      }

      const subscription = await prisma.userSubscription.create({
        data: {
          userId,
          strategyId,
          multiplier: 1,
          status: USER_PAUSED_STATUS,
        },
      });

      console.log(
        `[subscription] Strategy added (paused) id=${subscription.id} userId=${userId} strategyId=${strategyId}`,
      );

      void logUserActivity(prisma, {
        userId,
        kind: "SUBSCRIPTION_CREATED",
        message: `Added strategy to My Strategies (inactive)`,
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
          status: {
            in: [SubscriptionStatus.ACTIVE, USER_PAUSED_STATUS],
          },
        },
        select: { id: true },
      });

      if (!sub) {
        res.status(404).json({ error: "Subscription not found" });
        return;
      }

      await prisma.userSubscription.delete({
        where: { id: sub.id },
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

  async function deploy(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = req.userId;
      if (!userId) return void res.status(401).json({ error: "Unauthorized" });
      const strategyId = String(req.params.strategyId ?? "").trim();
      if (!strategyId) return void res.status(400).json({ error: "strategyId is required" });

      const body = req.body as { multiplier?: unknown; exchangeAccountId?: unknown };
      const multiplier = parsePositiveMultiplier(body.multiplier);
      if (multiplier == null) {
        return void res.status(400).json({ error: "multiplier must be a positive number" });
      }
      const ex = await validateExchangeAccountOwnership(userId, body.exchangeAccountId);
      if (!ex.ok) return void res.status(400).json({ error: ex.error });

      const sub = await prisma.userSubscription.findFirst({
        where: { userId, strategyId, status: { in: [SubscriptionStatus.ACTIVE, USER_PAUSED_STATUS] } },
        include: { strategy: { select: STRATEGY_SELECT_SUBSCRIBE_GATE } },
      });
      if (!sub) return void res.status(404).json({ error: "Subscription not found" });

      const updated = await prisma.userSubscription.update({
        where: { id: sub.id },
        data: {
          multiplier,
          exchangeAccountId: ex.id,
          status: SubscriptionStatus.ACTIVE,
        },
        include: {
          strategy: { select: strategySelectPublic },
          exchangeAccount: { select: { id: true, nickname: true, exchange: true } },
        },
      });

      if (sub.strategy.syncActiveTrades) {
        void import("../services/tradeEngine.js")
          .then(({ lateJoinMirrorOpenPositionsForSubscriber }) =>
            lateJoinMirrorOpenPositionsForSubscriber(prisma, { strategyId, userId }),
          )
          .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[subscription] deploy late-join failed strategyId=${strategyId} userId=${userId}:`, msg);
          });
      }

      res.json({ subscription: updated });
    } catch (err) {
      next(err);
    }
  }

  async function modify(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = req.userId;
      if (!userId) return void res.status(401).json({ error: "Unauthorized" });
      const strategyId = String(req.params.strategyId ?? "").trim();
      if (!strategyId) return void res.status(400).json({ error: "strategyId is required" });
      const body = req.body as { multiplier?: unknown };
      const multiplier = parsePositiveMultiplier(body.multiplier);
      if (multiplier == null) {
        return void res.status(400).json({ error: "multiplier must be a positive number" });
      }

      const sub = await prisma.userSubscription.findFirst({
        where: { userId, strategyId, status: { in: [SubscriptionStatus.ACTIVE, USER_PAUSED_STATUS] } },
        select: { id: true },
      });
      if (!sub) return void res.status(404).json({ error: "Subscription not found" });

      const updated = await prisma.userSubscription.update({
        where: { id: sub.id },
        data: { multiplier },
        include: {
          strategy: { select: strategySelectPublic },
          exchangeAccount: { select: { id: true, nickname: true, exchange: true } },
        },
      });
      res.json({ subscription: updated });
    } catch (err) {
      next(err);
    }
  }

  async function pause(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.userId;
      if (!userId) return void res.status(401).json({ error: "Unauthorized" });
      const strategyId = String(req.params.strategyId ?? "").trim();
      if (!strategyId) return void res.status(400).json({ error: "strategyId is required" });
      const sub = await prisma.userSubscription.findFirst({
        where: { userId, strategyId, status: SubscriptionStatus.ACTIVE },
        select: { id: true },
      });
      if (!sub) return void res.status(404).json({ error: "Active subscription not found" });
      const updated = await prisma.userSubscription.update({
        where: { id: sub.id },
        data: { status: USER_PAUSED_STATUS },
        include: {
          strategy: { select: strategySelectPublic },
          exchangeAccount: { select: { id: true, nickname: true, exchange: true } },
        },
      });
      res.json({ subscription: updated });
    } catch (err) {
      next(err);
    }
  }

  async function resume(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.userId;
      if (!userId) return void res.status(401).json({ error: "Unauthorized" });
      const strategyId = String(req.params.strategyId ?? "").trim();
      if (!strategyId) return void res.status(400).json({ error: "strategyId is required" });
      const sub = await prisma.userSubscription.findFirst({
        where: { userId, strategyId, status: USER_PAUSED_STATUS },
        include: { strategy: { select: STRATEGY_SELECT_SUBSCRIBE_GATE } },
      });
      if (!sub) return void res.status(404).json({ error: "Paused subscription not found" });
      if (!sub.exchangeAccountId) {
        return void res.status(400).json({ error: "Deploy this strategy first (missing exchange account)." });
      }

      const updated = await prisma.userSubscription.update({
        where: { id: sub.id },
        data: { status: SubscriptionStatus.ACTIVE },
        include: {
          strategy: { select: strategySelectPublic },
          exchangeAccount: { select: { id: true, nickname: true, exchange: true } },
        },
      });

      if (sub.strategy.syncActiveTrades) {
        void import("../services/tradeEngine.js")
          .then(({ lateJoinMirrorOpenPositionsForSubscriber }) =>
            lateJoinMirrorOpenPositionsForSubscriber(prisma, { strategyId, userId }),
          )
          .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[subscription] resume late-join failed strategyId=${strategyId} userId=${userId}:`, msg);
          });
      }

      res.json({ subscription: updated });
    } catch (err) {
      next(err);
    }
  }

  return {
    subscribe,
    unsubscribe,
    remove: unsubscribe,
    deploy,
    modify,
    pause,
    resume,
    listStrategies,
    listMySubscriptions,
    getStrategy,
  };
}
