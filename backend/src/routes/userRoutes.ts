import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { authenticateJwt } from "../middleware/authMiddleware.js";
import { createUserController } from "../controllers/userController.js";

export function createUserRoutes(prisma: PrismaClient): Router {
  const router = Router();
  const jwtAuth = authenticateJwt();
  const user = createUserController(prisma);

  router.get("/me", jwtAuth, user.getMe);
  router.patch("/me", jwtAuth, user.patchMe);

  return router;
}
