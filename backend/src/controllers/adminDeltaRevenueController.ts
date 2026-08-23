import type { NextFunction, Request, Response } from "express";
import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import {
  computeAllUsersLedgerHealth,
  getAdminRevenueOverview,
  getAdminRevenueReconcile,
  getAdminRevenueUserDetail,
  getUnbilledRevenueUsers,
} from "../services/adminDeltaRevenueService.js";
import { getAttributionHealthForUser } from "../services/structureAttributionHealthService.js";
import { listEligibleStructurePnlUserIds } from "../services/structurePnlService.js";
import {
  previousIstCalendarMonth,
  recomputeInvoiceChain,
} from "../services/structureRevenueService.js";
import {
  CreditNoteError,
  INVOICE_STATUS,
  InvoiceNotFoundError,
  InvoiceTransitionError,
  applyMonthlyRevenueInvoiceCreditNote,
  getMonthlyRevenueInvoiceLedger,
  parseMonthlyRevenueInvoiceStatus,
  transitionMonthlyRevenueInvoiceStatus,
} from "../services/monthlyRevenueInvoiceLifecycleService.js";
import { requireTypedConfirmation } from "../utils/requireTypedConfirmation.js";
import { parseIncludeSimulated } from "../services/simulatedDataFilters.js";

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
      const includeSimulated = parseIncludeSimulated(req.query.includeSimulated);
      const data = await getAdminRevenueOverview(prisma, year, month, includeSimulated);
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
      const detail = await getAdminRevenueUserDetail(
        prisma,
        userId.trim(),
        parseIncludeSimulated(req.query.includeSimulated),
      );
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
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userIds = await listEligibleStructurePnlUserIds(prisma);
      const includeSimulated = parseIncludeSimulated(req.query.includeSimulated);
      const health = await computeAllUsersLedgerHealth(
        prisma,
        userIds,
        includeSimulated,
      );
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

  async function getReconcile(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const { year, month } = parsePeriod(req.query.year, req.query.month);
      const includeSimulated = parseIncludeSimulated(req.query.includeSimulated);
      const data = await getAdminRevenueReconcile(
        prisma,
        year,
        month,
        includeSimulated,
      );
      res.json(data);
    } catch (err) {
      next(err);
    }
  }

  async function getAttributionHealth(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const raw = req.query.userId;
      const userId =
        typeof raw === "string" && raw.trim()
          ? raw.trim()
          : Array.isArray(raw) && typeof raw[0] === "string"
            ? raw[0].trim()
            : "";
      if (!userId) {
        res.status(400).json({ error: "userId query parameter is required" });
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

      const data = await getAttributionHealthForUser(prisma, userId);
      res.json(data);
    } catch (err) {
      next(err);
    }
  }

  async function postRecomputeChain(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const body = (req.body ?? {}) as {
        userId?: unknown;
        isSimulated?: unknown;
      };
      const userId =
        typeof body.userId === "string" && body.userId.trim()
          ? body.userId.trim()
          : "";
      if (!userId) {
        res.status(400).json({ error: "userId is required" });
        return;
      }

      const isSimulated =
        body.isSimulated === true || body.isSimulated === "true";

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true },
      });
      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      const result = await recomputeInvoiceChain(prisma, userId, isSimulated);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  async function postInvoiceStatus(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const rawId = req.params.id;
      const invoiceId = Array.isArray(rawId) ? rawId[0] : rawId;
      if (typeof invoiceId !== "string" || !invoiceId.trim()) {
        res.status(400).json({ error: "invoice id required" });
        return;
      }

      const body = (req.body ?? {}) as {
        status?: unknown;
        reason?: unknown;
        paymentReference?: unknown;
      };

      let targetStatus;
      try {
        targetStatus = parseMonthlyRevenueInvoiceStatus(body.status);
      } catch (err) {
        if (err instanceof InvoiceTransitionError) {
          res.status(400).json({ error: err.message });
          return;
        }
        throw err;
      }

      const transitionOpts: {
        reason?: string;
        paymentReference?: string;
      } = {};
      if (typeof body.reason === "string" && body.reason.trim()) {
        transitionOpts.reason = body.reason.trim();
      }
      if (
        typeof body.paymentReference === "string" &&
        body.paymentReference.trim()
      ) {
        transitionOpts.paymentReference = body.paymentReference.trim();
      }

      if (targetStatus === INVOICE_STATUS.VOID) {
        const inv = await prisma.monthlyRevenueInvoice.findUnique({
          where: { id: invoiceId.trim() },
          include: { user: { select: { email: true } } },
        });
        if (!inv) {
          res.status(404).json({ error: "Invoice not found" });
          return;
        }
        if (
          !requireTypedConfirmation(req, res, inv.user.email)
        ) {
          return;
        }
      }

      const invoice = await transitionMonthlyRevenueInvoiceStatus(
        prisma,
        invoiceId.trim(),
        targetStatus,
        transitionOpts,
      );

      res.json({ ok: true, invoice });
    } catch (err) {
      if (err instanceof InvoiceNotFoundError) {
        res.status(404).json({ error: err.message });
        return;
      }
      if (err instanceof InvoiceTransitionError) {
        res.status(400).json({ error: err.message });
        return;
      }
      next(err);
    }
  }

  async function getInvoiceCommissions(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const rawId = req.params.id;
      const invoiceId = Array.isArray(rawId) ? rawId[0] : rawId;
      if (typeof invoiceId !== "string" || !invoiceId.trim()) {
        res.status(400).json({ error: "invoice id required" });
        return;
      }

      const invoice = await prisma.monthlyRevenueInvoice.findUnique({
        where: { id: invoiceId.trim() },
        select: {
          id: true,
          userId: true,
          periodYear: true,
          periodMonth: true,
          status: true,
          commissionAmount: true,
          isSimulated: true,
        },
      });
      if (!invoice) {
        res.status(404).json({ error: "Invoice not found" });
        return;
      }

      const rows = await prisma.commissionLedger.findMany({
        where: { monthlyRevenueInvoiceId: invoice.id },
        include: {
          beneficiaryUser: {
            select: { id: true, email: true, name: true },
          },
        },
        orderBy: [{ beneficiaryUserId: "asc" }, { createdAt: "asc" }],
      });

      res.json({
        invoiceId: invoice.id,
        userId: invoice.userId,
        periodYear: invoice.periodYear,
        periodMonth: invoice.periodMonth,
        invoiceStatus: invoice.status,
        commissionAmount: invoice.commissionAmount.toNumber(),
        isSimulated: invoice.isSimulated,
        commissions: rows.map((row) => ({
          id: row.id,
          beneficiaryUserId: row.beneficiaryUserId,
          beneficiaryEmail: row.beneficiaryUser.email,
          beneficiaryName: row.beneficiaryUser.name,
          amount: row.amount.toNumber(),
          appRevenueBase: row.appRevenueBase,
          commissionRate: row.commissionRate,
          beneficiaryTier: row.beneficiaryTier,
          status: row.status,
          profitDate: row.profitDate,
          unlockDate: row.unlockDate.toISOString(),
          payableAt: row.payableAt?.toISOString() ?? null,
          isSimulated: row.isSimulated,
          idempotencyKey: row.idempotencyKey,
        })),
      });
    } catch (err) {
      next(err);
    }
  }

  async function postInvoiceCreditNote(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const rawId = req.params.id;
      const invoiceId = Array.isArray(rawId) ? rawId[0] : rawId;
      if (typeof invoiceId !== "string" || !invoiceId.trim()) {
        res.status(400).json({ error: "invoice id required" });
        return;
      }

      const inv = await prisma.monthlyRevenueInvoice.findUnique({
        where: { id: invoiceId.trim() },
        include: { user: { select: { email: true } } },
      });
      if (!inv) {
        res.status(404).json({ error: "Invoice not found" });
        return;
      }
      if (!requireTypedConfirmation(req, res, inv.user.email)) {
        return;
      }

      const body = (req.body ?? {}) as { amount?: unknown; reason?: unknown };
      const amountRaw = body.amount;
      const amountNum =
        typeof amountRaw === "number"
          ? amountRaw
          : typeof amountRaw === "string"
            ? Number.parseFloat(amountRaw)
            : NaN;
      if (!Number.isFinite(amountNum) || amountNum <= 0) {
        res.status(400).json({ error: "amount must be a positive number" });
        return;
      }

      const reason =
        typeof body.reason === "string" ? body.reason.trim() : "";
      if (!reason) {
        res.status(400).json({ error: "reason is required" });
        return;
      }

      const invoice = await applyMonthlyRevenueInvoiceCreditNote(
        prisma,
        invoiceId.trim(),
        {
          amount: new Prisma.Decimal(amountNum),
          reason,
        },
      );

      res.json({ ok: true, invoice });
    } catch (err) {
      if (err instanceof InvoiceNotFoundError) {
        res.status(404).json({ error: err.message });
        return;
      }
      if (err instanceof CreditNoteError) {
        res.status(400).json({ error: err.message });
        return;
      }
      next(err);
    }
  }

  async function getInvoiceLedger(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const rawId = req.params.id;
      const invoiceId = Array.isArray(rawId) ? rawId[0] : rawId;
      if (typeof invoiceId !== "string" || !invoiceId.trim()) {
        res.status(400).json({ error: "invoice id required" });
        return;
      }

      const ledger = await getMonthlyRevenueInvoiceLedger(
        prisma,
        invoiceId.trim(),
      );
      if (!ledger) {
        res.status(404).json({ error: "Invoice not found" });
        return;
      }
      res.json(ledger);
    } catch (err) {
      next(err);
    }
  }

  async function getUnbilledUsers(
    _req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const data = await getUnbilledRevenueUsers(prisma);
      res.json(data);
    } catch (err) {
      next(err);
    }
  }

  return {
    getOverview,
    getUserDetail,
    getHealth,
    getReconcile,
    getAttributionHealth,
    patchProfitShareOverride,
    postRecomputeChain,
    postInvoiceStatus,
    postInvoiceCreditNote,
    getInvoiceCommissions,
    getInvoiceLedger,
    getUnbilledUsers,
  };
}
