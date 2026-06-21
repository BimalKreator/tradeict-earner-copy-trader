import type { NextFunction, Request, Response } from "express";
import type { PrismaClient } from "@prisma/client";
import {
  activeStrategiesForUser,
  checkDeltaApiConnected,
  computeUserBookedPnlAndRevenueDue,
  fetchUserCapitalBreakdown,
  pnlPercentOfCapital,
  realizedTradePnl,
  resolveStoredOrComputedTradeRevenueShare,
  resolveUserDeltaCreds,
  startOfUtcMonth,
  computeTodaysPnl,
} from "../services/dashboardMetricsService.js";
import {
  getUserArbitrageDashboardMetrics,
  getArbitrageBaseCapital,
  resolveArbitrageTradesUserId,
  sumArbitrageNetProfitAllTime,
} from "../services/arbitrageMetricsService.js";
import {
  buildTimestampTag,
  rowsToCsv,
} from "../utils/exportService.js";
import { applyNoStoreCacheHeaders } from "./adminController.js";
import { getUserLiveTradesByStrategy } from "../services/liveTradesService.js";
import {
  getPartnerMetrics,
  getPartnerNetworkDetails,
  listPartnerDirectUsers,
} from "../services/affiliatePartnerService.js";
import { requestPartnerPayout } from "../services/affiliatePayoutService.js";
import { setUserReferrerByCode } from "../services/affiliateMemberService.js";
import {
  createMemberUpgradeRequest,
  getPartnerNominationOptions,
} from "../services/affiliateUpgradeRequestService.js";
import { createReferralRequest, listReferralRequestsForSponsor } from "../services/referralRequestService.js";
import { getPartnerTierInfo } from "../services/affiliateUpgradeService.js";
import { normalizeAffiliateRoleEnum } from "../utils/roleNormalize.js";
import { NominatedSalesRole } from "@prisma/client";
import {
  fetchUserProfileRecord,
  formatProfileResponse,
  parseProfileUpdateBody,
  updateUserProfileRecord,
} from "../services/userProfileService.js";

const DEFAULT_TRADE_LIMIT = 100;
const MAX_TRADE_LIMIT = 500;

