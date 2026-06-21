import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { authenticateJwt } from "../middleware/authMiddleware.js";
import { createArbitrageController } from "../controllers/arbitrageController.js";

export function createArbitrageRoutes(prisma: PrismaClient): Router {
  const router = Router();
  const controller = createArbitrageController();
  const jwtAuth = authenticateJwt(prisma);

  router.get("/dex", jwtAuth, controller.getDexArbitrage);

  return router;
}
