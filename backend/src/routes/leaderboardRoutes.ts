import { Router } from "express";
import type { PrismaClient } from "@prisma/client";

function utcMonthBounds(now = new Date()): { start: Date; end: Date; label: string } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const start = new Date(Date.UTC(y, m, 1));
  const end = new Date(Date.UTC(y, m + 1, 1));
  const label = `${y}-${String(m + 1).padStart(2, "0")}`;
  return { start, end, label };
}

/** e.g. bob@gmail.com → b***@gmail.com */
export function maskEmail(email: string): string {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.indexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return "***";
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  const first = local[0] ?? "*";
  return `${first}***@${domain}`;
}

export function createLeaderboardRoutes(prisma: PrismaClient): Router {
  const router = Router();

  router.get("/", async (_req, res, next) => {
    try {
      const { start, end, label } = utcMonthBounds();

      const [byStrategy, byUser] = await Promise.all([
        prisma.pnLRecord.groupBy({
          by: ["strategyId"],
          where: {
            timestamp: { gte: start, lt: end },
          },
          _sum: { profitAmount: true },
        }),
        prisma.pnLRecord.groupBy({
          by: ["userId"],
          where: {
            timestamp: { gte: start, lt: end },
          },
          _sum: { profitAmount: true },
        }),
      ]);

      const strategyIds = byStrategy.map((r) => r.strategyId);
      const strategiesMeta = await prisma.strategy.findMany({
        where: { id: { in: strategyIds } },
        select: { id: true, title: true, minCapital: true },
      });
      const strategyMetaById = new Map(
        strategiesMeta.map((s) => [s.id, s]),
      );

      const strategyRows: {
        rank: number;
        strategyId: string;
        title: string;
        monthlyProfit: number;
        minCapital: number;
        monthlyRoiPercent: number;
      }[] = [];

      for (const row of byStrategy) {
        const profit = row._sum.profitAmount ?? 0;
        const strategy = strategyMetaById.get(row.strategyId);
        if (!strategy) continue;

        const denom = Math.max(strategy.minCapital, 1);
        const monthlyRoiPercent = (profit / denom) * 100;

        strategyRows.push({
          rank: 0,
          strategyId: row.strategyId,
          title: strategy.title,
          monthlyProfit: profit,
          minCapital: strategy.minCapital,
          monthlyRoiPercent,
        });
      }

      strategyRows.sort(
        (a, b) => b.monthlyRoiPercent - a.monthlyRoiPercent,
      );
      const topStrategies = strategyRows.slice(0, 10).map((s, i) => ({
        ...s,
        rank: i + 1,
      }));

      const userProfits = [...byUser]
        .map((u) => ({
          userId: u.userId,
          monthlyProfit: u._sum.profitAmount ?? 0,
        }))
        .sort((a, b) => b.monthlyProfit - a.monthlyProfit)
        .slice(0, 5);

      const users = await prisma.user.findMany({
        where: { id: { in: userProfits.map((p) => p.userId) } },
        select: { id: true, email: true },
      });
      const emailById = new Map(users.map((u) => [u.id, u.email]));

      const topEarners = userProfits.map((p, i) => ({
        rank: i + 1,
        maskedEmail: maskEmail(emailById.get(p.userId) ?? "***"),
        monthlyProfit: p.monthlyProfit,
      }));

      res.json({
        period: {
          label,
          startUtc: start.toISOString(),
          endUtc: end.toISOString(),
        },
        strategies: topStrategies,
        earners: topEarners,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
