import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { createSubscriptionController } from "../controllers/subscriptionController.js";
import { authenticateJwt } from "../middleware/authMiddleware.js";

/**
 * Subscription APIs use only `masterApiKey` / `masterApiSecret` on the Strategy model for leader auth.
 * User-facing strategy payloads omit secrets via explicit `select` in the subscription controller.
 */
export function createSubscriptionRoutes(prisma: PrismaClient): Router {
  const router = Router();
  const jwtAuth = authenticateJwt();
  const subscription = createSubscriptionController(prisma);

  router.post("/subscribe", jwtAuth, subscription.subscribe);
  router.post("/:strategyId/deploy", jwtAuth, subscription.deploy);
  router.patch("/:strategyId/modify", jwtAuth, subscription.modify);
  router.patch("/:strategyId/pause", jwtAuth, subscription.pause);
  router.patch("/:strategyId/resume", jwtAuth, subscription.resume);
  router.delete("/:strategyId/remove", jwtAuth, subscription.remove);
  router.delete("/:strategyId", jwtAuth, subscription.remove);
  router.get("/mine", jwtAuth, subscription.listMySubscriptions);
  /** Marketplace list: same payload as GET /strategies (URLs differ by mount prefix). */
  router.get("/", jwtAuth, subscription.listStrategies);
  router.get("/strategies", jwtAuth, subscription.listStrategies);
  router.get("/strategies/:id", jwtAuth, subscription.getStrategy);

  return router;
}
