import type { NextFunction, Request, Response } from "express";
import type { PrismaClient } from "@prisma/client";
import {
  getAllowedEmailDomains,
  getPgFeePercent,
  getUsdInrRate,
  setAllowedEmailDomains,
  setPgFeePercent,
  setUsdInrRate,
} from "../services/settingsService.js";

export function createSettingsController(prisma: PrismaClient) {
  async function getPaymentSettings(
    _req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const [pgFeePercent, allowedEmailDomains, usdInrRate] = await Promise.all([
        getPgFeePercent(prisma),
        getAllowedEmailDomains(prisma),
        getUsdInrRate(prisma),
      ]);
      res.json({ pgFeePercent, allowedEmailDomains, usdInrRate });
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
      const body = req.body as {
        pgFeePercent?: unknown;
        allowedEmailDomains?: unknown;
        usdInrRate?: unknown;
      };

      const out: {
        ok: true;
        pgFeePercent?: number;
        allowedEmailDomains?: string;
        usdInrRate?: number;
      } = {
        ok: true,
      };

      if (body.pgFeePercent !== undefined) {
        const pgFeePercent =
          typeof body.pgFeePercent === "number"
            ? body.pgFeePercent
            : typeof body.pgFeePercent === "string"
              ? Number.parseFloat(body.pgFeePercent)
              : NaN;

        if (!Number.isFinite(pgFeePercent)) {
          res.status(400).json({ error: "pgFeePercent must be a number" });
          return;
        }
        out.pgFeePercent = await setPgFeePercent(prisma, pgFeePercent);
      }

      if (body.usdInrRate !== undefined) {
        const usdInrRate =
          typeof body.usdInrRate === "number"
            ? body.usdInrRate
            : typeof body.usdInrRate === "string"
              ? Number.parseFloat(body.usdInrRate)
              : NaN;

        if (!Number.isFinite(usdInrRate)) {
          res.status(400).json({ error: "usdInrRate must be a number" });
          return;
        }
        try {
          out.usdInrRate = await setUsdInrRate(prisma, usdInrRate);
        } catch (err) {
          if (err instanceof Error && err.message.includes("usdInrRate")) {
            res.status(400).json({ error: err.message });
            return;
          }
          throw err;
        }
      }

      if (body.allowedEmailDomains !== undefined) {
        if (typeof body.allowedEmailDomains !== "string") {
          res.status(400).json({ error: "allowedEmailDomains must be a string" });
          return;
        }
        try {
          out.allowedEmailDomains = await setAllowedEmailDomains(
            prisma,
            body.allowedEmailDomains,
          );
        } catch (err) {
          if (err instanceof Error && err.message.includes("domain")) {
            res.status(400).json({ error: err.message });
            return;
          }
          throw err;
        }
      }

      if (
        out.pgFeePercent === undefined &&
        out.allowedEmailDomains === undefined &&
        out.usdInrRate === undefined
      ) {
        res.status(400).json({
          error:
            "Provide at least one of pgFeePercent, usdInrRate, or allowedEmailDomains",
        });
        return;
      }

      res.json(out);
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
