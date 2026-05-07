import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { authenticateJwt } from "../middleware/authMiddleware.js";
import { createUserController } from "../controllers/userController.js";
import { createDepositController } from "../controllers/depositController.js";
import { uploadDepositScreenshot } from "../middleware/uploadMiddleware.js";

export function createUserRoutes(prisma: PrismaClient): Router {
  const router = Router();
  const jwtAuth = authenticateJwt();
  const user = createUserController(prisma);
  const deposits = createDepositController(prisma);

  router.get("/me", jwtAuth, user.getMe);
  router.patch("/me", jwtAuth, user.patchMe);
  router.get("/dashboard-overview", jwtAuth, user.getDashboardOverview);
  router.post(
    "/deposits",
    jwtAuth,
    uploadDepositScreenshot.single("screenshot"),
    deposits.createDeposit,
  );
  router.get("/deposits", jwtAuth, deposits.listMyDeposits);
  router.get("/trades", jwtAuth, user.listTrades);
  router.get("/invoices", jwtAuth, user.listInvoices);

  return router;
}
