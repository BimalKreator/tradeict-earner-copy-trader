import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { authenticateJwt } from "../middleware/authMiddleware.js";
import { createExchangeAccountController } from "../controllers/exchangeAccountController.js";

export function createExchangeAccountRoutes(prisma: PrismaClient): Router {
  const router = Router();
  const jwtAuth = authenticateJwt();
  const ctrl = createExchangeAccountController(prisma);

  router.get("/", jwtAuth, ctrl.list);
  router.post("/", jwtAuth, ctrl.create);
  router.post("/test", jwtAuth, ctrl.testConnection);
  router.delete("/:id", jwtAuth, ctrl.remove);

  return router;
}
