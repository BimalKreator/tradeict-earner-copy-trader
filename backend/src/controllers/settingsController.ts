import type { NextFunction, Request, Response } from "express";
import type { PrismaClient } from "@prisma/client";
import {
  getAllowedEmailDomains,
  getPgFeePercent,
  getPublicPlatformConfig,
  getUsdInrRate,
  setAllowedEmailDomains,
  setMaintenanceSettings,
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
      const [pgFeePercent, allowedEmailDomains, usdInrRate, platform] =
        await Promise.all([
          getPgFeePercent(prisma),
          getAllowedEmailDomains(prisma),
          getUsdInrRate(prisma),
          getPublicPlatformConfig(prisma),
        ]);
      res.json({
        pgFeePercent,
        allowedEmailDomains,
        usdInrRate,
        maintenanceMode: platform.maintenanceMode,
        maintenanceMessage: platform.maintenanceMessage,
      });
    } catch (err) {
      next(err);
    }
  }

  async function getPublicPlatform(
    _req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const config = await getPublicPlatformConfig(prisma);
      res.json(config);
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
        maintenanceMode?: unknown;
        maintenanceMessage?: unknown;
      };

      const out: {
        ok: true;
        pgFeePercent?: number;
        allowedEmailDomains?: string;
        usdInrRate?: number;
        maintenanceMode?: boolean;
        maintenanceMessage?: string | null;
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
        body.maintenanceMode !== undefined ||
        body.maintenanceMessage !== undefined
      ) {
        if (body.maintenanceMode !== undefined && typeof body.maintenanceMode !== "boolean") {
          res.status(400).json({ error: "maintenanceMode must be a boolean" });
          return;
        }
        const current = await getPublicPlatformConfig(prisma);
        const maintenanceMode =
          typeof body.maintenanceMode === "boolean"
            ? body.maintenanceMode
            : current.maintenanceMode;
        let maintenanceMessage: string | null = current.maintenanceMessage;
        if (body.maintenanceMessage !== undefined) {
          if (body.maintenanceMessage === null) {
            maintenanceMessage = null;
          } else if (typeof body.maintenanceMessage === "string") {
            maintenanceMessage = body.maintenanceMessage.trim() || null;
          } else {
            res.status(400).json({ error: "maintenanceMessage must be a string or null" });
            return;
          }
        }
        const saved = await setMaintenanceSettings(prisma, {
          maintenanceMode,
          maintenanceMessage,
        });
        out.maintenanceMode = saved.maintenanceMode;
        out.maintenanceMessage = saved.maintenanceMessage;
      }

      if (
        out.pgFeePercent === undefined &&
        out.allowedEmailDomains === undefined &&
        out.usdInrRate === undefined &&
        out.maintenanceMode === undefined
      ) {
        res.status(400).json({
          error:
            "Provide at least one of pgFeePercent, usdInrRate, allowedEmailDomains, or maintenance fields",
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

  return { getPaymentSettings, updatePaymentSettings, getPublicPlatform };
}
