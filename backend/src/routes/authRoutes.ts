import { Router } from "express";
import { type PrismaClient } from "@prisma/client";
import { authenticateJwt } from "../middleware/authMiddleware.js";
import { createAuthController } from "../controllers/authController.js";
import {
  createTelegramLinkToken,
  telegramLinkExpiry,
} from "../services/telegramService.js";

export function createAuthRoutes(prisma: PrismaClient): Router {
  const router = Router();
  const auth = createAuthController(prisma);

  router.post("/send-otp", auth.sendSignupOtp);
  router.post("/register", auth.registerWithOtp);
  router.post("/send-login-otp", auth.sendLoginOtp);
  router.post("/verify-otp", auth.verifyOtp);

  router.post("/telegram-link-token", authenticateJwt(), async (req, res, next) => {
    try {
      const userId = req.userId;
      if (!userId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const linkToken = createTelegramLinkToken();
      const expiresAt = telegramLinkExpiry();

      await prisma.user.update({
        where: { id: userId },
        data: {
          telegramLinkToken: linkToken,
          telegramLinkExpires: expiresAt,
        },
      });

      const botUsername = process.env.TELEGRAM_BOT_USERNAME?.trim();
      const deepLink = botUsername
        ? `https://t.me/${botUsername}?start=${linkToken}`
        : undefined;

      res.status(200).json({
        linkToken,
        expiresAt: expiresAt.toISOString(),
        ...(deepLink ? { deepLink } : {}),
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
