import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { createWalletController } from "../controllers/walletController.js";
import {
  authenticateJwt,
  requireAdmin,
} from "../middleware/authMiddleware.js";

export function createWalletRoutes(prisma: PrismaClient): Router {
  const router = Router();
  const jwtAuth = authenticateJwt();
  const adminOnly = [jwtAuth, requireAdmin(prisma)];

  const wallet = createWalletController(prisma);

  router.post("/topup", jwtAuth, wallet.topUp);
  router.get("/me", jwtAuth, wallet.getMyWallet);
  router.get("/transactions", ...adminOnly, wallet.listTransactions);
  router.post("/approve", ...adminOnly, wallet.approve);

  return router;
}
