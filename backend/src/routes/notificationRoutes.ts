import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { authenticateJwt } from "../middleware/authMiddleware.js";
import { createNotificationController } from "../controllers/notificationController.js";

export function createNotificationRoutes(prisma: PrismaClient): Router {
  const router = Router();
  const jwtAuth = authenticateJwt();
  const notification = createNotificationController(prisma);

  router.get("/", jwtAuth, notification.listNotifications);
  router.put("/:id/read", jwtAuth, notification.markNotificationRead);

  return router;
}

