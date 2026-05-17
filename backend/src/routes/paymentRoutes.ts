import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import multer from "multer";
import { authenticateJwt } from "../middleware/authMiddleware.js";
import { createPaymentController } from "../controllers/paymentController.js";

function createDepositUpload() {
  const uploadDir = path.resolve(process.cwd(), "public", "uploads");
  fs.mkdirSync(uploadDir, { recursive: true });
  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || "").replace(
        /[^a-zA-Z0-9.]/g,
        "",
      );
      cb(
        null,
        `deposit-${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`,
      );
    },
  });
  return multer({
    storage,
    fileFilter: (_req, file, cb) => {
      if (file.mimetype.startsWith("image/")) {
        cb(null, true);
        return;
      }
      cb(new Error("Only image files are allowed for screenshots."));
    },
    limits: { fileSize: 5 * 1024 * 1024 },
  });
}

export function createPaymentRoutes(prisma: PrismaClient): Router {
  const router = Router();
  const jwtAuth = authenticateJwt();
  const payments = createPaymentController(prisma);
  const upload = createDepositUpload();

  router.get("/pg-fee", jwtAuth, payments.getPgFee);
  router.post("/create-order", jwtAuth, payments.createOrder);
  router.post("/verify", jwtAuth, payments.verifyPayment);
  router.post(
    "/manual-deposit",
    jwtAuth,
    upload.single("screenshot"),
    payments.manualDeposit,
  );
  router.get("/history", jwtAuth, payments.listHistory);
  router.get("/history/export", jwtAuth, payments.exportHistory);

  return router;
}
