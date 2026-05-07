import type { NextFunction, Request, Response } from "express";
import { InvoiceStatus, TradeStatus, type PrismaClient } from "@prisma/client";
import crypto from "node:crypto";
import {
  executeTrade,
  fetchDeltaTotalBalanceUsd,
  type TradeSide,
} from "../services/exchangeService.js";
import { sendPasswordResetLinkEmail } from "../utils/emailService.js";

function realizedTradePnl(trade: { tradePnl: number; pnl: number | null }): number {
  if (Number.isFinite(trade.tradePnl) && trade.tradePnl !== 0) return trade.tradePnl;
  return Number.isFinite(trade.pnl ?? NaN) ? (trade.pnl as number) : 0;
}

export function createAdminController(prisma: PrismaClient) {
  function oppositeSide(side: TradeSide): TradeSide {
    return side === "BUY" ? "SELL" : "BUY";
  }

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
            tradingFee: true,
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
          tradingFee: true,
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
          tradingFee:
            Number.isFinite(t.tradingFee) && t.tradingFee > 0 ? t.tradingFee : 0,
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

  async function closeManualTrade(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const body = req.body as {
        strategyId?: unknown;
        userId?: unknown;
        symbol?: unknown;
        side?: unknown;
        size?: unknown;
        isMaster?: unknown;
      };
      const strategyId = String(body.strategyId ?? "").trim();
      const userId = String(body.userId ?? "").trim();
      const symbol = String(body.symbol ?? "").trim();
      const sideRaw = String(body.side ?? "").toUpperCase();
      const size = Number(body.size);
      const isMaster = Boolean(body.isMaster);

      if (!strategyId || !symbol || !Number.isFinite(size) || size <= 0) {
        res.status(400).json({ error: "strategyId, symbol and positive size are required" });
        return;
      }
      if (sideRaw !== "BUY" && sideRaw !== "SELL") {
        res.status(400).json({ error: "side must be BUY or SELL" });
        return;
      }
      if (!isMaster && !userId) {
        res.status(400).json({ error: "userId is required for follower close" });
        return;
      }

      const strategy = await prisma.strategy.findUnique({
        where: { id: strategyId },
        select: { id: true, masterApiKey: true, masterApiSecret: true },
      });
      if (!strategy) {
        res.status(404).json({ error: "Strategy not found" });
        return;
      }

      let apiKey = "";
      let apiSecret = "";
      if (isMaster) {
        apiKey = strategy.masterApiKey?.trim() ?? "";
        apiSecret = strategy.masterApiSecret?.trim() ?? "";
      } else {
        const sub = await prisma.userSubscription.findFirst({
          where: { userId, strategyId },
          orderBy: { joinedDate: "desc" },
          select: { exchangeAccountId: true },
        });
        if (!sub) {
          res.status(404).json({ error: "Subscription not found for user and strategy" });
          return;
        }

        if (sub.exchangeAccountId) {
          const ex = await prisma.exchangeAccount.findUnique({
            where: { id: sub.exchangeAccountId },
            select: { apiKey: true, apiSecret: true },
          });
          apiKey = ex?.apiKey?.trim() ?? "";
          apiSecret = ex?.apiSecret?.trim() ?? "";
        }
        if (!apiKey || !apiSecret) {
          const fallback = await prisma.deltaApiKey.findFirst({
            where: { userId },
            orderBy: { id: "desc" },
            select: { apiKey: true, apiSecret: true },
          });
          apiKey = fallback?.apiKey?.trim() ?? apiKey;
          apiSecret = fallback?.apiSecret?.trim() ?? apiSecret;
        }
      }

      if (!apiKey || !apiSecret) {
        res.status(400).json({ error: "Delta credentials are missing for this account" });
        return;
      }

      const closeSide = oppositeSide(sideRaw as TradeSide);
      const result = await executeTrade(apiKey, apiSecret, symbol, closeSide, size, {
        reduceOnly: true,
      });
      if (!result.success) {
        res.status(502).json({ error: result.error ?? "Manual close order failed" });
        return;
      }

      res.json({ ok: true, orderId: result.orderId ?? null, raw: result.raw ?? null });
    } catch (err) {
      next(err);
    }
  }

  async function flushUserTrades(
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
      const out = await prisma.trade.deleteMany({ where: { userId } });
      res.json({ ok: true, deleted: out.count });
    } catch (err) {
      next(err);
    }
  }

  async function sendResetPasswordLink(
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
        select: { email: true },
      });
      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }
      const token = crypto.randomBytes(24).toString("hex");
      const base = (process.env.FRONTEND_URL ?? "http://localhost:3000").replace(
        /\/$/,
        "",
      );
      const resetLink = `${base}/reset-password?token=${token}&email=${encodeURIComponent(
        user.email,
      )}`;
      await sendPasswordResetLinkEmail(user.email, resetLink);
      res.json({ ok: true, message: "Password reset link sent successfully." });
    } catch (err) {
      next(err);
    }
  }

  async function getDashboardStats(
    _req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const [
        totalUsers,
        activeStrategies,
        pnlAgg,
        revenueAgg,
        pendingApprovals,
        recentTrades,
        leaderboardRows,
      ] =
        await Promise.all([
          prisma.user.count(),
          prisma.strategy.count({
            where: { subscriptions: { some: { status: "ACTIVE" } } },
          }),
          prisma.trade.aggregate({
            where: { status: TradeStatus.CLOSED },
            _sum: { tradePnl: true },
          }),
          prisma.trade.aggregate({
            where: { status: TradeStatus.CLOSED },
            _sum: { revenueShareAmt: true },
          }),
          prisma.profileUpdateRequest.count({ where: { status: "PENDING" } }),
          prisma.trade.findMany({
            orderBy: { createdAt: "desc" },
            take: 8,
            select: {
              id: true,
              symbol: true,
              side: true,
              status: true,
              tradePnl: true,
              createdAt: true,
              user: { select: { email: true } },
              strategy: { select: { title: true } },
            },
          }),
          prisma.trade.groupBy({
            by: ["userId"],
            where: { status: TradeStatus.CLOSED },
            _sum: { tradePnl: true },
            orderBy: { _sum: { tradePnl: "desc" } },
            take: 10,
          }),
        ]);

      const userIds = leaderboardRows.map((r) => r.userId);
      const users = await prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, name: true, email: true },
      });
      const userMap = new Map(users.map((u) => [u.id, u]));
      const leaderboard = leaderboardRows.map((r, idx) => ({
        rank: idx + 1,
        userId: r.userId,
        name: userMap.get(r.userId)?.name ?? null,
        email: userMap.get(r.userId)?.email ?? "Unknown",
        totalNetPnl: r._sum.tradePnl ?? 0,
      }));

      res.json({
        totalUsers,
        activeStrategies,
        totalPnlNet: pnlAgg._sum.tradePnl ?? 0,
        totalRevenue: revenueAgg._sum.revenueShareAmt ?? 0,
        pendingApprovals,
        leaderboard,
        recentLiveTrades: recentTrades.map((t) => ({
          id: t.id,
          symbol: t.symbol,
          side: t.side,
          status: t.status,
          pnl: t.tradePnl,
          createdAt: t.createdAt,
          userEmail: t.user.email,
          strategyTitle: t.strategy.title,
        })),
      });
    } catch (err) {
      next(err);
    }
  }

  async function getUserBalance(
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
        select: {
          id: true,
          email: true,
          exchangeAccounts: {
            orderBy: { createdAt: "desc" },
            take: 1,
            select: { apiKey: true, apiSecret: true },
          },
          deltaApiKeys: {
            orderBy: { id: "desc" },
            take: 1,
            select: { apiKey: true, apiSecret: true },
          },
        },
      });
      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }
      const creds =
        user.exchangeAccounts[0] ?? user.deltaApiKeys[0] ?? null;
      if (!creds) {
        res.status(400).json({ error: "No Delta credentials configured for this user" });
        return;
      }
      const totalBalanceUsd = await fetchDeltaTotalBalanceUsd(
        creds.apiKey,
        creds.apiSecret,
      );
      res.json({
        userId: user.id,
        email: user.email,
        totalBalanceUsd,
      });
    } catch (err) {
      next(err);
    }
  }

  async function listTransactions(
    _req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const rows = await prisma.transaction.findMany({
        orderBy: { createdAt: "desc" },
        include: {
          user: { select: { id: true, email: true, name: true } },
        },
      });
      res.json({
        transactions: rows.map((t) => ({
          id: t.id,
          userId: t.userId,
          userEmail: t.user.email,
          userName: t.user.name,
          amount: t.amount,
          type: t.type,
          status: t.status,
          createdAt: t.createdAt,
        })),
      });
    } catch (err) {
      next(err);
    }
  }

  return {
    getRevenueAnalytics,
    getUserTradesBilling,
    closeManualTrade,
    flushUserTrades,
    sendResetPasswordLink,
    getDashboardStats,
    getUserBalance,
    listTransactions,
  };
}

