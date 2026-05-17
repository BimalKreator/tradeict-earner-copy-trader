import type { NextFunction, Request, Response } from "express";
import { InvoiceStatus, SubscriptionStatus, TradeStatus, type PrismaClient } from "@prisma/client";
import {
  aggregateUsersAum,
  masterApiHealth,
  startOfUtcDay,
  startOfUtcMonth,
  systemClosedPnlSince,
  totalPendingRevenueAllUsers,
} from "../services/dashboardMetricsService.js";
import {
  EXIT_REASON,
  markBotInitiatedClose,
  setPendingStrategyExitReason,
} from "../constants/exitReasons.js";
import { closeOpenTradesForManualAdmin } from "../services/tradeEngine.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  executeTrade,
  fetchDeltaTicker,
  fetchDeltaTotalBalanceUsd,
  type TradeSide,
} from "../services/exchangeService.js";
import { sendPasswordResetLinkEmail } from "../utils/emailService.js";
import {
  buildTimestampTag,
  rowsToCsv,
  writeCsvToDownloads,
} from "../utils/exportService.js";

function realizedTradePnl(trade: { tradePnl: number; pnl: number | null }): number {
  if (Number.isFinite(trade.tradePnl) && trade.tradePnl !== 0) return trade.tradePnl;
  return Number.isFinite(trade.pnl ?? NaN) ? (trade.pnl as number) : 0;
}

/** Prevent CDN/proxy/browser caching of live admin dashboards (PnL must be fresh). */
export function applyNoStoreCacheHeaders(res: Response): void {
  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate",
  );
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
}

