import type { NextFunction, Request, Response } from "express";
import type { PrismaClient } from "@prisma/client";
import {
  SimulationNotAllowedError,
  SimulationPurgeBlockedError,
  getSimulationChainState,
  purgeSimulatedDeltaRevenue,
  simulateDeltaRevenueStructure,
  type SimulationScenario,
  type SimulateStructureInput,
} from "../services/deltaRevenueSimulatorService.js";

const SCENARIOS = new Set<SimulationScenario>([
  "PROFIT",
  "LOSS",
  "PROFIT_THEN_LOSS_THEN_PROFIT",
]);

function isSimulationScenario(value: unknown): value is SimulationScenario {
  return typeof value === "string" && SCENARIOS.has(value as SimulationScenario);
}

export function createDeltaRevenueSimulatorController(prisma: PrismaClient) {
  async function postSimulateStructure(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const body = (req.body ?? {}) as {
        userId?: unknown;
        scenario?: unknown;
        realizedPnl?: unknown;
        closedAtIst?: unknown;
      };

      const userId =
        typeof body.userId === "string" && body.userId.trim()
          ? body.userId.trim()
          : "";
      if (!userId) {
        res.status(400).json({ error: "userId is required" });
        return;
      }
      if (!isSimulationScenario(body.scenario)) {
        res.status(400).json({
          error: "scenario must be PROFIT, LOSS, or PROFIT_THEN_LOSS_THEN_PROFIT",
        });
        return;
      }

      let realizedPnl: number | undefined;
      if (body.realizedPnl !== undefined && body.realizedPnl !== null) {
        const n =
          typeof body.realizedPnl === "number"
            ? body.realizedPnl
            : typeof body.realizedPnl === "string"
              ? parseFloat(body.realizedPnl)
              : NaN;
        if (!Number.isFinite(n)) {
          res.status(400).json({ error: "realizedPnl must be a finite number" });
          return;
        }
        realizedPnl = n;
      }

      const closedAtIst =
        typeof body.closedAtIst === "string" && body.closedAtIst.trim()
          ? body.closedAtIst.trim()
          : undefined;

      const input: SimulateStructureInput = {
        userId,
        scenario: body.scenario,
      };
      if (realizedPnl !== undefined) input.realizedPnl = realizedPnl;
      if (closedAtIst !== undefined) input.closedAtIst = closedAtIst;

      const result = await simulateDeltaRevenueStructure(prisma, input);
      res.status(201).json(result);
    } catch (err) {
      if (err instanceof SimulationNotAllowedError) {
        res.status(403).json({ error: err.message });
        return;
      }
      next(err);
    }
  }

  async function postPurge(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const body = (req.body ?? {}) as { userId?: unknown };
      const userId =
        typeof body.userId === "string" && body.userId.trim()
          ? body.userId.trim()
          : undefined;

      const result = await purgeSimulatedDeltaRevenue(prisma, userId);
      res.json(result);
    } catch (err) {
      if (err instanceof SimulationPurgeBlockedError) {
        res.status(409).json({ error: err.message });
        return;
      }
      next(err);
    }
  }

  async function getChain(
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

      const user = await prisma.user.findUnique({
        where: { id: userId.trim() },
        select: { id: true, email: true, allowSimulation: true },
      });
      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      const chain = await getSimulationChainState(prisma, user.id, true);
      res.json({ user, chain });
    } catch (err) {
      next(err);
    }
  }

  async function patchAllowSimulation(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const raw = req.params.id;
      const userId = Array.isArray(raw) ? raw[0] : raw;
      if (typeof userId !== "string" || !userId.trim()) {
        res.status(400).json({ error: "user id required" });
        return;
      }

      const allow =
        (req.body as { allowSimulation?: unknown })?.allowSimulation;
      if (typeof allow !== "boolean") {
        res.status(400).json({ error: "allowSimulation must be a boolean" });
        return;
      }

      const user = await prisma.user.update({
        where: { id: userId.trim() },
        data: { allowSimulation: allow },
        select: { id: true, email: true, allowSimulation: true },
      });
      res.json({ user });
    } catch (err) {
      next(err);
    }
  }

  return {
    postSimulateStructure,
    postPurge,
    getChain,
    patchAllowSimulation,
  };
}
