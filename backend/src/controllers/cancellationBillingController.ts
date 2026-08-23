import type { NextFunction, Request, Response } from "express";
import type { PrismaClient } from "@prisma/client";
import {
  closeStructureAndFinaliseBillingForUser,
  mapCancellationBillingError,
} from "../services/cancellationBillingService.js";
import { requireTypedConfirmation } from "../utils/requireTypedConfirmation.js";

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

      const user = await prisma.user.findUnique({
        where: { id: userId.trim() },
        select: { email: true },
      });
      if (!user?.email) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      if (!requireTypedConfirmation(req, res, user.email)) {
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
        finalInvoiceSchedule: result.finalInvoiceSchedule,
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
