import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import multer from "multer";
import { authenticateJwt } from "../middleware/authMiddleware.js";
import { createUserController } from "../controllers/userController.js";

export function createUserRoutes(prisma: PrismaClient): Router {
  const router = Router();
  const jwtAuth = authenticateJwt();
  const user = createUserController(prisma);
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
  const upload = multer({
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

  router.get("/me", jwtAuth, user.getMe);
  router.patch("/me", jwtAuth, user.patchMe);
  router.get("/dashboard-overview", jwtAuth, user.getDashboardOverview);
  router.patch("/copy-trading", jwtAuth, user.patchCopyTrading);
  router.post("/deposits", jwtAuth, upload.single("screenshot"), user.createDeposit);
  router.get("/deposits", jwtAuth, user.listDeposits);
  router.get("/trades", jwtAuth, user.listTrades);
  router.get("/trades/export", jwtAuth, user.exportTrades);
  router.get("/transactions/export", jwtAuth, user.exportTransactions);
  router.get("/invoices", jwtAuth, user.listInvoices);

  return router;
}
