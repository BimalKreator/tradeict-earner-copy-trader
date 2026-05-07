import { Router } from "express";
import {
  Prisma,
  type PrismaClient,
  InvoiceStatus,
  Role,
  TradeStatus,
  UserStatus,
} from "@prisma/client";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/client";
import { authenticateToken, isAdmin } from "../middleware/authMiddleware.js";
import {
  getAdminGroupedLiveTrades,
  getAdminMasterPositionSnapshots,
} from "../services/liveTradesService.js";
import {
  generateMonthlyInvoices,
  getPlatformRevenueStats,
  runOverdueCheck,
} from "../services/billingService.js";
import {
  STRATEGY_SELECT_ADMIN_LIST,
  STRATEGY_SELECT_ADMIN_SAFE,
} from "../prisma/strategySelect.js";
import { createAdminController } from "../controllers/adminController.js";

/** Strategy CRUD uses `masterApiKey` / `masterApiSecret` only (leader Delta India CCXT credentials). */
const roleValues = new Set<string>(Object.values(Role));
const statusValues = new Set<string>(Object.values(UserStatus));

function parsePerformanceMetrics(
  v: unknown,
): Prisma.InputJsonValue | undefined {
  if (v === undefined) return undefined;
  if (v === null) return undefined;
  if (typeof v === "object") return v as Prisma.InputJsonValue;
  return undefined;
}

function realizedTradePnl(trade: { tradePnl: number; pnl: number | null }): number {
  if (Number.isFinite(trade.tradePnl) && trade.tradePnl !== 0) return trade.tradePnl;
  return Number.isFinite(trade.pnl ?? NaN) ? (trade.pnl as number) : 0;
}

