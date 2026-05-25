import type { NextFunction, Request, Response } from "express";
import type { PrismaClient } from "@prisma/client";
import {
  mapFutureHedgeConfig,
  parseFutureHedgeBody,
  resolveFutureHedgeStrategy,
  validateFutureHedgeUpdate,
  type FutureHedgeAdminPayload,
} from "../services/futureHedgeService.js";

export function createFutureHedgeController(prisma: PrismaClient) {
  async function getConfig(
    _req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const strategy = await resolveFutureHedgeStrategy(prisma);
      const config = strategy.futureHedgeConfig!;
      const payload: FutureHedgeAdminPayload = {
        strategy: {
          id: strategy.id,
          title: strategy.title,
          description: strategy.description,
        },
        config: mapFutureHedgeConfig(config),
      };
      res.json(payload);
    } catch (err) {
      next(err);
    }
  }

  async function updateConfig(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const body = req.body as Record<string, unknown>;
      const updates = parseFutureHedgeBody(body);

      if (Object.keys(updates).length === 0) {
        res.status(400).json({
          error:
            "Provide at least one of isAutoEnabled, baseLots, emaPeriod, adjustmentPct, targetProfitUsd, currentBatchId",
        });
        return;
      }

      const validationError = validateFutureHedgeUpdate(updates);
      if (validationError) {
        res.status(400).json({ error: validationError });
        return;
      }

      const strategy = await resolveFutureHedgeStrategy(prisma);
      const config = await prisma.futureHedgeConfig.update({
        where: { strategyId: strategy.id },
        data: updates,
      });

      console.log(
        `[future-hedge] config updated strategyId=${strategy.id} isAutoEnabled=${config.isAutoEnabled} baseLots=${config.baseLots} emaPeriod=${config.emaPeriod}`,
      );

      const payload: FutureHedgeAdminPayload = {
        strategy: {
          id: strategy.id,
          title: strategy.title,
          description: strategy.description,
        },
        config: mapFutureHedgeConfig(config),
      };
      res.json(payload);
    } catch (err) {
      next(err);
    }
  }

  return { getConfig, updateConfig };
}
