import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import nodemailer from "nodemailer";
import { Router } from "express";
import {
  type PrismaClient,
  Role,
} from "@prisma/client";

const OTP_TTL_MS = 10 * 60 * 1000;

function generateSixDigitOtp(): string {
  return String(crypto.randomInt(100_000, 1_000_000));
}

function createMailTransport() {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) {
    throw new Error("SMTP_HOST, SMTP_USER, and SMTP_PASS must be set");
  }
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || "587", 10),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

export function createAuthRoutes(prisma: PrismaClient): Router {
  const router = Router();

  router.post("/send-otp", async (req, res, next) => {
    try {
      const emailRaw = (req.body as { email?: unknown }).email;
      if (typeof emailRaw !== "string" || !emailRaw.trim()) {
        res.status(400).json({ error: "email is required" });
        return;
      }
      const email = emailRaw.trim().toLowerCase();

      const otpCode = generateSixDigitOtp();
      const otpExpiry = new Date(Date.now() + OTP_TTL_MS);

      const existing = await prisma.user.findUnique({ where: { email } });

      if (existing) {
        await prisma.user.update({
          where: { id: existing.id },
          data: { otpCode, otpExpiry },
        });
      } else {
        const placeholderPassword = crypto.randomBytes(24).toString("hex");
        await prisma.user.create({
          data: {
            email,
            password: placeholderPassword,
            role: Role.USER,
            otpCode,
            otpExpiry,
          },
        });
      }

      const transport = createMailTransport();
      await transport.sendMail({
        from: process.env.EMAIL_FROM,
        to: email,
        subject: "Your login code",
        text: `Your verification code is ${otpCode}. It expires in 10 minutes.`,
        html: `<p>Your verification code is <strong>${otpCode}</strong>.</p><p>It expires in 10 minutes.</p>`,
      });

      res.status(200).json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.post("/verify-otp", async (req, res, next) => {
    try {
      const body = req.body as {
        email?: unknown;
        otpCode?: unknown;
      };
      if (typeof body.email !== "string" || !body.email.trim()) {
        res.status(400).json({ error: "email is required" });
        return;
      }
      if (typeof body.otpCode !== "string" || !body.otpCode.trim()) {
        res.status(400).json({ error: "otpCode is required" });
        return;
      }

      const email = body.email.trim().toLowerCase();
      const otpCode = body.otpCode.trim();

      const secret = process.env.JWT_SECRET;
      if (!secret) {
        res.status(500).json({ error: "JWT_SECRET is not configured" });
        return;
      }

      const user = await prisma.user.findUnique({ where: { email } });
      if (!user || !user.otpCode || !user.otpExpiry) {
        res.status(401).json({ error: "Invalid or expired OTP" });
        return;
      }

      if (user.otpCode !== otpCode || user.otpExpiry <= new Date()) {
        res.status(401).json({ error: "Invalid or expired OTP" });
        return;
      }

      await prisma.user.update({
        where: { id: user.id },
        data: {
          otpCode: null,
          otpExpiry: null,
        },
      });

      const token = jwt.sign(
        { sub: user.id, email: user.email },
        secret,
        { expiresIn: "7d" },
      );

      res.status(200).json({ token });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