export function createAdminRoutes(prisma: PrismaClient): Router {
  const router = Router();
  const adminController = createAdminController(prisma);

  router.use(authenticateToken(), isAdmin(prisma));

  router.get("/engine-status", (_req, res) => {
    res.json({ status: "running" });
  });
  router.get("/dashboard-stats", adminController.getDashboardStats);
  router.get("/transactions", adminController.listTransactions);

  router.get("/users", async (_req, res, next) => {
    try {
      const users = await prisma.user.findMany({
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          status: true,
          createdAt: true,
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
      res.json(
        users.map((u) => ({
          ...u,
          totalPnlToDate: pnlByUser.get(u.id) ?? 0,
        })),
      );
    } catch (err) {
      next(err);
    }
  });

  router.get("/users/:id/management", async (req, res, next) => {
    try {
      const { id } = req.params;
      const user = await prisma.user.findUnique({
        where: { id },
        select: {
          id: true,
          name: true,
          email: true,
          mobile: true,
          address: true,
          panNumber: true,
          aadhaarNumber: true,
          status: true,
          deltaApiKeys: {
            orderBy: { id: "desc" },
            take: 1,
            select: { id: true, nickname: true, apiKey: true, apiSecret: true },
          },
          exchangeAccounts: {
            orderBy: { createdAt: "desc" },
            take: 1,
            select: {
              id: true,
              nickname: true,
              exchange: true,
              apiKey: true,
              apiSecret: true,
            },
          },
        },
      });
      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }
      res.json({
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          mobile: user.mobile,
          address: user.address,
          panNumber: user.panNumber,
          aadhaarNumber: user.aadhaarNumber,
          status: user.status,
        },
        deltaApiKey: user.deltaApiKeys[0] ?? null,
        exchangeAccount: user.exchangeAccounts[0] ?? null,
      });
    } catch (err) {
      next(err);
    }
  });

  router.patch("/users/:id/status", async (req, res, next) => {
    try {
      const { id } = req.params;
      const status = String((req.body as { status?: unknown }).status ?? "").toUpperCase();
      if (!statusValues.has(status)) {
        res.status(400).json({ error: "status must be ACTIVE or SUSPENDED" });
        return;
      }
      const user = await prisma.user.update({
        where: { id },
        data: { status: status as UserStatus },
        select: { id: true, status: true, email: true, name: true },
      });
      res.json(user);
    } catch (err) {
      next(err);
    }
  });

  router.put("/users/:id/api-keys", async (req, res, next) => {
    try {
      const { id } = req.params;
      const body = req.body as {
        apiKey?: unknown;
        apiSecret?: unknown;
        nickname?: unknown;
      };
      if (
        typeof body.apiKey !== "string" ||
        typeof body.apiSecret !== "string" ||
        body.apiKey.trim() === "" ||
        body.apiSecret.trim() === ""
      ) {
        res.status(400).json({ error: "apiKey and apiSecret are required" });
        return;
      }
      const nickname =
        typeof body.nickname === "string" && body.nickname.trim()
          ? body.nickname.trim()
          : "Primary";

      const existing = await prisma.deltaApiKey.findFirst({
        where: { userId: id },
        orderBy: { id: "desc" },
        select: { id: true },
      });
      const deltaApiKey = existing
        ? await prisma.deltaApiKey.update({
            where: { id: existing.id },
            data: {
              nickname,
              apiKey: body.apiKey.trim(),
              apiSecret: body.apiSecret.trim(),
            },
            select: { id: true, nickname: true, apiKey: true, apiSecret: true },
          })
        : await prisma.deltaApiKey.create({
            data: {
              userId: id,
              nickname,
              apiKey: body.apiKey.trim(),
              apiSecret: body.apiSecret.trim(),
            },
            select: { id: true, nickname: true, apiKey: true, apiSecret: true },
          });

      res.json({ deltaApiKey });
    } catch (err) {
      next(err);
    }
  });

  router.get("/users/:id/strategies", async (req, res, next) => {
    try {
      const { id } = req.params;
      const user = await prisma.user.findUnique({
        where: { id },
        select: { id: true, email: true },
      });
      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      const subscriptions = await prisma.userSubscription.findMany({
        where: { userId: id },
        orderBy: { joinedDate: "desc" },
        select: {
          id: true,
          status: true,
          multiplier: true,
          joinedDate: true,
          strategyId: true,
          strategy: { select: { title: true } },
          exchangeAccount: { select: { id: true, nickname: true, exchange: true } },
        },
      });

      res.json({
        user,
        strategies: subscriptions.map((s) => ({
          id: s.id,
          strategyId: s.strategyId,
          strategyTitle: s.strategy.title,
          status: s.status,
          multiplier: s.multiplier,
          joinedDate: s.joinedDate,
          exchangeAccount: s.exchangeAccount,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/users/:id/trades", adminController.getUserTradesBilling);
  router.get("/users/:id/transactions", async (req, res, next) => {
    try {
      const { id } = req.params;
      const rows = await prisma.transaction.findMany({
        where: { userId: id },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          amount: true,
          type: true,
          status: true,
          createdAt: true,
        },
      });
      res.json({ transactions: rows });
    } catch (err) {
      next(err);
    }
  });
  router.get("/users/:id/change-requests", async (req, res, next) => {
    try {
      const { id } = req.params;
      const rows = await prisma.profileUpdateRequest.findMany({
        where: { userId: id, status: "PENDING" },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          address: true,
          panNumber: true,
          aadhaarNumber: true,
          status: true,
          createdAt: true,
        },
      });
      const current = await prisma.user.findUnique({
        where: { id },
        select: { address: true, panNumber: true, aadhaarNumber: true },
      });
      res.json({ current, requests: rows });
    } catch (err) {
      next(err);
    }
  });
  router.post("/users/:id/change-requests/:requestId/approve", async (req, res, next) => {
    try {
      const { id, requestId } = req.params;
      const reqRow = await prisma.profileUpdateRequest.findFirst({
        where: { id: requestId, userId: id, status: "PENDING" },
      });
      if (!reqRow) {
        res.status(404).json({ error: "Pending profile update request not found" });
        return;
      }
      await prisma.$transaction([
        prisma.user.update({
          where: { id },
          data: {
            ...(reqRow.address !== null ? { address: reqRow.address } : {}),
            ...(reqRow.panNumber !== null ? { panNumber: reqRow.panNumber } : {}),
            ...(reqRow.aadhaarNumber !== null
              ? { aadhaarNumber: reqRow.aadhaarNumber }
              : {}),
          },
        }),
        prisma.profileUpdateRequest.update({
          where: { id: reqRow.id },
          data: { status: "APPROVED", reviewedAt: new Date() },
        }),
      ]);
      res.json({ ok: true, message: "Profile update request approved." });
    } catch (err) {
      next(err);
    }
  });
  router.post("/users/:id/change-requests/:requestId/reject", async (req, res, next) => {
    try {
      const { id, requestId } = req.params;
      const updated = await prisma.profileUpdateRequest.updateMany({
        where: { id: requestId, userId: id, status: "PENDING" },
        data: { status: "REJECTED", reviewedAt: new Date() },
      });
      if (updated.count === 0) {
        res.status(404).json({ error: "Pending profile update request not found" });
        return;
      }
      res.json({ ok: true, message: "Profile update request rejected." });
    } catch (err) {
      next(err);
    }
  });
  router.get("/users/:id/balance", adminController.getUserBalance);
  router.post("/users/:id/reset-password-link", adminController.sendResetPasswordLink);
  router.delete("/users/:id/trades/flush", adminController.flushUserTrades);
  router.post("/trades/close-manual", adminController.closeManualTrade);

  router.get("/users/:id/trades-billing", async (req, res, next) => {
    try {
      const { id } = req.params;
      const user = await prisma.user.findUnique({
        where: { id },
        select: { id: true, email: true, name: true },
      });
      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      const trades = await prisma.trade.findMany({
        where: { userId: id },
        orderBy: { createdAt: "desc" },
        take: 200,
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

      const totalPnl = normalizedTrades.reduce((s, t) => s + t.pnl, 0);
      const totalAdminCommission = normalizedTrades.reduce(
        (s, t) => s + t.adminRevenue,
        0,
      );
      const [paidAgg, dueAgg] = await Promise.all([
        prisma.invoice.aggregate({
          where: { userId: id, status: InvoiceStatus.PAID },
          _sum: { amountDue: true },
        }),
        prisma.invoice.aggregate({
          where: { userId: id, status: { in: [InvoiceStatus.PENDING, InvoiceStatus.OVERDUE] } },
          _sum: { amountDue: true },
        }),
      ]);

      res.json({
        user,
        trades: normalizedTrades,
        billingSummary: {
          totalPnlToDate: totalPnl,
          totalAdminCommissionEarned: totalAdminCommission,
          amountPaid: paidAgg._sum.amountDue ?? 0,
          balanceDue: dueAgg._sum.amountDue ?? 0,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/users", async (req, res, next) => {
    try {
      const { email, password, role, status } = req.body as {
        email?: unknown;
        password?: unknown;
        role?: unknown;
        status?: unknown;
      };

      if (typeof email !== "string" || typeof password !== "string") {
        res.status(400).json({ error: "email and password are required" });
        return;
      }

      if (role !== undefined && (typeof role !== "string" || !roleValues.has(role))) {
        res.status(400).json({ error: "role must be ADMIN or USER" });
        return;
      }

      if (
        status !== undefined &&
        (typeof status !== "string" || !statusValues.has(status))
      ) {
        res.status(400).json({ error: "status must be ACTIVE or SUSPENDED" });
        return;
      }

      const user = await prisma.user.create({
        data: {
          email,
          password,
          ...(role !== undefined ? { role: role as Role } : {}),
          ...(status !== undefined ? { status: status as UserStatus } : {}),
        },
        select: {
          id: true,
          email: true,
          role: true,
          status: true,
          createdAt: true,
        },
      });

      res.status(201).json(user);
    } catch (err) {
      next(err);
    }
  });

  router.put("/users/:id", async (req, res, next) => {
    try {
      const { id } = req.params;
      const { status, role } = req.body as {
        status?: unknown;
        role?: unknown;
      };

      if (role !== undefined) {
        if (typeof role !== "string" || !roleValues.has(role)) {
          res.status(400).json({ error: "role must be ADMIN or USER" });
          return;
        }
      }

      if (status !== undefined) {
        if (typeof status !== "string" || !statusValues.has(status)) {
          res.status(400).json({ error: "status must be ACTIVE or SUSPENDED" });
          return;
        }
      }

      if (role === undefined && status === undefined) {
        res.status(400).json({ error: "Provide at least one of status or role" });
        return;
      }

      const data: { role?: Role; status?: UserStatus } = {};
      if (role !== undefined) data.role = role as Role;
      if (status !== undefined) data.status = status as UserStatus;

      const user = await prisma.user.update({
        where: { id },
        data,
        select: {
          id: true,
          email: true,
          role: true,
          status: true,
          createdAt: true,
        },
      });

      res.json(user);
    } catch (err) {
      next(err);
    }
  });

  router.delete("/users/:id", async (req, res, next) => {
    try {
      const { id } = req.params;
      await prisma.user.delete({ where: { id } });
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  router.get("/strategies", async (_req, res, next) => {
    try {
      const strategies = await prisma.strategy.findMany({
        orderBy: { createdAt: "desc" },
        select: STRATEGY_SELECT_ADMIN_LIST,
      });
      res.json(
        strategies.map((s) => {
          const { masterApiSecret, ...rest } = s;
          const hasSecret = Boolean(masterApiSecret?.trim());
          const credPresent = Boolean(s.masterApiKey?.trim() && hasSecret);
          return {
            ...rest,
            hasMasterApiSecret: hasSecret,
            masterConnection: {
              credentialsPresent: credPresent,
              ready: credPresent,
            },
          };
        }),
      );
    } catch (err) {
      next(err);
    }
  });

  router.post("/strategies", async (req, res, next) => {
    try {
      const body = req.body as Record<string, unknown>;
      const title = body.title;
      const description = body.description;
      const masterApiKey = body.masterApiKey;
      const slippage = body.slippage;
      const monthlyFee = body.monthlyFee;
      const profitShare = body.profitShare;
      const minCapital = body.minCapital;

      if (
        typeof title !== "string" ||
        typeof description !== "string" ||
        typeof masterApiKey !== "string" ||
        typeof monthlyFee !== "number" ||
        typeof minCapital !== "number"
      ) {
        res.status(400).json({
          error:
            "title, description, masterApiKey, monthlyFee, and minCapital are required (numbers where applicable)",
        });
        return;
      }

      if (typeof slippage !== "number" || typeof profitShare !== "number") {
        res.status(400).json({
          error: "slippage and profitShare must be numbers",
        });
        return;
      }

      const masterApiSecret =
        typeof body.masterApiSecret === "string" ? body.masterApiSecret : "";
      const performanceMetrics = parsePerformanceMetrics(
        body.performanceMetrics,
      );

      const syncActiveTrades =
        typeof body.syncActiveTrades === "boolean"
          ? body.syncActiveTrades
          : false;

      const strategy = await prisma.strategy.create({
        data: {
          title,
          description,
          masterApiKey,
          masterApiSecret,
          ...(performanceMetrics !== undefined
            ? { performanceMetrics }
            : {}),
          slippage,
          monthlyFee,
          profitShare,
          minCapital,
          syncActiveTrades,
        },
        select: STRATEGY_SELECT_ADMIN_SAFE,
      });

      res.status(201).json(strategy);
    } catch (err) {
      next(err);
    }
  });

  router.put("/strategies/:id", async (req, res, next) => {
    try {
      const { id } = req.params;
      const body = req.body as Record<string, unknown>;

      const data: {
        title?: string;
        description?: string;
        masterApiKey?: string;
        masterApiSecret?: string;
        performanceMetrics?: Prisma.InputJsonValue | typeof Prisma.DbNull;
        slippage?: number;
        monthlyFee?: number;
        profitShare?: number;
        minCapital?: number;
        syncActiveTrades?: boolean;
      } = {};

      if (body.title !== undefined) {
        if (typeof body.title !== "string") {
          res.status(400).json({ error: "title must be a string" });
          return;
        }
        data.title = body.title;
      }
      if (body.description !== undefined) {
        if (typeof body.description !== "string") {
          res.status(400).json({ error: "description must be a string" });
          return;
        }
        data.description = body.description;
      }
      if (body.masterApiKey !== undefined) {
        if (typeof body.masterApiKey !== "string") {
          res.status(400).json({ error: "masterApiKey must be a string" });
          return;
        }
        data.masterApiKey = body.masterApiKey;
      }
      if (body.masterApiSecret !== undefined) {
        if (typeof body.masterApiSecret !== "string") {
          res.status(400).json({ error: "masterApiSecret must be a string" });
          return;
        }
        if (body.masterApiSecret !== "") {
          data.masterApiSecret = body.masterApiSecret;
        }
      }
      if (body.performanceMetrics !== undefined) {
        if (body.performanceMetrics === null) {
          data.performanceMetrics = Prisma.DbNull;
        } else {
          const pm = parsePerformanceMetrics(body.performanceMetrics);
          if (pm === undefined) {
            res.status(400).json({
              error: "performanceMetrics must be a JSON object",
            });
            return;
          }
          data.performanceMetrics = pm;
        }
      }
      if (body.slippage !== undefined) {
        if (typeof body.slippage !== "number") {
          res.status(400).json({ error: "slippage must be a number" });
          return;
        }
        data.slippage = body.slippage;
      }
      if (body.monthlyFee !== undefined) {
        if (typeof body.monthlyFee !== "number") {
          res.status(400).json({ error: "monthlyFee must be a number" });
          return;
        }
        data.monthlyFee = body.monthlyFee;
      }
      if (body.profitShare !== undefined) {
        if (typeof body.profitShare !== "number") {
          res.status(400).json({ error: "profitShare must be a number" });
          return;
        }
        data.profitShare = body.profitShare;
      }
      if (body.minCapital !== undefined) {
        if (typeof body.minCapital !== "number") {
          res.status(400).json({ error: "minCapital must be a number" });
          return;
        }
        data.minCapital = body.minCapital;
      }
      if (body.syncActiveTrades !== undefined) {
        if (typeof body.syncActiveTrades !== "boolean") {
          res.status(400).json({ error: "syncActiveTrades must be a boolean" });
          return;
        }
        data.syncActiveTrades = body.syncActiveTrades;
      }
      if (Object.keys(data).length === 0) {
        res.status(400).json({ error: "No valid fields to update" });
        return;
      }

      try {
        const existingSync = await prisma.strategy.findUnique({
          where: { id },
          select: { syncActiveTrades: true },
        });

        const updateData: Prisma.StrategyUpdateInput = {};
        if (data.title !== undefined) updateData.title = data.title;
        if (data.description !== undefined)
          updateData.description = data.description;
        if (data.masterApiKey !== undefined)
          updateData.masterApiKey = data.masterApiKey;
        if (data.masterApiSecret !== undefined)
          updateData.masterApiSecret = data.masterApiSecret;
        if (data.performanceMetrics !== undefined)
          updateData.performanceMetrics = data.performanceMetrics;
        if (data.slippage !== undefined) updateData.slippage = data.slippage;
        if (data.monthlyFee !== undefined)
          updateData.monthlyFee = data.monthlyFee;
        if (data.profitShare !== undefined)
          updateData.profitShare = data.profitShare;
        if (data.minCapital !== undefined)
          updateData.minCapital = data.minCapital;
        if (data.syncActiveTrades !== undefined)
          updateData.syncActiveTrades = data.syncActiveTrades;

        const strategy = await prisma.strategy.update({
          where: { id },
          data: updateData,
          select: STRATEGY_SELECT_ADMIN_SAFE,
        });

        if (
          existingSync &&
          !existingSync.syncActiveTrades &&
          strategy.syncActiveTrades
        ) {
          const strategyId = id;
          void import("../services/tradeEngine.js")
            .then(({ lateJoinMirrorForAllActiveSubscribers }) =>
              lateJoinMirrorForAllActiveSubscribers(prisma, strategyId),
            )
            .catch((err) => {
              const msg = err instanceof Error ? err.message : String(err);
              console.error(
                `[admin] syncActiveTrades backfill failed strategyId=${id}:`,
                msg,
              );
            });
        }

        res.json(strategy);
      } catch (err: unknown) {
        if (
          err instanceof PrismaClientKnownRequestError &&
          err.code === "P2025"
        ) {
          res.status(404).json({ error: "Strategy not found" });
          return;
        }
        return next(err);
      }
    } catch (err) {
      next(err);
    }
  });

  /**
   * Force mirror master Delta open positions to all ACTIVE subscribers (same as late-join `executeTrade` path).
   * Does not require `syncActiveTrades` on the strategy.
   */
  router.post("/strategies/:id/force-sync", async (req, res, next) => {
    try {
      const { id } = req.params;
      const { forceMirrorOpenPositionsForAllSubscribers } = await import(
        "../services/tradeEngine.js"
      );
      const result = await forceMirrorOpenPositionsForAllSubscribers(
        prisma,
        id,
      );
      res.json({
        ok: true,
        strategyId: id,
        masterOpenLegs: result.masterOpenLegs,
        activeSubscribers: result.activeSubscribers,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes("must be set") ||
        msg.includes("Failed to fetch master")
      ) {
        res.status(400).json({ error: msg });
        return;
      }
      next(err);
    }
  });

  router.delete("/strategies/:id", async (req, res, next) => {
    try {
      const { id } = req.params;
      await prisma.strategy.delete({ where: { id } });
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  router.get("/revenue", adminController.getRevenueAnalytics);

  /**
   * Manual fire-the-cron endpoint for QA / staging.
   *
   * Runs `generateMonthlyInvoices` (the 1st-of-month job) and then
   * `runOverdueCheck` (the daily job) so a single call covers the entire
   * billing pipeline. Body accepts optional `{ month, year }` (1-indexed)
   * to target a specific calendar month — defaults to the previous calendar
   * month, mirroring the real cron.
   *
   * NOTE: keep behind admin auth; remove or feature-flag before production.
   */
  router.post("/trigger-billing-cron", async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as {
        month?: unknown;
        year?: unknown;
        userIds?: unknown;
        subscriptionIds?: unknown;
      };

      const opts: {
        month?: number;
        year?: number;
        scope?: { userIds?: string[]; subscriptionIds?: string[] };
      } = {};
      if (body.month !== undefined) {
        const m = Number(body.month);
        if (!Number.isInteger(m) || m < 1 || m > 12) {
          res
            .status(400)
            .json({ error: "month must be an integer between 1 and 12" });
          return;
        }
        opts.month = m;
      }
      if (body.year !== undefined) {
        const y = Number(body.year);
        if (!Number.isInteger(y) || y < 1970 || y > 9999) {
          res.status(400).json({ error: "year must be a 4-digit integer" });
          return;
        }
        opts.year = y;
      }

      if (
        (opts.month !== undefined && opts.year === undefined) ||
        (opts.year !== undefined && opts.month === undefined)
      ) {
        res
          .status(400)
          .json({ error: "month and year must be supplied together" });
        return;
      }

      const scope: { userIds?: string[]; subscriptionIds?: string[] } = {};
      if (Array.isArray(body.userIds)) {
        const list = body.userIds.filter(
          (x): x is string => typeof x === "string" && x.length > 0,
        );
        if (list.length > 0) scope.userIds = list;
      }
      if (Array.isArray(body.subscriptionIds)) {
        const list = body.subscriptionIds.filter(
          (x): x is string => typeof x === "string" && x.length > 0,
        );
        if (list.length > 0) scope.subscriptionIds = list;
      }
      if (scope.userIds || scope.subscriptionIds) {
        opts.scope = scope;
      }

      const monthly = await generateMonthlyInvoices(prisma, opts);
      const overdue = await runOverdueCheck(prisma);

      res.json({ ok: true, monthly, overdue });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/admin/revenue-stats
   *
   * Global platform metrics for the admin revenue dashboard:
   *   - `totalPlatformPnl`  — Σ realized PnL across every CLOSED trade
   *                          this UTC month (all users).
   *   - `expectedRevenue`   — Σ profitShare-weighted positive cumulative PnL
   *                          across every ACTIVE subscription this month.
   *   - `collectedRevenue`  — Σ amountDue from PAID invoices (all-time).
   *   - `pendingDues`       — Σ amountDue from PENDING + OVERDUE invoices.
   */
  router.get("/revenue-stats", async (_req, res, next) => {
    try {
      const [platformStats, paidAgg, pendingAgg] = await Promise.all([
        getPlatformRevenueStats(prisma),
        prisma.invoice.aggregate({
          where: { status: InvoiceStatus.PAID },
          _sum: { amountDue: true },
        }),
        prisma.invoice.aggregate({
          where: {
            status: { in: [InvoiceStatus.PENDING, InvoiceStatus.OVERDUE] },
          },
          _sum: { amountDue: true },
        }),
      ]);

      res.json({
        totalPlatformPnl: platformStats.totalPlatformPnl,
        expectedRevenue: platformStats.expectedRevenue,
        collectedRevenue: paidAgg._sum.amountDue ?? 0,
        pendingDues: pendingAgg._sum.amountDue ?? 0,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/revenue/analytics", adminController.getRevenueAnalytics);

  router.get("/revenue/monthly-breakdown", async (_req, res, next) => {
    try {
      const rows = await prisma.invoice.findMany({
        orderBy: [{ year: "desc" }, { month: "desc" }],
        select: { year: true, month: true, amountDue: true, status: true },
      });
      const byMonth = new Map<
        string,
        { year: number; month: number; paid: number; pending: number; overdue: number; total: number }
      >();
      for (const r of rows) {
        const key = `${r.year}-${r.month}`;
        const entry = byMonth.get(key) ?? {
          year: r.year,
          month: r.month,
          paid: 0,
          pending: 0,
          overdue: 0,
          total: 0,
        };
        entry.total += r.amountDue;
        if (r.status === InvoiceStatus.PAID) entry.paid += r.amountDue;
        if (r.status === InvoiceStatus.PENDING) entry.pending += r.amountDue;
        if (r.status === InvoiceStatus.OVERDUE) entry.overdue += r.amountDue;
        byMonth.set(key, entry);
      }
      res.json({ months: Array.from(byMonth.values()) });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/admin/invoices?status=ALL|PENDING_OVERDUE
   *
   * Master invoice list for the admin revenue dashboard. Each row joins the
   * owning user's email + the strategy title so the table is self-contained.
   * Default order: most recent billing period first.
   *
   * The `status` query param is a convenience server-side filter; the
   * dashboard also filters client-side with the same predicate.
   */
  router.get("/invoices", async (req, res, next) => {
    try {
      const statusRaw = req.query.status;
      const where:
        | { status?: { in: ("PENDING" | "OVERDUE")[] } }
        | Record<string, never> = {};
      if (typeof statusRaw === "string") {
        const upper = statusRaw.trim().toUpperCase();
        if (upper === "PENDING_OVERDUE" || upper === "OUTSTANDING") {
          (where as { status: { in: ("PENDING" | "OVERDUE")[] } }).status = {
            in: [InvoiceStatus.PENDING, InvoiceStatus.OVERDUE],
          };
        }
      }

      const rows = await prisma.invoice.findMany({
        where,
        orderBy: [
          { year: "desc" },
          { month: "desc" },
          { createdAt: "desc" },
        ],
        select: {
          id: true,
          userId: true,
          strategyId: true,
          month: true,
          year: true,
          totalPnl: true,
          amountDue: true,
          dueDate: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          user: { select: { email: true, name: true } },
          strategy: { select: { title: true } },
        },
      });

      const invoices = rows.map((r) => ({
        id: r.id,
        userId: r.userId,
        userEmail: r.user.email,
        userName: r.user.name,
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
  });

  /** Same payload as `GET /api/live-trades/admin/grouped` — lives under `/api/admin/*` for proxies that only forward admin API paths. */
  router.get("/live-trades/grouped", async (_req, res, next) => {
    try {
      const strategies = await getAdminGroupedLiveTrades(prisma);
      res.json({ strategies });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Master Delta (India) open positions per strategy via CCXT `fetchOpenPositions` (see `exchangeService.fetchDeltaOpenPositions`).
   * For full master + subscriber matching, use `GET /admin/live-trades/grouped`.
   */
  router.get("/live-trades/master-positions", async (_req, res, next) => {
    try {
      const strategies = await getAdminMasterPositionSnapshots(prisma);
      res.json({ strategies });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
