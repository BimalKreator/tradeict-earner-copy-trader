import type { NextFunction, Request, Response } from "express";
import type { PrismaClient } from "@prisma/client";
import {
  getPgFeePercent,
  setPgFeePercent,
} from "../services/settingsService.js";

export function createSettingsController(prisma: PrismaClient) {
  async function getPaymentSettings(
    _req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const pgFeePercent = await getPgFeePercent(prisma);
      res.json({ pgFeePercent });
    } catch (err) {
      next(err);
    }
  }

  async function updatePaymentSettings(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const raw = (req.body as { pgFeePercent?: unknown }).pgFeePercent;
      const pgFeePercent =
        typeof raw === "number"
          ? raw
          : typeof raw === "string"
            ? Number.parseFloat(raw)
            : NaN;

      if (!Number.isFinite(pgFeePercent)) {
        res.status(400).json({ error: "pgFeePercent must be a number" });
        return;
      }

      const updated = await setPgFeePercent(prisma, pgFeePercent);
      res.json({ ok: true, pgFeePercent: updated });
    } catch (err) {
      if (err instanceof Error && err.message.includes("pgFeePercent")) {
        res.status(400).json({ error: err.message });
        return;
      }
      next(err);
    }
  }

  return { getPaymentSettings, updatePaymentSettings };
}
