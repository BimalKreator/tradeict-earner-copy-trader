import { Router } from "express";
import { AdminRole, type PrismaClient } from "@prisma/client";
import { createWalletController } from "../controllers/walletController.js";
import {
  authenticateJwt,
  authorizeRoles,
  requireAdmin,
} from "../middleware/authMiddleware.js";

export function createWalletRoutes(prisma: PrismaClient): Router {
  const router = Router();
  const jwtAuth = authenticateJwt(prisma);
  const adminOnly = [
    jwtAuth,
    requireAdmin(prisma),
    authorizeRoles(AdminRole.SUPER_ADMIN, AdminRole.MANAGER),
  ];

  const wallet = createWalletController(prisma);

  router.post("/topup", jwtAuth, wallet.topUp);
  router.get("/me", jwtAuth, wallet.getMyWallet);
  router.get("/transactions", ...adminOnly, wallet.listTransactions);
  router.post("/approve", ...adminOnly, wallet.approve);

  return router;
}
