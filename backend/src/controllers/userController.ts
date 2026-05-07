import type { NextFunction, Request, Response } from "express";
import type { PrismaClient } from "@prisma/client";
import { fetchDeltaTotalBalanceUsd } from "../services/exchangeService.js";

const DEFAULT_TRADE_LIMIT = 100;
const MAX_TRADE_LIMIT = 500;

export function createUserController(prisma: PrismaClient) {
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
          aadhaarNumber: true,
          role: true,
          status: true,
        },
      });

      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      const pending = await prisma.profileUpdateRequest.findFirst({
        where: { userId, status: "PENDING" },
        orderBy: { createdAt: "desc" },
        select: { address: true, panNumber: true, aadhaarNumber: true },
      });
      const pendingFields: string[] = [];
      if (pending?.address != null) pendingFields.push("address");
      if (pending?.panNumber != null) pendingFields.push("panNumber");
      if (pending?.aadhaarNumber != null) pendingFields.push("aadhaarNumber");
      res.json({ ...user, pendingApprovalFields: pendingFields });
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

      const [activeSubs, allClosedTrades, todayTrades, userWithCreds, strategyPnl] =
        await Promise.all([
          prisma.userSubscription.count({
            where: { userId, status: "ACTIVE" },
          }),
          prisma.trade.findMany({
            where: { userId, status: "CLOSED" },
            select: { tradePnl: true },
          }),
          prisma.trade.findMany({
            where: { userId, status: "CLOSED", createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
            select: { tradePnl: true },
          }),
          prisma.user.findUnique({
            where: { id: userId },
            select: {
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
          }),
          prisma.pnLRecord.groupBy({
            by: ["strategyId"],
            where: { userId },
            _sum: { profitAmount: true },
            orderBy: { _sum: { profitAmount: "desc" } },
            take: 6,
          }),
        ]);

      const wins = allClosedTrades.filter((t) => t.tradePnl > 0).length;
      const totalClosed = allClosedTrades.length;
      const totalWinRate = totalClosed > 0 ? (wins / totalClosed) * 100 : 0;
      const todaysPnl = todayTrades.reduce((s, t) => s + t.tradePnl, 0);

      const strategyIds = strategyPnl.map((s) => s.strategyId);
      const strategies = await prisma.strategy.findMany({
        where: { id: { in: strategyIds } },
        select: { id: true, title: true },
      });
      const titleMap = new Map(strategies.map((s) => [s.id, s.title]));

      let totalPortfolioValueUsd = 0;
      const creds =
        userWithCreds?.exchangeAccounts[0] ?? userWithCreds?.deltaApiKeys[0] ?? null;
      if (creds) {
        try {
          totalPortfolioValueUsd = await fetchDeltaTotalBalanceUsd(
            creds.apiKey,
            creds.apiSecret,
          );
        } catch {
          totalPortfolioValueUsd = 0;
        }
      }

      res.json({
        totalPortfolioValueUsd,
        activeSubscriptions: activeSubs,
        quickStats: {
          todaysPnl,
          totalWinRate,
        },
        activeStrategyPerformance: strategyPnl.map((s) => ({
          strategyId: s.strategyId,
          strategyTitle: titleMap.get(s.strategyId) ?? "Unknown Strategy",
          pnl: s._sum.profitAmount ?? 0,
        })),
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
        aadhaarNumber?: unknown;
      };
      const data: { name?: string | null; mobile?: string | null } = {};
      const profileReq: {
        address?: string | null;
        panNumber?: string | null;
        aadhaarNumber?: string | null;
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
      if ("aadhaarNumber" in body) {
        if (body.aadhaarNumber === null || body.aadhaarNumber === undefined) {
          profileReq.aadhaarNumber = null;
        } else if (typeof body.aadhaarNumber === "string") {
          const s = body.aadhaarNumber.trim();
          profileReq.aadhaarNumber = s.length ? s : null;
        } else {
          res.status(400).json({ error: "aadhaarNumber must be a string or null" });
          return;
        }
      }

      const hasDirect = Object.keys(data).length > 0;
      const hasProfileRequest = Object.keys(profileReq).length > 0;
      if (!hasDirect && !hasProfileRequest) {
        res.status(400).json({
          error:
            "Provide at least one field to update: name, mobile, address, panNumber, or aadhaarNumber",
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
            ...(profileReq.aadhaarNumber !== undefined
              ? { aadhaarNumber: profileReq.aadhaarNumber }
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
          strategy: { select: { title: true } },
        },
      });

      const trades = rows.map((r) => ({
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
        tradePnl: r.tradePnl,
        tradingFee: r.tradingFee,
        revenueShareAmt: r.revenueShareAmt,
        status: r.status,
      }));

      res.json({ trades });
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

  return {
    getMe,
    patchMe,
    listTrades,
    listInvoices,
    getDashboardOverview,
    createDeposit,
    listDeposits,
  };
}
