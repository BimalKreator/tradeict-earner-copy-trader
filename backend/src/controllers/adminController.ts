import type { NextFunction, Request, Response } from "express";
import { InvoiceStatus, TradeStatus, type PrismaClient } from "@prisma/client";

function realizedTradePnl(trade: { tradePnl: number; pnl: number | null }): number {
  if (Number.isFinite(trade.tradePnl) && trade.tradePnl !== 0) return trade.tradePnl;
  return Number.isFinite(trade.pnl ?? NaN) ? (trade.pnl as number) : 0;
}

export function createAdminController(prisma: PrismaClient) {
  async function getRevenueAnalytics(
    _req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const now = new Date();
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const [paidAgg, pendingAgg, monthPnlAgg, allClosedTrades] = await Promise.all([
        prisma.invoice.aggregate({
          where: { status: InvoiceStatus.PAID },
          _sum: { amountDue: true },
        }),
        prisma.invoice.aggregate({
          where: { status: { in: [InvoiceStatus.PENDING, InvoiceStatus.OVERDUE] } },
          _sum: { amountDue: true },
        }),
        prisma.pnLRecord.aggregate({
          where: { timestamp: { gte: monthStart } },
          _sum: { commissionAmount: true },
        }),
        prisma.trade.findMany({
          where: { status: TradeStatus.CLOSED },
          select: {
            strategyId: true,
            tradePnl: true,
            pnl: true,
            revenueShareAmt: true,
            strategy: { select: { title: true, profitShare: true } },
          },
        }),
      ]);

      const totalUserPnl = allClosedTrades.reduce((s, t) => s + realizedTradePnl(t), 0);
      const strategyAgg = new Map<
        string,
        { strategyName: string; totalTrades: number; wins: number; revenueForAdmin: number }
      >();
      for (const t of allClosedTrades) {
        const realized = realizedTradePnl(t);
        const row = strategyAgg.get(t.strategyId) ?? {
          strategyName: t.strategy.title,
          totalTrades: 0,
          wins: 0,
          revenueForAdmin: 0,
        };
        row.totalTrades += 1;
        if (realized > 0) row.wins += 1;
        row.revenueForAdmin +=
          Number.isFinite(t.revenueShareAmt) && t.revenueShareAmt > 0
            ? t.revenueShareAmt
            : realized > 0
              ? realized * (t.strategy.profitShare / 100)
              : 0;
        strategyAgg.set(t.strategyId, row);
      }

      res.json({
        stats: {
          totalRevenueGenerated: paidAgg._sum.amountDue ?? 0,
          thisMonthRevenue: monthPnlAgg._sum.commissionAmount ?? 0,
          totalUserPnl,
          pendingPaymentsReceivables: pendingAgg._sum.amountDue ?? 0,
        },
        strategyWisePerformance: Array.from(strategyAgg.values()).map((r) => ({
          strategyName: r.strategyName,
          totalTrades: r.totalTrades,
          totalRevenueForAdmin: r.revenueForAdmin,
          winRate: r.totalTrades > 0 ? (r.wins / r.totalTrades) * 100 : 0,
        })),
      });
    } catch (err) {
      next(err);
    }
  }

  async function getUserTradesBilling(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = String(req.params.id ?? "").trim();
      if (!userId) {
        res.status(400).json({ error: "User id is required" });
        return;
      }

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, name: true },
      });
      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      const trades = await prisma.trade.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: 300,
        select: {
          id: true,
          createdAt: true,
          strategyId: true,
          symbol: true,
          side: true,
          size: true,
          entryPrice: true,
          exitPrice: true,
          tradePnl: true,
          pnl: true,
          revenueShareAmt: true,
          status: true,
          strategy: { select: { title: true, profitShare: true } },
        },
      });

      const normalizedTrades = trades.map((t) => {
        const realized = realizedTradePnl(t);
        const adminRevenue =
          Number.isFinite(t.revenueShareAmt) && t.revenueShareAmt > 0
            ? t.revenueShareAmt
            : realized > 0
              ? realized * (t.strategy.profitShare / 100)
              : 0;
        return {
          id: t.id,
          createdAt: t.createdAt,
          strategyId: t.strategyId,
          strategyTitle: t.strategy.title,
          symbol: t.symbol,
          side: t.side,
          size: t.size,
          entryPrice: t.entryPrice,
          exitPrice: t.exitPrice,
          status: t.status,
          pnl: realized,
          adminRevenue,
        };
      });

      const totalPnlToDate = normalizedTrades.reduce((s, t) => s + t.pnl, 0);
      const totalAdminCommissionEarned = normalizedTrades.reduce(
        (s, t) => s + t.adminRevenue,
        0,
      );

      const [paidAgg, dueAgg] = await Promise.all([
        prisma.invoice.aggregate({
          where: { userId, status: InvoiceStatus.PAID },
          _sum: { amountDue: true },
        }),
        prisma.invoice.aggregate({
          where: { userId, status: { in: [InvoiceStatus.PENDING, InvoiceStatus.OVERDUE] } },
          _sum: { amountDue: true },
        }),
      ]);

      res.json({
        user,
        trades: normalizedTrades,
        billingSummary: {
          totalPnlToDate,
          totalAdminCommissionEarned,
          amountPaid: paidAgg._sum.amountDue ?? 0,
          balanceDue: dueAgg._sum.amountDue ?? 0,
        },
      });
    } catch (err) {
      next(err);
    }
  }

  return { getRevenueAnalytics, getUserTradesBilling };
}

