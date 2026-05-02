import type { NextFunction, Request, Response } from "express";
import {
  type PrismaClient,
  SubscriptionStatus,
} from "@prisma/client";

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
      };

      const strategyId =
        typeof body.strategyId === "string" ? body.strategyId.trim() : "";

      const multiplier =
        typeof body.multiplier === "number"
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

      res.status(201).json(subscription);
    } catch (err) {
      next(err);
    }
  }

  return {
    subscribe,
  };
}
