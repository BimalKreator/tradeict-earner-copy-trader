import { Router } from "express";
import {
  Prisma,
  type PrismaClient,
  InvoiceStatus,
  Role,
  UserStatus,
} from "@prisma/client";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/client";
import { authenticateToken, isAdmin } from "../middleware/authMiddleware.js";
import {
  getAdminGroupedLiveTrades,
  getAdminMasterPositionSnapshots,
} from "../services/liveTradesService.js";
import {
  STRATEGY_SELECT_ADMIN_LIST,
  STRATEGY_SELECT_ADMIN_SAFE,
} from "../prisma/strategySelect.js";

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

export function createAdminRoutes(prisma: PrismaClient): Router {
  const router = Router();

  router.use(authenticateToken(), isAdmin(prisma));

  router.get("/engine-status", (_req, res) => {
    res.json({ status: "running" });
  });

  router.get("/users", async (_req, res, next) => {
    try {
      const users = await prisma.user.findMany({
        select: {
          id: true,
          email: true,
          role: true,
          status: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
      });
      res.json(users);
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

  router.get("/revenue", async (_req, res, next) => {
    try {
      const now = new Date();
      const monthStart = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
      );

      const [
        paidAgg,
        pendingAgg,
        projectedAgg,
        invoices,
      ] = await Promise.all([
        prisma.invoice.aggregate({
          where: { status: InvoiceStatus.PAID },
          _sum: { amount: true },
        }),
        prisma.invoice.aggregate({
          where: {
            status: {
              in: [InvoiceStatus.UNPAID, InvoiceStatus.OVERDUE],
            },
          },
          _sum: { amount: true },
        }),
        prisma.pnLRecord.aggregate({
          where: { timestamp: { gte: monthStart } },
          _sum: { commissionAmount: true },
        }),
        prisma.invoice.findMany({
          orderBy: { dueDate: "desc" },
          include: {
            user: { select: { email: true } },
          },
        }),
      ]);

      res.json({
        stats: {
          totalRevenueReceived: paidAgg._sum.amount ?? 0,
          pendingDuesUnpaid: pendingAgg._sum.amount ?? 0,
          projectedEarnings: projectedAgg._sum.commissionAmount ?? 0,
        },
        invoices,
      });
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
