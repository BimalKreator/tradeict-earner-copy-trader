import type { NextFunction, Request, Response } from "express";
import { getDexArbitrageData } from "../services/arbitrageService.js";

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
        req.query.force === "true";

      const { data, fromCache } = await getDexArbitrageData(forceRefresh);

      res.json({
        ...data,
        fromCache,
      });
    } catch (err) {
      next(err);
    }
  }

  return { getDexArbitrage };
}
