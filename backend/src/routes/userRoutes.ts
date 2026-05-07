import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { authenticateJwt } from "../middleware/authMiddleware.js";
import { createUserController } from "../controllers/userController.js";

export function createUserRoutes(prisma: PrismaClient): Router {
  const router = Router();
  const jwtAuth = authenticateJwt();
  const user = createUserController(prisma);

  router.get("/me", jwtAuth, user.getMe);
  router.patch("/me", jwtAuth, user.patchMe);
  router.get("/dashboard-overview", jwtAuth, user.getDashboardOverview);
  router.get("/trades", jwtAuth, user.listTrades);
  router.get("/invoices", jwtAuth, user.listInvoices);

  return router;
}
