import type { PrismaClient } from "@prisma/client";
import { Router } from "express";
import { createPublicController } from "../controllers/publicController.js";
import { createSettingsController } from "../controllers/settingsController.js";

export function createPublicRoutes(prisma: PrismaClient): Router {
  const router = Router();
  const publicCtrl = createPublicController();
  const settings = createSettingsController(prisma);

  router.get("/platform-config", settings.getPublicPlatform);
  router.post("/apply-expert", publicCtrl.applyExpert);

  return router;
}
