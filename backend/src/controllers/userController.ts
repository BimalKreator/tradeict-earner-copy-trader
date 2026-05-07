import type { NextFunction, Request, Response } from "express";
import type { PrismaClient } from "@prisma/client";

const DEFAULT_TRADE_LIMIT = 100;
const MAX_TRADE_LIMIT = 500;

export function createUserController(prisma: PrismaClient) {
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
          role: true,
          status: true,
        },
      });

      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      res.json(user);
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

      const body = req.body as { name?: unknown; mobile?: unknown };
      const data: { name?: string | null; mobile?: string | null } = {};

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

      if (Object.keys(data).length === 0) {
        res.status(400).json({ error: "Provide name and/or mobile to update" });
        return;
      }

      const user = await prisma.user.update({
        where: { id: userId },
        data,
        select: {
          id: true,
          email: true,
          name: true,
          mobile: true,
        },
      });

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

  return { getMe, patchMe, listTrades, listInvoices };
}
