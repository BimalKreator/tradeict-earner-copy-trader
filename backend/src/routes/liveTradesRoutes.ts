import { Router } from "express";
import { AdminRole, type PrismaClient } from "@prisma/client";
import {
  authenticateToken,
  authorizeRoles,
  isAdmin,
} from "../middleware/authMiddleware.js";
import { createAdminAuditMiddleware } from "../middleware/adminAuditMiddleware.js";
import { createAdminController } from "../controllers/adminController.js";
import { createUserController } from "../controllers/userController.js";
import { fetchBotSlaveStructureForUser } from "../services/botBridgeService.js";

export function createLiveTradesRoutes(prisma: PrismaClient): Router {
  const router = Router();
  const jwtAuth = authenticateToken(prisma);
  const adminOnly = [
    jwtAuth,
    isAdmin(prisma),
    authorizeRoles(AdminRole.SUPER_ADMIN, AdminRole.MANAGER),
    createAdminAuditMiddleware(prisma),
  ];
  const admin = createAdminController(prisma);
  const user = createUserController(prisma);

  router.get("/me", jwtAuth, user.getLiveTradesByStrategy);

  /** Live bot structure for Consistent Earning — from /api/slave/overview, not Trade. */
  router.get("/bot-structure", jwtAuth, async (req, res, next) => {
    try {
      const userId = req.userId;
      if (!userId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      const payload = await fetchBotSlaveStructureForUser(userId);
      res.json(payload);
    } catch (err) {
      next(err);
    }
  });

  router.get("/admin/grouped", ...adminOnly, admin.getGroupedLiveTrades);

  return router;
}