export function createAdminController(prisma: PrismaClient) {
  function parseDateRange(req: Request): {
    startDate?: Date;
    endDate?: Date;
  } {
    const startRaw = typeof req.query.startDate === "string" ? req.query.startDate : "";
    const endRaw = typeof req.query.endDate === "string" ? req.query.endDate : "";
    const startDate =
      startRaw.trim().length > 0 ? new Date(startRaw.trim()) : undefined;
    const endDate = endRaw.trim().length > 0 ? new Date(endRaw.trim()) : undefined;
    const out: { startDate?: Date; endDate?: Date } = {};
    if (startDate && Number.isFinite(startDate.getTime())) {
      out.startDate = startDate;
    }
    if (endDate && Number.isFinite(endDate.getTime())) {
      out.endDate = endDate;
    }
    return out;
  }

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
          exitReason: true,
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
          exitReason: t.exitReason,
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

  async function patchStrategyAutoExit(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const id = String(req.params.id ?? "").trim();
      if (!id) {
        res.status(400).json({ error: "strategy id is required" });
        return;
      }

      const body = req.body as {
        autoExitTarget?: unknown;
        autoExitStopLoss?: unknown;
      };

      const data: {
        autoExitTarget?: number | null;
        autoExitStopLoss?: number | null;
      } = {};

      if ("autoExitTarget" in body) {
        if (body.autoExitTarget === null) {
          data.autoExitTarget = null;
        } else if (
          typeof body.autoExitTarget === "number" &&
          Number.isFinite(body.autoExitTarget) &&
          body.autoExitTarget >= 0
        ) {
          data.autoExitTarget = body.autoExitTarget;
        } else {
          res.status(400).json({
            error: "autoExitTarget must be a non-negative number or null",
          });
          return;
        }
      }

      if ("autoExitStopLoss" in body) {
        if (body.autoExitStopLoss === null) {
          data.autoExitStopLoss = null;
        } else if (
          typeof body.autoExitStopLoss === "number" &&
          Number.isFinite(body.autoExitStopLoss) &&
          body.autoExitStopLoss > 0
        ) {
          data.autoExitStopLoss = body.autoExitStopLoss;
        } else {
          res.status(400).json({
            error: "autoExitStopLoss must be a positive number or null",
          });
          return;
        }
      }

      if (!("autoExitTarget" in body) && !("autoExitStopLoss" in body)) {
        res.status(400).json({
          error: "Provide autoExitTarget and/or autoExitStopLoss",
        });
        return;
      }

      const updated = await prisma.strategy.update({
        where: { id },
        data,
        select: {
          id: true,
          title: true,
          autoExitTarget: true,
          autoExitStopLoss: true,
        },
      });

      res.json(updated);
    } catch (err) {
      next(err);
    }
  }

  async function listAllTrades(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const limitRaw = req.query.limit;
      let limit = 200;
      if (typeof limitRaw === "string") {
        const parsed = Number(limitRaw);
        if (Number.isFinite(parsed)) {
          limit = Math.min(500, Math.max(1, Math.floor(parsed)));
        }
      }

      const statusRaw = req.query.status;
      const userIdRaw = req.query.userId;
      const allowedStatuses = new Set(["OPEN", "CLOSED", "FAILED"]);
      const where: {
        status?: TradeStatus;
        userId?: string;
      } = {};
      if (typeof statusRaw === "string") {
        const upper = statusRaw.trim().toUpperCase();
        if (allowedStatuses.has(upper)) {
          where.status = upper as TradeStatus;
        }
      }
      if (typeof userIdRaw === "string" && userIdRaw.trim()) {
        where.userId = userIdRaw.trim();
      }

      const rows = await prisma.trade.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        select: {
          id: true,
          createdAt: true,
          userId: true,
          strategyId: true,
          symbol: true,
          side: true,
          size: true,
          entryPrice: true,
          exitPrice: true,
          pnl: true,
          tradePnl: true,
          tradingFee: true,
          revenueShareAmt: true,
          status: true,
          exitReason: true,
          user: { select: { email: true, name: true } },
          strategy: { select: { title: true } },
        },
      });

      res.json({
        trades: rows.map((r) => ({
          id: r.id,
          createdAt: r.createdAt.toISOString(),
          userId: r.userId,
          userEmail: r.user.email,
          userName: r.user.name,
          strategyId: r.strategyId,
          strategyTitle: r.strategy.title,
          symbol: r.symbol,
          side: r.side,
          size: r.size,
          entryPrice: r.entryPrice,
          exitPrice: r.exitPrice,
          pnl: r.pnl,
          tradePnl: r.tradePnl,
          tradingFee: r.tradingFee,
          revenueShareAmt: r.revenueShareAmt,
          status: r.status,
          exitReason: r.exitReason,
        })),
      });
    } catch (err) {
      next(err);
    }
  }

  async function listUsersMinimal(
    _req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const users = await prisma.user.findMany({
        select: { id: true, email: true },
        orderBy: { email: "asc" },
      });
      res.json(users);
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
      markBotInitiatedClose(strategyId, symbol, EXIT_REASON.ADMIN_PANEL);
      setPendingStrategyExitReason(strategyId, EXIT_REASON.ADMIN_PANEL);

      const result = await executeTrade(apiKey, apiSecret, symbol, closeSide, size, {
        reduceOnly: true,
      });
      if (!result.success) {
        res.status(502).json({ error: result.error ?? "Manual close order failed" });
        return;
      }

      let dbClosed = 0;
      if (!isMaster && userId) {
        let exitPrice = 0;
        try {
          const tick = await fetchDeltaTicker(symbol);
          if (tick.last != null && Number.isFinite(tick.last)) {
            exitPrice = tick.last;
          }
        } catch {
          /* fallback below */
        }
        if (exitPrice <= 0) {
          const open = await prisma.trade.findFirst({
            where: {
              userId,
              strategyId,
              symbol,
              side: sideRaw,
              status: TradeStatus.OPEN,
            },
            select: { entryPrice: true },
          });
          exitPrice = open?.entryPrice ?? 0;
        }

        dbClosed = await closeOpenTradesForManualAdmin(prisma, {
          userId,
          strategyId,
          symbol,
          side: sideRaw as TradeSide,
          exitPrice,
          exitFee: result.feeCost ?? 0,
        });
      }

      res.json({
        ok: true,
        orderId: result.orderId ?? null,
        raw: result.raw ?? null,
        dbTradesClosed: dbClosed,
      });
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
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, email: true },
      });
      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }
      const flushableTrades = await prisma.trade.findMany({
        where: { userId, status: { not: TradeStatus.OPEN } },
        orderBy: { createdAt: "desc" },
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
          tradingFee: true,
          revenueShareAmt: true,
          status: true,
        },
      });
      if (flushableTrades.length === 0) {
        res.json({
          ok: true,
          deleted: 0,
          message: "No closed or failed trades found. Open trades were preserved.",
        });
        return;
      }
      const safeUserName = (user.name?.trim() || user.email || user.id).replace(
        /[^a-zA-Z0-9_-]/g,
        "_",
      );
      const fileName = `Flush_Trades_${safeUserName}_${buildTimestampTag()}.csv`;
      const csv = rowsToCsv(
        flushableTrades.map((t) => ({
          id: t.id,
          createdAt: t.createdAt.toISOString(),
          strategyId: t.strategyId,
          symbol: t.symbol,
          side: t.side,
          size: t.size,
          entryPrice: t.entryPrice,
          exitPrice: t.exitPrice ?? "",
          netPnl: t.tradePnl,
          tradingFee: t.tradingFee,
          revenueShareAmt: t.revenueShareAmt,
          status: t.status,
        })),
        [
          { key: "id", label: "Trade ID" },
          { key: "createdAt", label: "Created At" },
          { key: "strategyId", label: "Strategy ID" },
          { key: "symbol", label: "Symbol" },
          { key: "side", label: "Side" },
          { key: "size", label: "Size" },
          { key: "entryPrice", label: "Entry Price" },
          { key: "exitPrice", label: "Exit Price" },
          { key: "netPnl", label: "Net PnL" },
          { key: "tradingFee", label: "Trading Fee" },
          { key: "revenueShareAmt", label: "Admin Revenue Share" },
          { key: "status", label: "Status" },
        ],
      );
      const saved = writeCsvToDownloads(fileName, csv);
      await prisma.downloadFile.create({
        data: {
          fileName,
          filePath: saved.relativePath,
          fileType: "FLUSH_BACKUP",
          status: "READY",
        },
      });
      const out = await prisma.trade.deleteMany({
        where: { userId, status: { not: TradeStatus.OPEN } },
      });
      res.json({
        ok: true,
        deleted: out.count,
        backupFile: saved.relativePath,
      });
    } catch (err) {
      next(err);
    }
  }

  async function exportTrades(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const { startDate, endDate } = parseDateRange(req);
      const body = req.body as {
        userId?: unknown;
        strategyId?: unknown;
      };
      const userId =
        typeof body.userId === "string" && body.userId.trim().length > 0
          ? body.userId.trim()
          : undefined;
      const strategyId =
        typeof body.strategyId === "string" && body.strategyId.trim().length > 0
          ? body.strategyId.trim()
          : undefined;
      const rows = await prisma.trade.findMany({
        where: {
          ...(userId ? { userId } : {}),
          ...(strategyId ? { strategyId } : {}),
          ...(startDate || endDate
            ? {
                createdAt: {
                  ...(startDate ? { gte: startDate } : {}),
                  ...(endDate ? { lte: endDate } : {}),
                },
              }
            : {}),
        },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          createdAt: true,
          userId: true,
          strategyId: true,
          symbol: true,
          side: true,
          size: true,
          entryPrice: true,
          exitPrice: true,
          tradePnl: true,
          tradingFee: true,
          revenueShareAmt: true,
          status: true,
          exitReason: true,
        },
      });
      const csv = rowsToCsv(
        rows.map((r) => ({
          id: r.id,
          createdAt: r.createdAt.toISOString(),
          userId: r.userId,
          strategyId: r.strategyId,
          symbol: r.symbol,
          side: r.side,
          size: r.size,
          entryPrice: r.entryPrice,
          exitPrice: r.exitPrice ?? "",
          netPnl: r.tradePnl,
          tradingFee: r.tradingFee,
          revenueShareAmt: r.revenueShareAmt,
          status: r.status,
          exitReason: r.exitReason ?? "",
        })),
        [
          { key: "id", label: "Trade ID" },
          { key: "createdAt", label: "Created At" },
          { key: "userId", label: "User ID" },
          { key: "strategyId", label: "Strategy ID" },
          { key: "symbol", label: "Symbol" },
          { key: "side", label: "Side" },
          { key: "size", label: "Size" },
          { key: "entryPrice", label: "Entry Price" },
          { key: "exitPrice", label: "Exit Price" },
          { key: "netPnl", label: "Net PnL" },
          { key: "tradingFee", label: "Trading Fee" },
          { key: "revenueShareAmt", label: "Admin Revenue Share" },
          { key: "status", label: "Status" },
          { key: "exitReason", label: "Close Reason" },
        ],
      );
      const fileName = `Admin_Trades_Export_${buildTimestampTag()}.csv`;
      const saved = writeCsvToDownloads(fileName, csv);
      const row = await prisma.downloadFile.create({
        data: {
          fileName,
          filePath: saved.relativePath,
          fileType: "TRADES",
          status: "READY",
        },
      });
      res.status(201).json({
        ok: true,
        download: {
          id: row.id,
          fileName: row.fileName,
          filePath: row.filePath,
          fileType: row.fileType,
          status: row.status,
          createdAt: row.createdAt,
        },
      });
    } catch (err) {
      next(err);
    }
  }

  async function listDownloads(
    _req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const rows = await prisma.downloadFile.findMany({
        orderBy: { createdAt: "desc" },
      });
      res.json({ downloads: rows });
    } catch (err) {
      next(err);
    }
  }

  async function deleteDownload(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const id = String(req.params.id ?? "").trim();
      if (!id) {
        res.status(400).json({ error: "Download id is required." });
        return;
      }
      const row = await prisma.downloadFile.findUnique({ where: { id } });
      if (!row) {
        res.status(404).json({ error: "Download file not found." });
        return;
      }
      const relativePath = row.filePath.startsWith("/")
        ? row.filePath.slice(1)
        : row.filePath;
      const absolutePath = path.resolve(process.cwd(), "public", relativePath);
      if (fs.existsSync(absolutePath)) {
        fs.unlinkSync(absolutePath);
      }
      await prisma.downloadFile.delete({ where: { id: row.id } });
      res.json({ ok: true });
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
      const dayStart = startOfUtcDay();
      const monthStart = startOfUtcMonth();

      const [
        totalUsers,
        activeSubscribers,
        totalAUM,
        systemTodayPnl,
        systemMonthlyPnl,
        totalPendingRevenue,
        masterApi,
        pendingApprovals,
        recentTrades,
        leaderboardRows,
      ] =
        await Promise.all([
          prisma.user.count({ where: { role: "USER" } }),
          prisma.userSubscription.count({
            where: { status: SubscriptionStatus.ACTIVE },
          }),
          aggregateUsersAum(prisma),
          systemClosedPnlSince(prisma, dayStart),
          systemClosedPnlSince(prisma, monthStart),
          totalPendingRevenueAllUsers(prisma),
          masterApiHealth(prisma),
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
        activeSubscribers,
        totalAUM,
        systemTodayPnl,
        systemMonthlyPnl,
        totalPendingRevenue,
        masterApiStatus: masterApi.connected ? "connected" : "disconnected",
        masterApiStrategyTitle: masterApi.strategyTitle,
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

  async function listAllDeposits(
    _req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const rows = await prisma.depositRequest.findMany({
        orderBy: { createdAt: "desc" },
        include: {
          user: { select: { id: true, email: true, name: true } },
        },
      });
      res.json({
        deposits: rows.map((r) => ({
          id: r.id,
          userId: r.userId,
          userEmail: r.user.email,
          userName: r.user.name,
          amount: r.amount,
          transactionId: r.transactionId,
          screenshotUrl: r.screenshotUrl,
          status: r.status,
          adminReason: r.adminReason,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        })),
      });
    } catch (err) {
      next(err);
    }
  }

  async function updateDepositStatus(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const id = String(req.params.id ?? "").trim();
      const status = String((req.body as { status?: unknown }).status ?? "")
        .trim()
        .toUpperCase();
      const adminReasonRaw = (req.body as { adminReason?: unknown }).adminReason;
      const adminReason =
        typeof adminReasonRaw === "string" && adminReasonRaw.trim() !== ""
          ? adminReasonRaw.trim()
          : null;

      if (!id) {
        res.status(400).json({ error: "Deposit request id is required." });
        return;
      }
      if (status !== "APPROVED" && status !== "REJECTED") {
        res
          .status(400)
          .json({ error: "status must be either APPROVED or REJECTED." });
        return;
      }

      const deposit = await prisma.depositRequest.findUnique({
        where: { id },
        include: { paymentTransaction: true },
      });
      if (!deposit) {
        res.status(404).json({ error: "Deposit request not found" });
        return;
      }

      const updated = await prisma.$transaction(async (tx) => {
        const row = await tx.depositRequest.update({
          where: { id },
          data: { status, adminReason },
        });

        if (status === "APPROVED" && deposit.paymentTransaction) {
          const pay = deposit.paymentTransaction;
          if (pay.status !== "APPROVED") {
            const netUsd =
              deposit.netCreditUsd ??
              pay.netCreditUsd ??
              deposit.amount / 83;

            let wallet = await tx.wallet.findUnique({
              where: { userId: deposit.userId },
            });
            if (!wallet) {
              wallet = await tx.wallet.create({
                data: {
                  userId: deposit.userId,
                  balance: 0,
                  pendingFees: 0,
                },
              });
            }

            await tx.wallet.update({
              where: { id: wallet.id },
              data: { balance: { increment: netUsd } },
            });

            await tx.walletTransaction.create({
              data: {
                walletId: wallet.id,
                amount: netUsd,
                type: "MANUAL_DEPOSIT",
                status: "COMPLETED",
              },
            });

            await tx.paymentTransaction.update({
              where: { id: pay.id },
              data: { status: "APPROVED" },
            });
          }
        }

        if (status === "REJECTED" && deposit.paymentTransaction) {
          await tx.paymentTransaction.update({
            where: { id: deposit.paymentTransaction.id },
            data: { status: "REJECTED" },
          });
        }

        return row;
      });

      await prisma.notification.create({
        data: {
          userId: updated.userId,
          title: "Deposit Request Update",
          message:
            status === "APPROVED"
              ? "Your deposit request has been approved and your wallet has been credited."
              : `Your deposit request has been rejected.${
                  adminReason ? ` Reason: ${adminReason}` : ""
                }`,
        },
      });

      res.json({ ok: true, deposit: updated });
    } catch (err) {
      next(err);
    }
  }

  return {
    getRevenueAnalytics,
    getUserTradesBilling,
    listAllTrades,
    listUsersMinimal,
    patchStrategyAutoExit,
    closeManualTrade,
    flushUserTrades,
    exportTrades,
    listDownloads,
    deleteDownload,
    sendResetPasswordLink,
    getDashboardStats,
    getUserBalance,
    listTransactions,
    listAllDeposits,
    updateDepositStatus,
  };
}

