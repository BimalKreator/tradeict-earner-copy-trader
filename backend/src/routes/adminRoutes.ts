import { Router } from "express";
import {
  type PrismaClient,
  InvoiceStatus,
  Role,
  UserStatus,
} from "@prisma/client";
import {
  authenticateJwt,
  requireAdmin,
} from "../middleware/authMiddleware.js";

const roleValues = new Set<string>(Object.values(Role));
const statusValues = new Set<string>(Object.values(UserStatus));

export function createAdminRoutes(prisma: PrismaClient): Router {
  const router = Router();
  const adminOnly = [authenticateJwt(), requireAdmin(prisma)];

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
      });
      res.json(strategies);
    } catch (err) {
      next(err);
    }
  });

  router.post("/strategies", async (req, res, next) => {
    try {
      const body = req.body as Record<string, unknown>;
      const title = body.title;
      const description = body.description;
      const cosmicApiKey = body.cosmicApiKey;
      const slippage = body.slippage;
      const monthlyFee = body.monthlyFee;
      const profitShare = body.profitShare;
      const minCapital = body.minCapital;

      if (
        typeof title !== "string" ||
        typeof description !== "string" ||
        typeof cosmicApiKey !== "string" ||
        typeof monthlyFee !== "number" ||
        typeof minCapital !== "number"
      ) {
        res.status(400).json({
          error:
            "title, description, cosmicApiKey, monthlyFee, and minCapital are required (numbers where applicable)",
        });
        return;
      }

      if (typeof slippage !== "number" || typeof profitShare !== "number") {
        res.status(400).json({
          error: "slippage and profitShare must be numbers",
        });
        return;
      }

      const strategy = await prisma.strategy.create({
        data: {
          title,
          description,
          cosmicApiKey,
          slippage,
          monthlyFee,
          profitShare,
          minCapital,
        },
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
        cosmicApiKey?: string;
        slippage?: number;
        monthlyFee?: number;
        profitShare?: number;
        minCapital?: number;
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
      if (body.cosmicApiKey !== undefined) {
        if (typeof body.cosmicApiKey !== "string") {
          res.status(400).json({ error: "cosmicApiKey must be a string" });
          return;
        }
        data.cosmicApiKey = body.cosmicApiKey;
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

      if (Object.keys(data).length === 0) {
        res.status(400).json({ error: "No valid fields to update" });
        return;
      }

      const strategy = await prisma.strategy.update({
        where: { id },
        data,
      });

      res.json(strategy);
    } catch (err) {
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

  router.get("/revenue", ...adminOnly, async (_req, res, next) => {
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

  return router;
}
