import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { authenticateJwt } from "../middleware/authMiddleware.js";
import { createMePerformanceController } from "../controllers/mePerformanceController.js";

/** User-scoped read APIs — `userId` always from JWT, never from body. */
export function createMeRoutes(prisma: PrismaClient): Router {
  const router = Router();
  const jwtAuth = authenticateJwt(prisma);
  const performance = createMePerformanceController(prisma);

  router.get("/structures", jwtAuth, performance.listMyStructures);
  router.get("/pnl/daily", jwtAuth, performance.listMyDailyPnl);
  router.get("/revenue/invoices", jwtAuth, performance.listMyRevenueInvoices);

  return router;
}
