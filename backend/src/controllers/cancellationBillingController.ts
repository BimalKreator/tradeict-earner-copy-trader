import type { NextFunction, Request, Response } from "express";
import type { PrismaClient } from "@prisma/client";
import {
  closeStructureAndFinaliseBillingForUser,
  mapCancellationBillingError,
} from "../services/cancellationBillingService.js";

export function createCancellationBillingController(prisma: PrismaClient) {
  async function adminCloseStructureAndFinalise(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const rawId = req.params.id ?? req.params.userId;
      const userId = Array.isArray(rawId) ? rawId[0] : rawId;
      if (typeof userId !== "string" || !userId.trim()) {
        res.status(400).json({ error: "userId required" });
        return;
      }

      const result = await closeStructureAndFinaliseBillingForUser(
        prisma,
        userId.trim(),
        "ADMIN_MANUAL",
      );

      res.json({
        ok: true,
        userId: userId.trim(),
        closeCounts: result.closeCounts,
        invoice: {
          id: result.invoice.id,
          periodYear: result.invoice.periodYear,
          periodMonth: result.invoice.periodMonth,
          billableProfit: result.invoice.billableProfit.toNumber(),
          commissionAmount: result.invoice.commissionAmount.toNumber(),
          status: result.invoice.status,
          isFinal: result.invoice.isFinal,
        },
      });
    } catch (err) {
      const mapped = mapCancellationBillingError(err);
      if (mapped) {
        res.status(mapped.status).json(mapped.body);
        return;
      }
      next(err);
    }
  }

  return { adminCloseStructureAndFinalise };
}
