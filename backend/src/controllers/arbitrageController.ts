import type { NextFunction, Request, Response } from "express";
import {
  CACHE_TTL_MS,
  filterValidDexArbitrageRows,
  getDexArbitrageData,
  invalidateDexArbitrageCache,
} from "../services/arbitrageService.js";

export function createArbitrageController() {
  async function getDexArbitrage(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const forceRefresh =
        req.query.refresh === "1" ||
        req.query.refresh === "true" ||
        req.query.force === "1" ||
        req.query.force === "true";

      if (forceRefresh) {
        invalidateDexArbitrageCache();
      }

      const { data, fromCache } = await getDexArbitrageData(forceRefresh);
      const rows = filterValidDexArbitrageRows(data.rows);

      res.setHeader("Cache-Control", "no-store");
      res.json({
        ...data,
        rows,
        fromCache,
        cacheTtlSeconds: Math.floor(CACHE_TTL_MS / 1000),
      });
    } catch (err) {
      next(err);
    }
  }

  return { getDexArbitrage };
}
