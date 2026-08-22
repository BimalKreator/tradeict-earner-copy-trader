import type { NextFunction, Request, Response } from "express";
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  DASHBOARD_PNL_DAY_TIMEZONE,
  endOfDayInTimeZone,
  startOfDayInTimeZone,
} from "../services/dashboardMetricsService.js";
import { excludeSimulatedFilter } from "../services/simulatedDataFilters.js";

function dec(value: Prisma.Decimal | null | undefined): number | null {
  if (value == null) return null;
  return value.toNumber();
}

function parseLimit(raw: unknown, fallback = 50): number {
  const n =
    typeof raw === "string"
      ? parseInt(raw, 10)
      : typeof raw === "number"
        ? raw
        : fallback;
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, 200);
}

function parseIstDateStart(raw: unknown): Date | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const probe = new Date(`${raw.trim()}T12:00:00.000Z`);
  if (Number.isNaN(probe.getTime())) return null;
  return startOfDayInTimeZone(probe, DASHBOARD_PNL_DAY_TIMEZONE);
}

export function createMePerformanceController(prisma: PrismaClient) {
  async function listMyStructures(
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

      const statusRaw =
        typeof req.query.status === "string"
          ? req.query.status.trim().toLowerCase()
          : "";
      const limit = parseLimit(req.query.limit);

      const where: Prisma.StructurePnlWhereInput = {
        userId,
        ...excludeSimulatedFilter(false),
      };
      if (statusRaw === "closed") where.status = "closed";
      else if (statusRaw === "active") where.status = { not: "closed" };

      const rows = await prisma.structurePnl.findMany({
        where,
        orderBy: { openedAt: "desc" },
        take: limit,
        include: {
          legs: { orderBy: { openedAt: "asc" } },
        },
      });

      res.json({
        structures: rows.map((s) => ({
          id: s.id,
          botStructureId: s.botStructureId,
          hedgePositionId: s.hedgePositionId,
          underlying: s.underlying,
          status: s.status,
          openedAt: s.openedAt.toISOString(),
          closedAt: s.closedAt?.toISOString() ?? null,
          closeReason: s.closeReason,
          grossCashflow: dec(s.grossCashflow) ?? 0,
          commissionTotal: dec(s.commissionTotal) ?? 0,
          realizedPnl: dec(s.realizedPnl),
          legCount: s.legCount,
          closedLegCount: s.closedLegCount,
          matchedTxnCount: s.matchedTxnCount,
          computedAt: s.computedAt.toISOString(),
          legs: s.legs.map((leg) => ({
            id: leg.id,
            botLegId: leg.botLegId,
            legRole: leg.legRole,
            basketSeq: leg.basketSeq,
            adjSeq: leg.adjSeq,
            productId: leg.productId,
            symbol: leg.symbol,
            strike: leg.strike,
            side: leg.side,
            quantity: leg.quantity,
            openedAt: leg.openedAt.toISOString(),
            closedAt: leg.closedAt?.toISOString() ?? null,
            grossCashflow: dec(leg.grossCashflow) ?? 0,
            commissionTotal: dec(leg.commissionTotal) ?? 0,
            realizedPnl: dec(leg.realizedPnl),
            matchedTxnCount: leg.matchedTxnCount,
          })),
        })),
      });
    } catch (err) {
      next(err);
    }
  }

  async function listMyDailyPnl(
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

      const from = parseIstDateStart(req.query.from);
      const toStart = parseIstDateStart(req.query.to);
      const toEnd =
        toStart != null
          ? endOfDayInTimeZone(toStart, DASHBOARD_PNL_DAY_TIMEZONE)
          : null;

      const rows = await prisma.dailyPnlSnapshot.findMany({
        where: {
          userId,
          ...excludeSimulatedFilter(false),
          ...(from || toStart
            ? {
                snapshotDate: {
                  ...(from ? { gte: from } : {}),
                  ...(toEnd ? { lt: toEnd } : {}),
                },
              }
            : {}),
        },
        orderBy: { snapshotDate: "asc" },
      });

      res.json({
        snapshots: rows.map((row) => ({
          id: row.id,
          snapshotDate: row.snapshotDate.toISOString(),
          realizedDelta: dec(row.realizedDelta) ?? 0,
          cumulativeRealized: dec(row.cumulativeRealized) ?? 0,
          highWaterMark: dec(row.highWaterMark) ?? 0,
          commissionAccrued: dec(row.commissionAccrued) ?? 0,
          commissionCumulative: dec(row.commissionCumulative) ?? 0,
          openStructureCount: row.openStructureCount,
          computedAt: row.computedAt.toISOString(),
        })),
      });
    } catch (err) {
      next(err);
    }
  }

  async function listMyRevenueInvoices(
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

      const rows = await prisma.monthlyRevenueInvoice.findMany({
        where: { userId, ...excludeSimulatedFilter(false) },
        orderBy: [{ periodYear: "desc" }, { periodMonth: "desc" }],
      });

      res.json({
        invoices: rows.map((row) => ({
          id: row.id,
          periodYear: row.periodYear,
          periodMonth: row.periodMonth,
          structuresClosed: row.structuresClosed,
          realizedPnl: dec(row.realizedPnl) ?? 0,
          cumulativeRealizedPnl: dec(row.cumulativeRealizedPnl) ?? 0,
          hwmBefore: dec(row.hwmBefore) ?? 0,
          hwmAfter: dec(row.hwmAfter) ?? 0,
          billableProfit: dec(row.billableProfit) ?? 0,
          profitSharePct: dec(row.profitSharePct) ?? 0,
          commissionAmount: dec(row.commissionAmount) ?? 0,
          status: row.status,
          generatedAt: row.generatedAt.toISOString(),
        })),
      });
    } catch (err) {
      next(err);
    }
  }

  return {
    listMyStructures,
    listMyDailyPnl,
    listMyRevenueInvoices,
  };
}
