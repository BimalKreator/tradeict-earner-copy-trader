import type { NextFunction, Request, Response } from "express";
import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import {
  computeAllUsersLedgerHealth,
  getAdminRevenueOverview,
  getAdminRevenueUserDetail,
} from "../services/adminDeltaRevenueService.js";
import { listEligibleStructurePnlUserIds } from "../services/structurePnlService.js";
import { previousIstCalendarMonth } from "../services/structureRevenueService.js";

function parsePeriod(
  yearRaw: unknown,
  monthRaw: unknown,
): { year: number; month: number } {
  const y =
    typeof yearRaw === "string"
      ? parseInt(yearRaw, 10)
      : typeof yearRaw === "number"
        ? yearRaw
        : NaN;
  const m =
    typeof monthRaw === "string"
      ? parseInt(monthRaw, 10)
      : typeof monthRaw === "number"
        ? monthRaw
        : NaN;
  if (Number.isFinite(y) && Number.isFinite(m) && m >= 1 && m <= 12) {
    return { year: y, month: m };
  }
  return previousIstCalendarMonth();
}

export function createAdminDeltaRevenueController(prisma: PrismaClient) {
  async function getOverview(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const { year, month } = parsePeriod(req.query.year, req.query.month);
      const data = await getAdminRevenueOverview(prisma, year, month);
      res.json(data);
    } catch (err) {
      next(err);
    }
  }

  async function getUserDetail(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const raw = req.params.userId;
      const userId = Array.isArray(raw) ? raw[0] : raw;
      if (typeof userId !== "string" || !userId.trim()) {
        res.status(400).json({ error: "userId required" });
        return;
      }
      const detail = await getAdminRevenueUserDetail(prisma, userId.trim());
      if (!detail) {
        res.status(404).json({ error: "User not found" });
        return;
      }
      res.json(detail);
    } catch (err) {
      next(err);
    }
  }

  async function getHealth(
    _req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userIds = await listEligibleStructurePnlUserIds(prisma);
      const health = await computeAllUsersLedgerHealth(prisma, userIds);
      const users = await prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, email: true, name: true },
      });
      const emailById = new Map(users.map((u) => [u.id, u.email]));
      res.json({
        users: health.map((h) => ({
          ...h,
          email: emailById.get(h.userId) ?? null,
        })),
      });
    } catch (err) {
      next(err);
    }
  }

  async function patchProfitShareOverride(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const raw = req.params.userId;
      const userId = Array.isArray(raw) ? raw[0] : raw;
      if (typeof userId !== "string" || !userId.trim()) {
        res.status(400).json({ error: "userId required" });
        return;
      }

      const body = req.body as { profitShareOverride?: unknown };
      let override: Prisma.Decimal | null = null;
      if (body.profitShareOverride === null) {
        override = null;
      } else if (typeof body.profitShareOverride === "number") {
        if (!Number.isFinite(body.profitShareOverride) || body.profitShareOverride < 0) {
          res.status(400).json({ error: "profitShareOverride must be >= 0 or null" });
          return;
        }
        override = new Prisma.Decimal(body.profitShareOverride);
      } else {
        res.status(400).json({ error: "profitShareOverride must be a number or null" });
        return;
      }

      const sub = await prisma.userStrategySubscription.findFirst({
        where: {
          userId: userId.trim(),
          strategy: { botStrategyType: { not: null } },
        },
        orderBy: { joinedDate: "desc" },
      });
      if (!sub) {
        res.status(404).json({ error: "No bot strategy subscription for user" });
        return;
      }

      await prisma.userStrategySubscription.update({
        where: { id: sub.id },
        data: { profitShareOverride: override },
      });

      res.json({
        ok: true,
        userId: userId.trim(),
        subscriptionId: sub.id,
        profitShareOverride: override?.toNumber() ?? null,
      });
    } catch (err) {
      next(err);
    }
  }

  return {
    getOverview,
    getUserDetail,
    getHealth,
    patchProfitShareOverride,
  };
}
