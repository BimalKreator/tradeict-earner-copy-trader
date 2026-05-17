import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { authenticateJwt } from "../middleware/authMiddleware.js";
import { createPaymentController } from "../controllers/paymentController.js";

export function createPaymentRoutes(prisma: PrismaClient): Router {
  const router = Router();
  const jwtAuth = authenticateJwt();
  const payments = createPaymentController(prisma);

  router.post("/create-order", jwtAuth, payments.createOrder);
  router.post("/verify", jwtAuth, payments.verifyPayment);

  return router;
}
