import type { PrismaClient } from "@prisma/client";
import { startOfUtcDay, startOfUtcMonth } from "./dashboardMetricsService.js";

export async function sumArbitrageNetProfitSince(
  prisma: PrismaClient,
  userId: string,
  since: Date,
): Promise<number> {
  const agg = await prisma.arbitrageTrade.aggregate({
    where: { userId, createdAt: { gte: since } },
    _sum: { netProfit: true },
  });
  return agg._sum.netProfit ?? 0;
}

export async function sumArbitrageNetProfitAllTime(
  prisma: PrismaClient,
  userId: string,
): Promise<number> {
  const agg = await prisma.arbitrageTrade.aggregate({
    where: { userId },
    _sum: { netProfit: true },
  });
  return agg._sum.netProfit ?? 0;
}

export async function getUserArbitrageDashboardMetrics(
  prisma: PrismaClient,
  userId: string,
): Promise<{
  cryptoBalance: number;
  cryptoArbitrageEnabled: boolean;
  todayPnl: number;
  monthlyPnl: number;
}> {
  const [user, todayPnl, monthlyPnl] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        cryptoBalance: true,
        cryptoArbitrageEnabled: true,
      },
    }),
    sumArbitrageNetProfitSince(prisma, userId, startOfUtcDay()),
    sumArbitrageNetProfitSince(prisma, userId, startOfUtcMonth()),
  ]);

  return {
    cryptoBalance: user?.cryptoBalance ?? 0,
    cryptoArbitrageEnabled: user?.cryptoArbitrageEnabled ?? false,
    todayPnl,
    monthlyPnl,
  };
}
