import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { createSubscriptionController } from "../controllers/subscriptionController.js";
import { authenticateJwt } from "../middleware/authMiddleware.js";

export function createSubscriptionRoutes(prisma: PrismaClient): Router {
  const router = Router();
  const jwtAuth = authenticateJwt();
  const subscription = createSubscriptionController(prisma);

  router.post("/subscribe", jwtAuth, subscription.subscribe);

  return router;
}
