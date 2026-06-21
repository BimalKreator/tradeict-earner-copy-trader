import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import {
  authenticateToken,
  isAdmin,
} from "../middleware/authMiddleware.js";
import { createAdminController } from "../controllers/adminController.js";
import { createUserController } from "../controllers/userController.js";

export function createLiveTradesRoutes(prisma: PrismaClient): Router {
  const router = Router();
  const jwtAuth = authenticateToken(prisma);
  const adminOnly = [jwtAuth, isAdmin(prisma)];
  const admin = createAdminController(prisma);
  const user = createUserController(prisma);

  router.get("/me", jwtAuth, user.getLiveTradesByStrategy);

  router.get("/admin/grouped", ...adminOnly, admin.getGroupedLiveTrades);

  return router;
}