export function createUserController(prisma: PrismaClient) {
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

  async function getLiveTradesByStrategy(
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
      const groups = await getUserLiveTradesByStrategy(prisma, userId);
      applyNoStoreCacheHeaders(res);
      res.json(groups);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err ?? "Unknown error");
      console.error("[live-trades] GET /me failed:", message);
      res.status(500).json({
        success: false,
        message: "Error fetching live trades",
        error: message,
      });
    }
  }

  async function createDeposit(
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
      const amount = Number((req.body as { amount?: unknown }).amount);
      const transactionId = String(
        (req.body as { transactionId?: unknown }).transactionId ?? "",
      ).trim();
      if (!Number.isFinite(amount) || amount <= 0) {
        res.status(400).json({ error: "Amount must be a positive number." });
        return;
      }
      if (!transactionId) {
        res.status(400).json({ error: "transactionId is required." });
        return;
      }

      const screenshotUrl = req.file ? `/uploads/${req.file.filename}` : null;
      const row = await prisma.depositRequest.create({
        data: {
          userId,
          amount,
          transactionId,
          screenshotUrl,
        },
      });
      await prisma.notification.create({
        data: {
          userId: null,
          title: "New Deposit Request",
          message: `A new deposit request was submitted. User: ${userId}, Amount: ${amount.toFixed(
            2,
          )}, Transaction ID: ${transactionId}.`,
        },
      });
      res.status(201).json({ deposit: row });
    } catch (err) {
      next(err);
    }
  }

  async function listDeposits(
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
      const rows = await prisma.depositRequest.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
      });
      res.json({ deposits: rows });
    } catch (err) {
      next(err);
    }
  }

  async function getMe(
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

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          name: true,
          mobile: true,
          address: true,
          panNumber: true,
          aadharNumber: true,
          role: true,
          status: true,
          acquiredById: true,
          acquiredBy: {
            select: {
              name: true,
              affiliateProfile: { select: { referralCode: true } },
            },
          },
        },
      });

      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      const pending = await prisma.profileUpdateRequest.findFirst({
        where: { userId, status: "PENDING" },
        orderBy: { createdAt: "desc" },
        select: { address: true, panNumber: true, aadharNumber: true },
      });
      const pendingFields: string[] = [];
      if (pending?.address != null) pendingFields.push("address");
      if (pending?.panNumber != null) pendingFields.push("panNumber");
      if (pending?.aadharNumber != null) pendingFields.push("aadharNumber");

      const referrer =
        user.acquiredById && user.acquiredBy?.affiliateProfile
          ? {
              name: user.acquiredBy.name,
              referralCode: user.acquiredBy.affiliateProfile.referralCode,
            }
          : null;

      const { acquiredBy: _acquiredBy, ...rest } = user;
      const role = normalizeAffiliateRoleEnum(user.role) ?? user.role;
      res.json({ ...rest, role, referrer, pendingApprovalFields: pendingFields });
    } catch (err) {
      next(err);
    }
  }

  async function getDashboardOverview(
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

      const monthStart = startOfUtcMonth();

      const [
        userRow,
        todayPnl,
        capital,
        activeStrategies,
        arbitrage,
        allTimeBooked,
        monthBooked,
      ] = await Promise.all([
        prisma.user.findUnique({
          where: { id: userId },
          select: { copyTradingPaused: true },
        }),
        computeTodaysPnl(prisma, userId),
        fetchUserCapitalBreakdown(prisma, userId),
        activeStrategiesForUser(prisma, userId),
        getUserArbitrageDashboardMetrics(prisma, userId),
        computeUserBookedPnlAndRevenueDue(prisma, userId, null),
        computeUserBookedPnlAndRevenueDue(prisma, userId, monthStart),
      ]);

      const creds = await resolveUserDeltaCreds(prisma, userId);
      const apiStatus = creds
        ? (await checkDeltaApiConnected(creds)) ? "connected" : "disconnected"
        : "disconnected";

      const copyTradingActive =
        !userRow?.copyTradingPaused && apiStatus === "connected";

      const capitalBase =
        capital.totalBalance > 0
          ? capital.totalBalance
          : capital.availableBalance + capital.usedBalance;

      const earnedPnl = allTimeBooked.netEarnedPnl;
      const monthlyPnl = monthBooked.netEarnedPnl;
      const revenueSharingDue = monthBooked.appRevenue;

      res.json({
        earnedPnl,
        earnedPnlPercent: pnlPercentOfCapital(earnedPnl, capitalBase),
        todayPnl,
        todayPnlPercent: pnlPercentOfCapital(todayPnl, capitalBase),
        monthlyPnl,
        monthlyPnlPercent: pnlPercentOfCapital(monthlyPnl, capitalBase),
        grossPnlAllTime: allTimeBooked.grossPnl,
        grossPnlMonth: monthBooked.grossPnl,
        appRevenueAllTime: allTimeBooked.appRevenue,
        appRevenueMonth: monthBooked.appRevenue,
        grossBookedPnlAllTime: allTimeBooked.grossPnl,
        grossBookedPnlMonth: monthBooked.grossPnl,
        revenueSharingDue,
        availableCapital: capital.availableBalance,
        totalBalance: capital.totalBalance,
        availableBalance: capital.availableBalance,
        usedBalance: capital.usedBalance,
        activeStrategies,
        apiStatus,
        copyTradingActive,
        copyTradingPaused: userRow?.copyTradingPaused ?? false,
        cryptoBalance: arbitrage.cryptoBalance,
        arbitrageTodayPnl: arbitrage.todayPnl,
        arbitrageMonthlyPnl: arbitrage.monthlyPnl,
        arbitrageTodayPnlPercent: pnlPercentOfCapital(
          arbitrage.todayPnl,
          arbitrage.cryptoBalance,
        ),
        arbitrageMonthlyPnlPercent: pnlPercentOfCapital(
          arbitrage.monthlyPnl,
          arbitrage.cryptoBalance,
        ),
        cryptoArbitrageEnabled: arbitrage.cryptoArbitrageEnabled,
      });
    } catch (err) {
      next(err);
    }
  }

  async function listArbitrageTrades(
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

      const limitRaw = Number(req.query.limit ?? DEFAULT_TRADE_LIMIT);
      const limit = Number.isFinite(limitRaw)
        ? Math.min(Math.max(1, Math.floor(limitRaw)), MAX_TRADE_LIMIT)
        : DEFAULT_TRADE_LIMIT;

      const tradesUserId = await resolveArbitrageTradesUserId(prisma, userId);

      const [totalEarnings, baseCapital, trades] = await Promise.all([
        sumArbitrageNetProfitAllTime(prisma, tradesUserId),
        getArbitrageBaseCapital(prisma, userId),
        prisma.arbitrageTrade.findMany({
          where: { userId: tradesUserId },
          orderBy: { createdAt: "desc" },
          take: limit,
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
        }),
      ]);

      res.json({
        totalEarnings,
        baseCapital,
        trades: trades.map((t) => ({
          ...t,
          createdAt: t.createdAt.toISOString(),
        })),
      });
    } catch (err) {
      next(err);
    }
  }

  async function listArbitrageWithdrawals(
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

      const [rows, baseCapital] = await Promise.all([
        prisma.arbitrageWithdrawal.findMany({
          where: { userId },
          orderBy: { date: "desc" },
          select: {
            id: true,
            amount: true,
            date: true,
            createdAt: true,
          },
        }),
        getArbitrageBaseCapital(prisma, userId),
      ]);

      res.json({
        baseCapital,
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

  async function patchCopyTrading(
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

      const body = req.body as { paused?: unknown; active?: unknown };
      let paused: boolean | undefined;
      if (typeof body.paused === "boolean") {
        paused = body.paused;
      } else if (typeof body.active === "boolean") {
        paused = !body.active;
      }

      if (paused === undefined) {
        res.status(400).json({ error: "Provide paused (boolean) or active (boolean)" });
        return;
      }

      const user = await prisma.user.update({
        where: { id: userId },
        data: { copyTradingPaused: paused },
        select: { copyTradingPaused: true },
      });

      const creds = await resolveUserDeltaCreds(prisma, userId);
      const apiStatus = creds
        ? (await checkDeltaApiConnected(creds)) ? "connected" : "disconnected"
        : "disconnected";

      res.json({
        copyTradingPaused: user.copyTradingPaused,
        copyTradingActive: !user.copyTradingPaused && apiStatus === "connected",
        apiStatus,
      });
    } catch (err) {
      next(err);
    }
  }

  async function patchMe(
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
        name?: unknown;
        mobile?: unknown;
        address?: unknown;
        panNumber?: unknown;
        aadharNumber?: unknown;
      };
      const data: { name?: string | null; mobile?: string | null } = {};
      const profileReq: {
        address?: string | null;
        panNumber?: string | null;
        aadharNumber?: string | null;
      } = {};

      if ("name" in body) {
        if (body.name === null || body.name === undefined) {
          data.name = null;
        } else if (typeof body.name === "string") {
          const n = body.name.trim();
          data.name = n.length ? n : null;
        } else {
          res.status(400).json({ error: "name must be a string or null" });
          return;
        }
      }

      if ("mobile" in body) {
        if (body.mobile === null || body.mobile === undefined) {
          data.mobile = null;
        } else if (typeof body.mobile === "string") {
          const m = body.mobile.trim();
          data.mobile = m.length ? m : null;
        } else {
          res.status(400).json({ error: "mobile must be a string or null" });
          return;
        }
      }

      if ("address" in body) {
        if (body.address === null || body.address === undefined) {
          profileReq.address = null;
        } else if (typeof body.address === "string") {
          const s = body.address.trim();
          profileReq.address = s.length ? s : null;
        } else {
          res.status(400).json({ error: "address must be a string or null" });
          return;
        }
      }
      if ("panNumber" in body) {
        if (body.panNumber === null || body.panNumber === undefined) {
          profileReq.panNumber = null;
        } else if (typeof body.panNumber === "string") {
          const s = body.panNumber.trim();
          profileReq.panNumber = s.length ? s : null;
        } else {
          res.status(400).json({ error: "panNumber must be a string or null" });
          return;
        }
      }
      if ("aadharNumber" in body) {
        if (body.aadharNumber === null || body.aadharNumber === undefined) {
          profileReq.aadharNumber = null;
        } else if (typeof body.aadharNumber === "string") {
          const s = body.aadharNumber.trim();
          profileReq.aadharNumber = s.length ? s : null;
        } else {
          res.status(400).json({ error: "aadharNumber must be a string or null" });
          return;
        }
      }

      const hasDirect = Object.keys(data).length > 0;
      const hasProfileRequest = Object.keys(profileReq).length > 0;
      if (!hasDirect && !hasProfileRequest) {
        res.status(400).json({
          error:
            "Provide at least one field to update: name, mobile, address, panNumber, or aadharNumber",
        });
        return;
      }

      let user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, name: true, mobile: true },
      });
      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }
      if (hasDirect) {
        user = await prisma.user.update({
          where: { id: userId },
          data,
          select: {
            id: true,
            email: true,
            name: true,
            mobile: true,
          },
        });
      }
      if (hasProfileRequest) {
        await prisma.profileUpdateRequest.create({
          data: {
            userId,
            ...(profileReq.address !== undefined ? { address: profileReq.address } : {}),
            ...(profileReq.panNumber !== undefined
              ? { panNumber: profileReq.panNumber }
              : {}),
            ...(profileReq.aadharNumber !== undefined
              ? { aadharNumber: profileReq.aadharNumber }
              : {}),
          },
        });
      }

      if (hasProfileRequest) {
        res.json({
          user,
          message:
            "Profile update request submitted. Changes will reflect after admin approval.",
        });
        return;
      }
      res.json(user);
    } catch (err) {
      next(err);
    }
  }

  /**
   * Personal trade history for the calling user.
   *
   * Optional query params:
   *   limit  — clamp 1..500 (default 100)
   *   status — `OPEN | CLOSED | FAILED` (omit for all)
   *
   * Returns a flat `{ trades: [...] }` shape so the frontend can render a
 * data table directly. Includes `tradePnl`, `tradingFee`, and `revenueShareAmt`
 * so the client can show net realized PnL + fee breakdown.
   */
  async function listTrades(
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

      const limitRaw = req.query.limit;
      let limit = DEFAULT_TRADE_LIMIT;
      if (typeof limitRaw === "string") {
        const parsed = Number(limitRaw);
        if (Number.isFinite(parsed)) {
          limit = Math.min(MAX_TRADE_LIMIT, Math.max(1, Math.floor(parsed)));
        }
      }

      const statusRaw = req.query.status;
      const allowedStatuses = new Set(["OPEN", "CLOSED", "FAILED"]);
      const where: {
        userId: string;
        status?: "OPEN" | "CLOSED" | "FAILED";
      } = { userId };
      if (typeof statusRaw === "string") {
        const upper = statusRaw.trim().toUpperCase();
        if (allowedStatuses.has(upper)) {
          where.status = upper as "OPEN" | "CLOSED" | "FAILED";
        }
      }

      const rows = await prisma.trade.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        select: {
          id: true,
          createdAt: true,
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
          strategy: { select: { title: true, profitShare: true } },
        },
      });

      const trades = rows.map((r) => {
        const netPnl = realizedTradePnl(r);
        return {
        id: r.id,
        createdAt: r.createdAt.toISOString(),
        strategyId: r.strategyId,
        strategyTitle: r.strategy.title,
        symbol: r.symbol,
        side: r.side,
        size: r.size,
        entryPrice: r.entryPrice,
        exitPrice: r.exitPrice,
        pnl: r.pnl,
        tradePnl: netPnl,
        tradingFee: r.tradingFee,
        revenueShareAmt: resolveStoredOrComputedTradeRevenueShare({
          realizedPnl: netPnl,
          profitSharePct: r.strategy.profitShare,
          revenueShareAmt: r.revenueShareAmt,
        }),
        status: r.status,
        exitReason: r.exitReason,
      };
      });

      const booked = await computeUserBookedPnlAndRevenueDue(prisma, userId, null);

      res.json({
        trades,
        summary: {
          grossPnl: booked.grossPnl,
          appRevenue: booked.appRevenue,
          netEarnedPnl: booked.netEarnedPnl,
          /** @deprecated use netEarnedPnl */
          netPnl: booked.netEarnedPnl,
        },
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * Personal invoice history for the calling user, newest period first.
   *
   * Each row includes the joined `strategyTitle` so the frontend billing
   * dashboard can render a self-contained table without a second lookup.
   */
  async function listInvoices(
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

      const rows = await prisma.invoice.findMany({
        where: { userId },
        orderBy: [
          { year: "desc" },
          { month: "desc" },
          { createdAt: "desc" },
        ],
        select: {
          id: true,
          strategyId: true,
          month: true,
          year: true,
          totalPnl: true,
          amountDue: true,
          dueDate: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          strategy: { select: { title: true } },
        },
      });

      const invoices = rows.map((r) => ({
        id: r.id,
        strategyId: r.strategyId,
        strategyTitle: r.strategy.title,
        month: r.month,
        year: r.year,
        totalPnl: r.totalPnl,
        amountDue: r.amountDue,
        dueDate: r.dueDate.toISOString(),
        status: r.status,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      }));

      res.json({ invoices });
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
      const userId = req.userId;
      if (!userId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      const { startDate, endDate } = parseDateRange(req);
      const rows = await prisma.trade.findMany({
        where: {
          userId,
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
      const fileName = `Trades_${userId}_${buildTimestampTag()}.csv`;
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
      res.status(200).send(`\uFEFF${csv}`);
    } catch (err) {
      next(err);
    }
  }

  async function exportTransactions(
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
      const { startDate, endDate } = parseDateRange(req);
      const rows = await prisma.transaction.findMany({
        where: {
          userId,
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
          amount: true,
          type: true,
          status: true,
          utrNumber: true,
        },
      });
      const csv = rowsToCsv(
        rows.map((r) => ({
          id: r.id,
          createdAt: r.createdAt.toISOString(),
          amount: r.amount,
          type: r.type,
          status: r.status,
          utrNumber: r.utrNumber ?? "",
        })),
        [
          { key: "id", label: "Transaction ID" },
          { key: "createdAt", label: "Created At" },
          { key: "amount", label: "Amount" },
          { key: "type", label: "Type" },
          { key: "status", label: "Status" },
          { key: "utrNumber", label: "UTR Number" },
        ],
      );
      const fileName = `Transactions_${userId}_${buildTimestampTag()}.csv`;
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
      res.status(200).send(`\uFEFF${csv}`);
    } catch (err) {
      next(err);
    }
  }

  async function getPartnerMetricsHandler(
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

      const metrics = await getPartnerMetrics(prisma, userId);
      if (!metrics) {
        res.status(403).json({ error: "Partner access required" });
        return;
      }

      applyNoStoreCacheHeaders(res);
      res.json(metrics);
    } catch (err) {
      next(err);
    }
  }

  async function requestPartnerPayoutHandler(
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

      const outcome = await requestPartnerPayout(prisma, userId);
      if (!outcome.ok) {
        res.status(outcome.status).json({ error: outcome.message });
        return;
      }

      res.status(200).json({
        ok: true,
        payoutRequestId: outcome.payoutRequestId,
        amount: outcome.amount,
      });
    } catch (err) {
      next(err);
    }
  }

  async function setProfileReferrer(
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

      const body = req.body as { referralCode?: unknown };
      const referralCode =
        typeof body.referralCode === "string" ? body.referralCode : "";
      const outcome = await setUserReferrerByCode(prisma, userId, referralCode);
      if (!outcome.ok) {
        res.status(outcome.status).json({ error: outcome.error });
        return;
      }

      res.json({ ok: true, referrer: outcome.referrer });
    } catch (err) {
      next(err);
    }
  }

  async function listPartnerDirectUsersHandler(
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

      const users = await listPartnerDirectUsers(prisma, userId);
      if (!users) {
        res.status(403).json({ error: "Partner access required" });
        return;
      }

      applyNoStoreCacheHeaders(res);
      res.json({ users });
    } catch (err) {
      next(err);
    }
  }

  async function getPartnerNetworkDetailsHandler(
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

      const payload = await getPartnerNetworkDetails(prisma, userId);
      if (!payload) {
        res.status(403).json({ error: "Partner access required" });
        return;
      }

      applyNoStoreCacheHeaders(res);
      res.json(payload);
    } catch (err) {
      next(err);
    }
  }

  async function getPartnerNominationOptionsHandler(
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

      const options = await getPartnerNominationOptions(prisma, userId);
      if (!options) {
        res.status(403).json({ error: "Nomination is available to Senior Managers and Managers only" });
        return;
      }

      applyNoStoreCacheHeaders(res);
      res.json(options);
    } catch (err) {
      next(err);
    }
  }

  async function nominatePartnerMemberHandler(
    req: Request,
    res: Response,
    _next: NextFunction,
  ): Promise<void> {
    try {
      const userId = req.userId;
      if (!userId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const body = req.body as {
        targetUserEmail?: unknown;
        requestedRole?: unknown;
        assignedParentId?: unknown;
      };

      const targetUserEmail =
        typeof body.targetUserEmail === "string" ? body.targetUserEmail : "";
      const assignedParentId =
        typeof body.assignedParentId === "string" ? body.assignedParentId : "";
      const roleRaw =
        typeof body.requestedRole === "string"
          ? body.requestedRole.trim().toUpperCase()
          : "";

      if (!targetUserEmail.trim() || !assignedParentId.trim()) {
        res.status(400).json({
          error: "targetUserEmail and assignedParentId are required",
        });
        return;
      }

      if (
        roleRaw !== NominatedSalesRole.EXECUTIVE &&
        roleRaw !== NominatedSalesRole.MANAGER
      ) {
        res.status(400).json({ error: "requestedRole must be MANAGER or EXECUTIVE" });
        return;
      }

      const outcome = await createMemberUpgradeRequest(prisma, userId, {
        targetUserEmail,
        requestedRole: roleRaw as NominatedSalesRole,
        assignedParentId,
      });

      if (!outcome.ok) {
        res.status(outcome.status).json({ error: outcome.error });
        return;
      }

      res.status(201).json({ ok: true, requestId: outcome.data.id });
    } catch (err) {
      console.error("[POST /api/user/partner/nominate-member] unhandled error:", err);
      const message =
        err instanceof Error
          ? err.message
          : typeof err === "string"
            ? err
            : "Nomination failed";
      res.status(500).json({ error: message });
    }
  }

  async function createPartnerReferralRequestHandler(
    req: Request,
    res: Response,
    _next: NextFunction,
  ): Promise<void> {
    try {
      const userId = req.userId;
      if (!userId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const body = req.body as { referredEmail?: unknown };
      const referredEmail =
        typeof body.referredEmail === "string" ? body.referredEmail : "";

      if (!referredEmail.trim()) {
        res.status(400).json({ error: "referredEmail is required" });
        return;
      }

      const outcome = await createReferralRequest(
        prisma,
        userId,
        referredEmail,
      );

      if (!outcome.ok) {
        res.status(outcome.status).json({ error: outcome.error });
        return;
      }

      res.status(201).json({ ok: true, requestId: outcome.data.id });
    } catch (err) {
      console.error("[POST /api/user/partner/referral-request] unhandled error:", err);
      const message =
        err instanceof Error
          ? err.message
          : typeof err === "string"
            ? err
            : "Referral request failed";
      res.status(500).json({ error: message });
    }
  }

  async function getPartnerTierInfoHandler(
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

      const info = await getPartnerTierInfo(prisma, userId);
      if (!info) {
        res.status(403).json({ error: "Partner access required" });
        return;
      }

      applyNoStoreCacheHeaders(res);
      res.json(info);
    } catch (err) {
      next(err);
    }
  }

  async function listPartnerReferralRequestsHandler(
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

      const metrics = await getPartnerMetrics(prisma, userId);
      if (!metrics) {
        res.status(403).json({ error: "Partner access required" });
        return;
      }

      const requests = await listReferralRequestsForSponsor(prisma, userId);
      applyNoStoreCacheHeaders(res);
      res.json({ requests });
    } catch (err) {
      next(err);
    }
  }

  async function getProfile(
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
      const user = await fetchUserProfileRecord(prisma, userId);
      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }
      res.json({ profile: formatProfileResponse(user) });
    } catch (err) {
      next(err);
    }
  }

  async function updateProfile(
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
      const body =
        typeof req.body === "object" && req.body !== null
          ? (req.body as Record<string, unknown>)
          : {};
      const parsed = parseProfileUpdateBody(body);
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error });
        return;
      }
      const result = await updateUserProfileRecord(prisma, userId, parsed.data);
      if (!result.ok) {
        res.status(409).json({ error: result.error });
        return;
      }
      res.json({
        profile: formatProfileResponse(result.user),
        message: "Profile updated successfully.",
      });
    } catch (err) {
      next(err);
    }
  }

  return {
    getMe,
    getProfile,
    updateProfile,
    patchMe,
    listTrades,
    listInvoices,
    getDashboardOverview,
    listArbitrageTrades,
    listArbitrageWithdrawals,
    patchCopyTrading,
    createDeposit,
    listDeposits,
    exportTrades,
    exportTransactions,
    getLiveTradesByStrategy,
    getPartnerMetrics: getPartnerMetricsHandler,
    listPartnerDirectUsers: listPartnerDirectUsersHandler,
    getPartnerNetworkDetails: getPartnerNetworkDetailsHandler,
    getPartnerNominationOptions: getPartnerNominationOptionsHandler,
    nominatePartnerMember: nominatePartnerMemberHandler,
    createPartnerReferralRequest: createPartnerReferralRequestHandler,
    getPartnerTierInfo: getPartnerTierInfoHandler,
    listPartnerReferralRequests: listPartnerReferralRequestsHandler,
    requestPartnerPayout: requestPartnerPayoutHandler,
    setProfileReferrer,
  };
}
