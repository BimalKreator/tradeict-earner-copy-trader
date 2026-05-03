import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import {
  authenticateToken,
  isAdmin,
} from "../middleware/authMiddleware.js";
import {
  getAdminGroupedLiveTrades,
  getUserLiveTradeRows,
} from "../services/liveTradesService.js";

export function createLiveTradesRoutes(prisma: PrismaClient): Router {
  const router = Router();
  const jwtAuth = authenticateToken();
  const adminOnly = [jwtAuth, isAdmin(prisma)];

  router.get("/me", jwtAuth, async (req, res, next) => {
    try {
      const userId = req.userId;
      if (!userId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      const positions = await getUserLiveTradeRows(prisma, userId);
      res.json({ positions });
    } catch (err) {
      next(err);
    }
  });

  router.get("/admin/grouped", ...adminOnly, async (_req, res, next) => {
    try {
      const strategies = await getAdminGroupedLiveTrades(prisma);
      res.json({ strategies });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
