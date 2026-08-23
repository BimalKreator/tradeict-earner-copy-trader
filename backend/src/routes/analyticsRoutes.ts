import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { SubscriptionStatus } from "@prisma/client";
import { authenticateJwt } from "../middleware/authMiddleware.js";
import { excludeTestPnlFilter } from "../services/simulatedDataFilters.js";

export function createAnalyticsRoutes(prisma: PrismaClient): Router {
  const router = Router();
  const jwtAuth = authenticateJwt(prisma);

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

      // BILLING QUERY — must always carry excludeSimulatedFilter()
      const records = await prisma.pnLRecord.findMany({
        where: {
          userId,
          timestamp: { gte: start, lt: end },
          ...excludeTestPnlFilter(false),
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

      const subs = await prisma.userStrategySubscription.findMany({
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

      if (subs.length === 0) {
        res.json({ strategies: strategiesOut });
        return;
      }

      const strategyIds = [...new Set(subs.map((s) => s.strategyId))];
      const titleById = new Map(
        subs.map((s) => [s.strategyId, s.strategy.title] as const),
      );

      // Bound history so one user cannot pull unbounded PnL rows into memory.
      const since = new Date();
      since.setUTCMonth(since.getUTCMonth() - 18);

      // BILLING QUERY — must always carry excludeSimulatedFilter()
      const rows = await prisma.pnLRecord.findMany({
        where: {
          userId,
          strategyId: { in: strategyIds },
          timestamp: { gte: since },
          ...excludeTestPnlFilter(false),
        },
        orderBy: { timestamp: "asc" },
        select: { strategyId: true, timestamp: true, profitAmount: true },
        take: 50_000,
      });

      const seriesByStrategy = new Map<
        string,
        { date: string; cumulative: number }[]
      >();
      const cumulativeByStrategy = new Map<string, number>();

      for (const id of strategyIds) {
        seriesByStrategy.set(id, []);
        cumulativeByStrategy.set(id, 0);
      }

      for (const r of rows) {
        const prev = cumulativeByStrategy.get(r.strategyId) ?? 0;
        const next = prev + r.profitAmount;
        cumulativeByStrategy.set(r.strategyId, next);
        const series = seriesByStrategy.get(r.strategyId);
        if (series) {
          series.push({
            date: r.timestamp.toISOString(),
            cumulative: next,
          });
        }
      }

      for (const strategyId of strategyIds) {
        strategiesOut.push({
          strategyId,
          title: titleById.get(strategyId) ?? strategyId,
          series: seriesByStrategy.get(strategyId) ?? [],
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
