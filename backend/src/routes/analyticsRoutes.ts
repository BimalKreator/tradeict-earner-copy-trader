import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { SubscriptionStatus } from "@prisma/client";
import { authenticateJwt } from "../middleware/authMiddleware.js";

export function createAnalyticsRoutes(prisma: PrismaClient): Router {
  const router = Router();
  const jwtAuth = authenticateJwt();

  router.get("/calendar", jwtAuth, async (req, res, next) => {
    try {
      const userId = req.userId;
      if (!userId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const year = Number(req.query.year);
      const month = Number(req.query.month);
      if (
        !Number.isInteger(year) ||
        !Number.isInteger(month) ||
        month < 1 ||
        month > 12
      ) {
        res.status(400).json({ error: "year and month (1–12) are required" });
        return;
      }

      const start = new Date(Date.UTC(year, month - 1, 1));
      const end = new Date(Date.UTC(year, month, 1));

      const records = await prisma.pnLRecord.findMany({
        where: {
          userId,
          timestamp: { gte: start, lt: end },
        },
        select: { timestamp: true, profitAmount: true },
      });

      const byDay = new Map<string, number>();
      for (const r of records) {
        const key = r.timestamp.toISOString().slice(0, 10);
        byDay.set(key, (byDay.get(key) ?? 0) + r.profitAmount);
      }

      const days = [...byDay.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, profit]) => ({ date, profit }));

      res.json({ year, month, days });
    } catch (err) {
      next(err);
    }
  });

  router.get("/cumulative-strategies", jwtAuth, async (req, res, next) => {
    try {
      const userId = req.userId;
      if (!userId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const subs = await prisma.userSubscription.findMany({
        where: {
          userId,
          status: {
            in: [
              SubscriptionStatus.ACTIVE,
              SubscriptionStatus.PAUSED_DUE_TO_FUNDS,
              SubscriptionStatus.CANCELLED,
            ],
          },
        },
        select: {
          strategyId: true,
          strategy: { select: { title: true } },
        },
      });

      const strategiesOut: {
        strategyId: string;
        title: string;
        series: { date: string; cumulative: number }[];
      }[] = [];

      for (const sub of subs) {
        const rows = await prisma.pnLRecord.findMany({
          where: { userId, strategyId: sub.strategyId },
          orderBy: { timestamp: "asc" },
          select: { timestamp: true, profitAmount: true },
        });

        let cumulative = 0;
        const series = rows.map((r) => {
          cumulative += r.profitAmount;
          return {
            date: r.timestamp.toISOString(),
            cumulative,
          };
        });

        strategiesOut.push({
          strategyId: sub.strategyId,
          title: sub.strategy.title,
          series,
        });
      }

      res.json({ strategies: strategiesOut });
    } catch (err) {
      next(err);
    }
  });

  router.get("/activity", jwtAuth, async (req, res, next) => {
    try {
      const userId = req.userId;
      if (!userId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const limitRaw = req.query.limit;
      const limit =
        typeof limitRaw === "string"
          ? Math.min(100, Math.max(1, parseInt(limitRaw, 10) || 50))
          : 50;

      const items = await prisma.userActivity.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: limit,
        select: {
          id: true,
          kind: true,
          message: true,
          createdAt: true,
        },
      });

      res.json({ items });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
