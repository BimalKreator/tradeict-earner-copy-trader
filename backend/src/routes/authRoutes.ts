import { Router } from "express";
import rateLimit from "express-rate-limit";
import { type PrismaClient } from "@prisma/client";
import { authenticateJwt } from "../middleware/authMiddleware.js";
import { createAuthController } from "../controllers/authController.js";
import {
  createTelegramLinkToken,
  telegramLinkExpiry,
} from "../services/telegramService.js";

/** Brute-force guard for credential and OTP endpoints (5 attempts / 10 min). */
export const authSensitiveRateLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Try again in 10 minutes." },
});

export function createAuthRoutes(prisma: PrismaClient): Router {
  const router = Router();
  const auth = createAuthController(prisma);
  const jwtAuth = authenticateJwt(prisma);

  router.post("/send-otp", auth.sendSignupOtp);
  router.post("/register", auth.registerWithOtp);
  router.post("/login", authSensitiveRateLimiter, auth.login);
  /** @deprecated Use POST /auth/login with email + password */
  router.post("/send-login-otp", authSensitiveRateLimiter, auth.login);
  router.post("/verify-otp", authSensitiveRateLimiter, auth.verifyOtp);
  router.post("/logout", auth.logout);
  router.post("/forgot-password", authSensitiveRateLimiter, auth.forgotPassword);
  router.post("/reset-password", auth.resetPassword);

  router.post("/telegram-link-token", jwtAuth, async (req, res, next) => {
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
