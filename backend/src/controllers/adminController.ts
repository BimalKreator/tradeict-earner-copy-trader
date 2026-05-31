import type { NextFunction, Request, Response } from "express";
import {
  InvoiceStatus,
  Role,
  SubscriptionStatus,
  TradeStatus,
  UserStatus,
  type PrismaClient,
} from "@prisma/client";
import {
  aggregateUsersAum,
  fetchUserAvailableCapital,
  fetchUserCapitalBreakdown,
  masterApiHealth,
  resolveUserDeltaCreds,
  startOfUtcDay,
  startOfUtcMonth,
  systemClosedPnlSince,
  totalPendingRevenueAllUsers,
} from "../services/dashboardMetricsService.js";
import {
  buildFlushableTradeWhere,
  purgeAnalyticsForDeletedTrades,
} from "../services/tradeFlushService.js";
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
import {
  MAX_SUBSCRIPTION_MULTIPLIER,
  MIN_SUBSCRIPTION_MULTIPLIER,
} from "../constants/subscription.js";
import { getAdminLiveTradesByStrategy } from "../services/liveTradesService.js";

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
        autoExitEnabled?: unknown;
      };

      const data: {
        autoExitTarget?: number | null;
        autoExitStopLoss?: number | null;
        autoExitEnabled?: boolean;
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

      if ("autoExitEnabled" in body) {
        if (typeof body.autoExitEnabled === "boolean") {
          data.autoExitEnabled = body.autoExitEnabled;
        } else {
          res.status(400).json({
            error: "autoExitEnabled must be a boolean",
          });
          return;
        }
      }

      if (
        !("autoExitTarget" in body) &&
        !("autoExitStopLoss" in body) &&
        !("autoExitEnabled" in body)
      ) {
        res.status(400).json({
          error:
            "Provide autoExitTarget, autoExitStopLoss, and/or autoExitEnabled",
        });
        return;
      }

      const updated = await prisma.strategy.update({
        where: { id },
        data,
        select: {
          id: true,
          title: true,
          autoExitEnabled: true,
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

  /** Per-user Delta balance fetch timeout (admin list — avoid blocking page load). */
  const ADMIN_DELTA_BALANCE_TIMEOUT_MS = 12_000;
  /** Max concurrent Delta balance API calls when listing users. */
  const ADMIN_DELTA_BALANCE_CONCURRENCY = 4;

  async function mapWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    fn: (item: T, index: number) => Promise<R>,
  ): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let nextIndex = 0;
    async function worker(): Promise<void> {
      for (;;) {
        const i = nextIndex;
        nextIndex += 1;
        if (i >= items.length) return;
        results[i] = await fn(items[i]!, i);
      }
    }
    const workers = Math.min(Math.max(1, concurrency), items.length || 1);
    await Promise.all(Array.from({ length: workers }, () => worker()));
    return results;
  }

  async function fetchAdminUserDeltaBalanceUsd(userId: string): Promise<{
    deltaBalance: number | null;
    deltaConnected: boolean;
  }> {
    const creds = await resolveUserDeltaCreds(prisma, userId);
    if (!creds) {
      return { deltaBalance: null, deltaConnected: false };
    }
    try {
      const breakdown = await Promise.race([
        fetchUserCapitalBreakdown(prisma, userId),
        new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error("Delta balance fetch timed out")),
            ADMIN_DELTA_BALANCE_TIMEOUT_MS,
          );
        }),
      ]);
      return {
        deltaBalance: breakdown.totalBalance,
        deltaConnected: true,
      };
    } catch (err) {
      console.warn(
        `[admin] Delta balance fetch failed userId=${userId}:`,
        err instanceof Error ? err.message : err,
      );
      return { deltaBalance: null, deltaConnected: true };
    }
  }

  /**
   * GET /api/admin/users
   * Platform users with PnL, internal wallet balance (DB), and live Delta balance (batched REST).
   */
  async function listUsersForAdmin(
    _req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const users = await prisma.user.findMany({
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          status: true,
          createdAt: true,
          wallet: { select: { balance: true } },
        },
        orderBy: { createdAt: "desc" },
      });

      const pnlAgg = await prisma.trade.groupBy({
        by: ["userId"],
        _sum: { tradePnl: true },
      });
      const pnlByUser = new Map<string, number>(
        pnlAgg.map((r) => [r.userId, r._sum.tradePnl ?? 0]),
      );

      const deltaByUserId = new Map<
        string,
        { deltaBalance: number | null; deltaConnected: boolean }
      >();

      await mapWithConcurrency(
        users,
        ADMIN_DELTA_BALANCE_CONCURRENCY,
        async (user) => {
          const result = await fetchAdminUserDeltaBalanceUsd(user.id);
          deltaByUserId.set(user.id, result);
        },
      );

      res.json(
        users.map((u) => {
          const delta = deltaByUserId.get(u.id) ?? {
            deltaBalance: null,
            deltaConnected: false,
          };
          return {
            id: u.id,
            name: u.name,
            email: u.email,
            role: u.role,
            status: u.status,
            createdAt: u.createdAt,
            totalPnlToDate: pnlByUser.get(u.id) ?? 0,
            walletBalance: u.wallet?.balance ?? 0,
            deltaBalance: delta.deltaBalance,
            deltaConnected: delta.deltaConnected,
          };
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  /** Split stored `name` into first/last for admin UI (schema uses single `name` field). */
  function splitUserName(name: string | null): {
    firstName: string | null;
    lastName: string | null;
  } {
    if (!name?.trim()) {
      return { firstName: null, lastName: null };
    }
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 1) {
      return { firstName: parts[0] ?? null, lastName: null };
    }
    return {
      firstName: parts[0] ?? null,
      lastName: parts.slice(1).join(" ") || null,
    };
  }

  function formatSearchUser(user: {
    id: string;
    email: string;
    name: string | null;
    mobile: string | null;
  }) {
    const { firstName, lastName } = splitUserName(user.name);
    const label = [firstName, lastName].filter(Boolean).join(" ") || user.email;
    return {
      id: user.id,
      email: user.email,
      firstName,
      lastName,
      phone: user.mobile,
      label,
    };
  }

  /**
   * GET /api/admin/users/search?q=
   * Case-insensitive search on name, email, and mobile (phone). Max 20 results.
   */
  async function searchUsers(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const q = String(req.query.q ?? "").trim();
      if (q.length < 3) {
        res.json({ users: [] });
        return;
      }

      const users = await prisma.user.findMany({
        where: {
          role: Role.USER,
          OR: [
            { email: { contains: q, mode: "insensitive" } },
            { name: { contains: q, mode: "insensitive" } },
            { mobile: { contains: q, mode: "insensitive" } },
          ],
        },
        select: { id: true, email: true, name: true, mobile: true },
        orderBy: { email: "asc" },
        take: 20,
      });

      res.json({ users: users.map(formatSearchUser) });
    } catch (err) {
      next(err);
    }
  }

  /**
   * PUT /api/admin/users/:id
   * Profile fields: firstName, lastName, email, phone (mobile), status; optional role.
   */
  async function updateUserProfile(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const id = String(req.params.id ?? "").trim();
      if (!id) {
        res.status(400).json({ error: "User id is required" });
        return;
      }

      const body = req.body as {
        firstName?: unknown;
        lastName?: unknown;
        email?: unknown;
        phone?: unknown;
        status?: unknown;
        role?: unknown;
        arbitrageSourceUserId?: unknown;
      };

      const existing = await prisma.user.findUnique({
        where: { id },
        select: {
          id: true,
          email: true,
          name: true,
          mobile: true,
          status: true,
          role: true,
          arbitrageSourceUserId: true,
        },
      });
      if (!existing) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      const data: {
        name?: string | null;
        email?: string;
        mobile?: string | null;
        status?: UserStatus;
        role?: Role;
        arbitrageSourceUserId?: string | null;
      } = {};

      if (body.firstName !== undefined || body.lastName !== undefined) {
        const first =
          typeof body.firstName === "string" ? body.firstName.trim() : "";
        const last =
          typeof body.lastName === "string" ? body.lastName.trim() : "";
        const combined = [first, last].filter(Boolean).join(" ").trim();
        data.name = combined.length > 0 ? combined : null;
      }

      if (body.email !== undefined) {
        if (typeof body.email !== "string" || !body.email.trim()) {
          res.status(400).json({ error: "email must be a non-empty string" });
          return;
        }
        const email = body.email.trim().toLowerCase();
        if (email !== existing.email) {
          const clash = await prisma.user.findUnique({
            where: { email },
            select: { id: true },
          });
          if (clash && clash.id !== id) {
            res.status(409).json({ error: "Email is already in use" });
            return;
          }
        }
        data.email = email;
      }

      if (body.phone !== undefined) {
        if (body.phone === null || body.phone === "") {
          data.mobile = null;
        } else if (typeof body.phone === "string") {
          data.mobile = body.phone.trim() || null;
        } else {
          res.status(400).json({ error: "phone must be a string or null" });
          return;
        }
      }

      if (body.status !== undefined) {
        const status = String(body.status).toUpperCase();
        if (status !== UserStatus.ACTIVE && status !== UserStatus.SUSPENDED) {
          res.status(400).json({ error: "status must be ACTIVE or SUSPENDED" });
          return;
        }
        data.status = status as UserStatus;
      }

      if (body.role !== undefined) {
        const role = String(body.role).toUpperCase();
        if (role !== Role.ADMIN && role !== Role.USER) {
          res.status(400).json({ error: "role must be ADMIN or USER" });
          return;
        }
        data.role = role as Role;
      }

      if (body.arbitrageSourceUserId !== undefined) {
        if (body.arbitrageSourceUserId === null || body.arbitrageSourceUserId === "") {
          data.arbitrageSourceUserId = null;
        } else if (typeof body.arbitrageSourceUserId === "string") {
          const sourceId = body.arbitrageSourceUserId.trim();
          if (!sourceId) {
            data.arbitrageSourceUserId = null;
          } else if (sourceId === id) {
            res.status(400).json({
              error: "arbitrageSourceUserId cannot be the same as the user id",
            });
            return;
          } else {
            const source = await prisma.user.findUnique({
              where: { id: sourceId },
              select: { id: true },
            });
            if (!source) {
              res.status(400).json({ error: "arbitrageSourceUserId user not found" });
              return;
            }
            data.arbitrageSourceUserId = sourceId;
          }
        } else {
          res.status(400).json({
            error: "arbitrageSourceUserId must be a string, null, or empty to clear",
          });
          return;
        }
      }

      if (Object.keys(data).length === 0) {
        res.status(400).json({
          error:
            "Provide at least one of firstName, lastName, email, phone, status, role, or arbitrageSourceUserId",
        });
        return;
      }

      const user = await prisma.user.update({
        where: { id },
        data,
        select: {
          id: true,
          email: true,
          name: true,
          mobile: true,
          status: true,
          role: true,
          arbitrageSourceUserId: true,
          createdAt: true,
        },
      });

      const { firstName, lastName } = splitUserName(user.name);
      res.json({
        user: {
          id: user.id,
          email: user.email,
          firstName,
          lastName,
          name: user.name,
          phone: user.mobile,
          mobile: user.mobile,
          status: user.status,
          role: user.role,
          arbitrageSourceUserId: user.arbitrageSourceUserId,
          createdAt: user.createdAt,
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
        const sub = await prisma.userStrategySubscription.findFirst({
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
      const body = (req.body ?? {}) as { userId?: unknown; tradeIds?: unknown };
      const userId = String(
        body.userId ?? req.params.id ?? "",
      ).trim();
      if (!userId) {
        res.status(400).json({ error: "userId is required" });
        return;
      }

      const tradeIdsRaw = body.tradeIds;
      const tradeIds =
        Array.isArray(tradeIdsRaw) && tradeIdsRaw.length > 0
          ? tradeIdsRaw
              .filter((id): id is string => typeof id === "string" && id.trim() !== "")
              .map((id) => id.trim())
          : undefined;

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, email: true },
      });
      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      const where = buildFlushableTradeWhere(userId, tradeIds);
      const flushableTrades = await prisma.trade.findMany({
        where,
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
          pnl: true,
          tradingFee: true,
          revenueShareAmt: true,
          status: true,
        },
      });

      if (flushableTrades.length === 0) {
        res.json({
          ok: true,
          deleted: 0,
          analyticsRemoved: 0,
          message: tradeIds?.length
            ? "No matching closed or failed trades found for the selected ids."
            : "No closed or failed trades found. Open trades were preserved.",
        });
        return;
      }

      const openInSelection =
        tradeIds != null &&
        (await prisma.trade.count({
          where: { userId, id: { in: tradeIds }, status: TradeStatus.OPEN },
        })) > 0;
      if (openInSelection) {
        res.status(400).json({
          error: "Open trades cannot be flushed. Deselect open positions.",
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

      const flushAll = !tradeIds?.length;
      const tradeIdsToDelete = flushableTrades.map((t) => t.id);

      const result = await prisma.$transaction(async (tx) => {
        const deletedTrades = await tx.trade.deleteMany({
          where: { id: { in: tradeIdsToDelete }, userId },
        });
        const analyticsRemoved = await purgeAnalyticsForDeletedTrades(
          tx,
          userId,
          flushableTrades,
          flushAll,
        );
        return { deletedTrades: deletedTrades.count, analyticsRemoved };
      });

      res.json({
        ok: true,
        deleted: result.deletedTrades,
        analyticsRemoved: result.analyticsRemoved,
        backupFile: saved.relativePath,
      });
    } catch (err) {
      next(err);
    }
  }

  async function flushArbitrageTrades(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const body = (req.body ?? {}) as { userId?: unknown; tradeIds?: unknown };
      const userId = String(body.userId ?? req.params.id ?? "").trim();
      if (!userId) {
        res.status(400).json({ error: "userId is required" });
        return;
      }

      const tradeIdsRaw = body.tradeIds;
      const tradeIds =
        Array.isArray(tradeIdsRaw) && tradeIdsRaw.length > 0
          ? tradeIdsRaw
              .filter((id): id is string => typeof id === "string" && id.trim() !== "")
              .map((id) => id.trim())
          : undefined;

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, email: true, cryptoBalance: true },
      });
      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      const tradesToFlush = await prisma.arbitrageTrade.findMany({
        where: {
          userId,
          ...(tradeIds?.length ? { id: { in: tradeIds } } : {}),
        },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          token: true,
          qty: true,
          buyPrice: true,
          sellPrice: true,
          buyDex: true,
          sellDex: true,
          feePercent: true,
          feeAmount: true,
          netProfit: true,
          createdAt: true,
        },
      });

      if (tradesToFlush.length === 0) {
        res.json({
          ok: true,
          deleted: 0,
          netProfitReversed: 0,
          message: tradeIds?.length
            ? "No matching arbitrage trades found for the selected ids."
            : "No arbitrage trades to flush.",
        });
        return;
      }

      const netProfitSum = tradesToFlush.reduce(
        (sum, t) => sum + (Number.isFinite(t.netProfit) ? t.netProfit : 0),
        0,
      );
      const tradeIdsToDelete = tradesToFlush.map((t) => t.id);

      const result = await prisma.$transaction(async (tx) => {
        const deleted = await tx.arbitrageTrade.deleteMany({
          where: { id: { in: tradeIdsToDelete }, userId },
        });
        const nextBalance = Math.max(0, user.cryptoBalance - netProfitSum);
        await tx.user.update({
          where: { id: userId },
          data: { cryptoBalance: nextBalance },
        });
        return { deleted: deleted.count };
      });

      res.json({
        ok: true,
        deleted: result.deleted,
        netProfitReversed: netProfitSum,
        cryptoBalance: Math.max(0, user.cryptoBalance - netProfitSum),
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
          prisma.userStrategySubscription.count({
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
        select: { id: true, email: true },
      });
      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      const base = {
        userId: user.id,
        email: user.email,
        balance: 0,
        totalBalanceUsd: 0,
      };

      const creds = await resolveUserDeltaCreds(prisma, userId);
      if (!creds) {
        res.status(200).json({
          ...base,
          status: "Not Connected",
          error: "No Delta credentials configured for this user",
        });
        return;
      }

      try {
        const totalBalanceUsd = await fetchUserAvailableCapital(prisma, userId);
        res.status(200).json({
          ...base,
          balance: totalBalanceUsd,
          totalBalanceUsd,
          status: "Connected",
        });
      } catch (fetchErr) {
        const message =
          fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
        res.status(200).json({
          ...base,
          status: "Not Connected",
          error: message,
        });
      }
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

  async function listUserArbitrageWithdrawals(
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
        select: { id: true },
      });
      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      const rows = await prisma.arbitrageWithdrawal.findMany({
        where: { userId },
        orderBy: { date: "desc" },
        select: {
          id: true,
          amount: true,
          date: true,
          createdAt: true,
        },
      });

      res.json({
        userId,
        withdrawals: rows.map((w) => ({
          id: w.id,
          amount: w.amount,
          date: w.date.toISOString(),
          createdAt: w.createdAt.toISOString(),
        })),
      });
    } catch (err) {
      next(err);
    }
  }

  async function createUserArbitrageWithdrawal(
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

      const body = req.body as { amount?: unknown; date?: unknown };
      const amount = Number(body.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        res.status(400).json({ error: "amount must be a positive number" });
        return;
      }

      if (typeof body.date !== "string" || !body.date.trim()) {
        res.status(400).json({ error: "date is required (ISO 8601 string)" });
        return;
      }
      const date = new Date(body.date);
      if (Number.isNaN(date.getTime())) {
        res.status(400).json({ error: "date must be a valid ISO 8601 datetime" });
        return;
      }

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true },
      });
      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      const withdrawal = await prisma.arbitrageWithdrawal.create({
        data: { userId, amount, date },
        select: {
          id: true,
          userId: true,
          amount: true,
          date: true,
          createdAt: true,
        },
      });

      res.status(201).json({
        withdrawal: {
          id: withdrawal.id,
          userId: withdrawal.userId,
          amount: withdrawal.amount,
          date: withdrawal.date.toISOString(),
          createdAt: withdrawal.createdAt.toISOString(),
        },
      });
    } catch (err) {
      next(err);
    }
  }

  const ARBITRAGE_SYNC_BATCH = 500;

  /**
   * Hard-sync target user's arbitrage ledger from `arbitrageSourceUserId`:
   * balance, trades, and withdrawals are replaced with copies from the source user.
   */
  async function syncUserArbitrage(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const targetUserId = String(req.params.id ?? "").trim();
      if (!targetUserId) {
        res.status(400).json({ error: "User id is required" });
        return;
      }

      const target = await prisma.user.findUnique({
        where: { id: targetUserId },
        select: {
          id: true,
          email: true,
          arbitrageSourceUserId: true,
        },
      });
      if (!target) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      const sourceUserId = target.arbitrageSourceUserId?.trim();
      if (!sourceUserId) {
        res.status(400).json({
          error: "Target user has no arbitrageSourceUserId configured",
        });
        return;
      }
      if (sourceUserId === targetUserId) {
        res.status(400).json({
          error: "arbitrageSourceUserId cannot be the same as the target user",
        });
        return;
      }

      const source = await prisma.user.findUnique({
        where: { id: sourceUserId },
        select: { id: true, email: true, cryptoBalance: true },
      });
      if (!source) {
        res.status(400).json({ error: "Arbitrage source user not found" });
        return;
      }

      const [sourceTrades, sourceWithdrawals] = await Promise.all([
        prisma.arbitrageTrade.findMany({
          where: { userId: sourceUserId },
          select: {
            token: true,
            qty: true,
            buyPrice: true,
            sellPrice: true,
            buyDex: true,
            sellDex: true,
            feePercent: true,
            feeAmount: true,
            netProfit: true,
            createdAt: true,
          },
        }),
        prisma.arbitrageWithdrawal.findMany({
          where: { userId: sourceUserId },
          select: {
            amount: true,
            date: true,
            createdAt: true,
          },
        }),
      ]);

      const summary = await prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: targetUserId },
          data: { cryptoBalance: source.cryptoBalance },
        });

        const deletedTrades = await tx.arbitrageTrade.deleteMany({
          where: { userId: targetUserId },
        });
        const deletedWithdrawals = await tx.arbitrageWithdrawal.deleteMany({
          where: { userId: targetUserId },
        });

        const tradeRows = sourceTrades.map((t) => ({
          userId: targetUserId,
          token: t.token,
          qty: t.qty,
          buyPrice: t.buyPrice,
          sellPrice: t.sellPrice,
          buyDex: t.buyDex,
          sellDex: t.sellDex,
          feePercent: t.feePercent,
          feeAmount: t.feeAmount,
          netProfit: t.netProfit,
          createdAt: t.createdAt,
        }));

        for (let i = 0; i < tradeRows.length; i += ARBITRAGE_SYNC_BATCH) {
          await tx.arbitrageTrade.createMany({
            data: tradeRows.slice(i, i + ARBITRAGE_SYNC_BATCH),
          });
        }

        const withdrawalRows = sourceWithdrawals.map((w) => ({
          userId: targetUserId,
          amount: w.amount,
          date: w.date,
          createdAt: w.createdAt,
        }));

        for (let i = 0; i < withdrawalRows.length; i += ARBITRAGE_SYNC_BATCH) {
          await tx.arbitrageWithdrawal.createMany({
            data: withdrawalRows.slice(i, i + ARBITRAGE_SYNC_BATCH),
          });
        }

        return {
          deletedTrades: deletedTrades.count,
          deletedWithdrawals: deletedWithdrawals.count,
          insertedTrades: tradeRows.length,
          insertedWithdrawals: withdrawalRows.length,
        };
      });

      res.json({
        ok: true,
        message:
          "Arbitrage balance, trades, and withdrawals synced from source user.",
        targetUserId,
        targetEmail: target.email,
        sourceUserId,
        sourceEmail: source.email,
        cryptoBalance: source.cryptoBalance,
        ...summary,
      });
    } catch (err) {
      next(err);
    }
  }

  const cryptoArbitrageSelect = {
    id: true,
    cryptoArbitrageEnabled: true,
    cryptoBalance: true,
    cryptoCapitalPerTradePercent: true,
  } as const;

  async function getUserCryptoArbitrage(
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
        select: cryptoArbitrageSelect,
      });
      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }
      res.json({
        userId: user.id,
        cryptoArbitrageEnabled: user.cryptoArbitrageEnabled,
        cryptoBalance: user.cryptoBalance,
        cryptoCapitalPerTradePercent: user.cryptoCapitalPerTradePercent,
      });
    } catch (err) {
      next(err);
    }
  }

  async function patchUserCryptoArbitrageEnabled(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = String(req.params.id ?? "").trim();
      const body = req.body as { enabled?: unknown; cryptoArbitrageEnabled?: unknown };
      const enabled =
        typeof body.enabled === "boolean"
          ? body.enabled
          : typeof body.cryptoArbitrageEnabled === "boolean"
            ? body.cryptoArbitrageEnabled
            : undefined;
      if (enabled === undefined) {
        res.status(400).json({ error: "Provide enabled (boolean)" });
        return;
      }
      const user = await prisma.user.update({
        where: { id: userId },
        data: { cryptoArbitrageEnabled: enabled },
        select: cryptoArbitrageSelect,
      });
      res.json({
        userId: user.id,
        cryptoArbitrageEnabled: user.cryptoArbitrageEnabled,
        cryptoBalance: user.cryptoBalance,
        cryptoCapitalPerTradePercent: user.cryptoCapitalPerTradePercent,
      });
    } catch (err) {
      next(err);
    }
  }

  async function patchUserCryptoArbitrageBalance(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = String(req.params.id ?? "").trim();
      const body = req.body as {
        balance?: unknown;
        delta?: unknown;
        adjustment?: unknown;
      };

      const existing = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, cryptoBalance: true },
      });
      if (!existing) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      let nextBalance: number | undefined;
      if (typeof body.balance === "number" && Number.isFinite(body.balance)) {
        nextBalance = Math.max(0, body.balance);
      } else {
        const deltaRaw =
          typeof body.delta === "number"
            ? body.delta
            : typeof body.adjustment === "number"
              ? body.adjustment
              : undefined;
        if (deltaRaw === undefined || !Number.isFinite(deltaRaw)) {
          res.status(400).json({
            error: "Provide balance (absolute) or delta/adjustment (add/subtract)",
          });
          return;
        }
        nextBalance = Math.max(0, existing.cryptoBalance + deltaRaw);
      }

      const user = await prisma.user.update({
        where: { id: userId },
        data: { cryptoBalance: nextBalance },
        select: cryptoArbitrageSelect,
      });
      res.json({
        userId: user.id,
        cryptoArbitrageEnabled: user.cryptoArbitrageEnabled,
        cryptoBalance: user.cryptoBalance,
        cryptoCapitalPerTradePercent: user.cryptoCapitalPerTradePercent,
      });
    } catch (err) {
      next(err);
    }
  }

  function parseSubscriptionMultiplier(v: unknown): number | null {
    const n =
      typeof v === "number"
        ? v
        : typeof v === "string"
          ? Number(v)
          : NaN;
    if (!Number.isFinite(n) || n < MIN_SUBSCRIPTION_MULTIPLIER) return null;
    if (n > MAX_SUBSCRIPTION_MULTIPLIER) return null;
    return Math.round(n * 10) / 10;
  }

  /** Live trades grouped by strategy (master + subscribers per strategy). */
  async function getGroupedLiveTrades(
    _req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const groups = await getAdminLiveTradesByStrategy(prisma);
      applyNoStoreCacheHeaders(res);
      res.json(groups);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err ?? "Unknown error");
      console.error("[live-trades] GET /admin/grouped failed:", message);
      res.status(500).json({
        success: false,
        message: "Error fetching live trades",
        error: message,
      });
    }
  }

  /** All users subscribed to a strategy (admin subscribers table). */
  async function listStrategySubscribers(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const strategyId = String(req.params.id ?? "").trim();
      if (!strategyId) {
        res.status(400).json({ error: "strategy id is required" });
        return;
      }

      const strategy = await prisma.strategy.findUnique({
        where: { id: strategyId },
        select: { id: true, title: true },
      });
      if (!strategy) {
        res.status(404).json({ error: "Strategy not found" });
        return;
      }

      const rows = await prisma.userStrategySubscription.findMany({
        where: { strategyId },
        orderBy: { joinedDate: "desc" },
        select: {
          id: true,
          userId: true,
          multiplier: true,
          isActive: true,
          status: true,
          syncStatus: true,
          syncError: true,
          joinedDate: true,
          user: {
            select: {
              id: true,
              email: true,
              name: true,
              status: true,
              copyTradingPaused: true,
            },
          },
        },
      });

      res.json({
        strategyId: strategy.id,
        strategyTitle: strategy.title,
        subscribers: rows.map((row) => ({
          subscriptionId: row.id,
          userId: row.user.id,
          name: row.user.name,
          email: row.user.email,
          userStatus: row.user.status,
          copyTradingPaused: row.user.copyTradingPaused,
          multiplier: row.multiplier,
          isActive: row.isActive,
          status: row.status,
          syncStatus: row.syncStatus,
          syncError: row.syncError,
          joinedDate: row.joinedDate.toISOString(),
        })),
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * Manually align one follower's Delta positions to the master's open book
   * (scaled by multiplier). Resets syncStatus on success.
   */
  async function syncStrategyUser(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const strategyId = String(req.params.strategyId ?? "").trim();
      const userId = String(req.params.userId ?? "").trim();
      if (!strategyId || !userId) {
        res.status(400).json({ error: "strategyId and userId are required" });
        return;
      }

      const strategy = await prisma.strategy.findUnique({
        where: { id: strategyId },
        select: { id: true },
      });
      if (!strategy) {
        res.status(404).json({ error: "Strategy not found" });
        return;
      }

      const { syncFollowerUserToMasterPositions } = await import(
        "../services/tradeEngine.js"
      );
      const result = await syncFollowerUserToMasterPositions(
        prisma,
        strategyId,
        userId,
      );

      if (!result.ok) {
        res.status(422).json(result);
        return;
      }

      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes("not subscribed") ||
        msg.includes("inactive") ||
        msg.includes("no Delta API") ||
        msg.includes("must be set") ||
        msg.includes("Failed to fetch master")
      ) {
        res.status(400).json({ error: msg });
        return;
      }
      next(err);
    }
  }

  /**
   * Admin granular sync — exact lot counts per master leg (no multiplier).
   * Bypasses late-join guards via adminForceSync.
   */
  async function granularSyncLiveTrades(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const body = req.body as {
        userId?: unknown;
        strategyId?: unknown;
        legs?: unknown;
      };
      const userId = String(body.userId ?? "").trim();
      const strategyId = String(body.strategyId ?? "").trim();
      if (!userId || !strategyId) {
        res.status(400).json({ error: "userId and strategyId are required" });
        return;
      }
      if (!Array.isArray(body.legs)) {
        res.status(400).json({ error: "legs must be an array" });
        return;
      }

      const legs = body.legs
        .filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null)
        .map((row) => ({
          symbol: String(row.symbol ?? "").trim(),
          side: String(row.side ?? "").trim().toUpperCase(),
          addLots: Math.floor(Number(row.addLots)),
        }))
        .filter(
          (leg) =>
            leg.symbol.length > 0 &&
            (leg.side === "BUY" || leg.side === "SELL") &&
            leg.addLots > 0,
        );

      console.log(
        `[granular-sync] request user=${userId} strategy=${strategyId} legs=${JSON.stringify(legs)}`,
      );

      const { adminGranularSyncFollowerLegs } = await import(
        "../services/followerTradeExecution.js"
      );
      const result = await adminGranularSyncFollowerLegs(prisma, {
        userId,
        strategyId,
        legs,
      });

      if (!result.ok) {
        const status = result.legsAttempted === 0 ? 400 : 422;
        res.status(status).json(result);
        return;
      }

      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes("not subscribed") ||
        msg.includes("inactive") ||
        msg.includes("no Delta API") ||
        msg.includes("Strategy not found")
      ) {
        res.status(400).json({ error: msg });
        return;
      }
      next(err);
    }
  }

  /** Update per-user multiplier and/or copy-trading isActive for one strategy. */
  async function updateStrategySubscriber(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const strategyId = String(req.params.strategyId ?? "").trim();
      const userId = String(req.params.userId ?? "").trim();
      if (!strategyId || !userId) {
        res.status(400).json({ error: "strategyId and userId are required" });
        return;
      }

      const body = req.body as { multiplier?: unknown; isActive?: unknown };
      const data: { multiplier?: number; isActive?: boolean } = {};

      if (body.multiplier !== undefined) {
        const multiplier = parseSubscriptionMultiplier(body.multiplier);
        if (multiplier == null) {
          res.status(400).json({
            error: `multiplier must be between ${MIN_SUBSCRIPTION_MULTIPLIER} and ${MAX_SUBSCRIPTION_MULTIPLIER}`,
          });
          return;
        }
        data.multiplier = multiplier;
      }
      if (body.isActive !== undefined) {
        if (typeof body.isActive !== "boolean") {
          res.status(400).json({ error: "isActive must be a boolean" });
          return;
        }
        data.isActive = body.isActive;
      }
      if (Object.keys(data).length === 0) {
        res.status(400).json({ error: "multiplier and/or isActive is required" });
        return;
      }

      const existing = await prisma.userStrategySubscription.findUnique({
        where: { userId_strategyId: { userId, strategyId } },
        select: { id: true },
      });
      if (!existing) {
        res.status(404).json({ error: "Subscription not found for this user" });
        return;
      }

      const updated = await prisma.userStrategySubscription.update({
        where: { id: existing.id },
        data,
        select: {
          id: true,
          userId: true,
          strategyId: true,
          multiplier: true,
          isActive: true,
          status: true,
          joinedDate: true,
          user: { select: { id: true, email: true, name: true } },
        },
      });

      res.json({
        subscriptionId: updated.id,
        userId: updated.userId,
        strategyId: updated.strategyId,
        name: updated.user.name,
        email: updated.user.email,
        multiplier: updated.multiplier,
        isActive: updated.isActive,
        status: updated.status,
        joinedDate: updated.joinedDate.toISOString(),
      });
    } catch (err) {
      next(err);
    }
  }

  async function patchUserCryptoArbitrageAllocation(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = String(req.params.id ?? "").trim();
      const body = req.body as {
        percent?: unknown;
        cryptoCapitalPerTradePercent?: unknown;
      };
      const percent =
        typeof body.percent === "number"
          ? body.percent
          : typeof body.cryptoCapitalPerTradePercent === "number"
            ? body.cryptoCapitalPerTradePercent
            : undefined;
      if (percent === undefined || !Number.isFinite(percent) || percent <= 0 || percent > 100) {
        res.status(400).json({
          error: "percent must be a number greater than 0 and at most 100",
        });
        return;
      }
      const user = await prisma.user.update({
        where: { id: userId },
        data: { cryptoCapitalPerTradePercent: percent },
        select: cryptoArbitrageSelect,
      });
      res.json({
        userId: user.id,
        cryptoArbitrageEnabled: user.cryptoArbitrageEnabled,
        cryptoBalance: user.cryptoBalance,
        cryptoCapitalPerTradePercent: user.cryptoCapitalPerTradePercent,
      });
    } catch (err) {
      next(err);
    }
  }

  return {
    getRevenueAnalytics,
    getUserTradesBilling,
    listAllTrades,
    listUsersMinimal,
    listUsersForAdmin,
    searchUsers,
    updateUserProfile,
    patchStrategyAutoExit,
    closeManualTrade,
    flushUserTrades,
    flushArbitrageTrades,
    exportTrades,
    listDownloads,
    deleteDownload,
    sendResetPasswordLink,
    getDashboardStats,
    getUserBalance,
    listTransactions,
    listAllDeposits,
    updateDepositStatus,
    getUserCryptoArbitrage,
    patchUserCryptoArbitrageEnabled,
    patchUserCryptoArbitrageBalance,
    patchUserCryptoArbitrageAllocation,
    listUserArbitrageWithdrawals,
    createUserArbitrageWithdrawal,
    syncUserArbitrage,
    listStrategySubscribers,
    syncStrategyUser,
    granularSyncLiveTrades,
    updateStrategySubscriber,
    getGroupedLiveTrades,
  };
}

