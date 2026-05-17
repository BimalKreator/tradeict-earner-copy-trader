import crypto from "node:crypto";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import type { NextFunction, Request, Response } from "express";
import { Role, type PrismaClient } from "@prisma/client";
import {
  EMAIL_DOMAIN_BLOCKED_MESSAGE,
  isEmailDomainAllowed,
} from "../services/settingsService.js";
import { sendOtpEmail } from "../utils/emailService.js";

const OTP_TTL_MS = 10 * 60 * 1000;
const BCRYPT_ROUNDS = 12;

/** Razorpay verification team — password-only login, no OTP email. */
const RAZORPAY_TEST_EMAIL = "test@tradeictearner.online";
const RAZORPAY_TEST_PASSWORD = "RazorpayTest2026#";

function generateSixDigitOtp(): string {
  return String(crypto.randomInt(100_000, 1_000_000));
}

function sanitizeUser(user: {
  id: string;
  email: string;
  name: string | null;
  role: Role;
}) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
  };
}

function isRazorpayBypassLogin(email: string, password: string): boolean {
  return (
    email === RAZORPAY_TEST_EMAIL && password === RAZORPAY_TEST_PASSWORD
  );
}

async function findUserByLoginIdentifier(
  prisma: PrismaClient,
  identifier: string,
) {
  const trimmed = identifier.trim();
  if (!trimmed) return null;

  if (trimmed.includes("@")) {
    return prisma.user.findUnique({
      where: { email: trimmed.toLowerCase() },
    });
  }

  const digitsOnly = trimmed.replace(/\D/g, "");
  return prisma.user.findFirst({
    where: {
      OR: [
        { mobile: trimmed },
        ...(digitsOnly.length >= 10 ? [{ mobile: { contains: digitsOnly } }] : []),
      ],
    },
  });
}

async function ensureRazorpayTestUser(prisma: PrismaClient) {
  const existing = await prisma.user.findUnique({
    where: { email: RAZORPAY_TEST_EMAIL },
  });
  if (existing) return existing;

  const passwordHash = await bcrypt.hash(RAZORPAY_TEST_PASSWORD, BCRYPT_ROUNDS);
  return prisma.user.create({
    data: {
      email: RAZORPAY_TEST_EMAIL,
      password: passwordHash,
      name: "Razorpay Verification",
      mobile: "8840737660",
      role: Role.USER,
    },
  });
}

export function createAuthController(prisma: PrismaClient) {
  async function rejectDisallowedEmail(
    res: Response,
    email: string,
  ): Promise<boolean> {
    if (email.trim().toLowerCase() === RAZORPAY_TEST_EMAIL) {
      return false;
    }
    const allowed = await isEmailDomainAllowed(prisma, email);
    if (!allowed) {
      res.status(403).json({ error: EMAIL_DOMAIN_BLOCKED_MESSAGE });
      return true;
    }
    return false;
  }

  async function sendSignupOtp(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const emailRaw = (req.body as { email?: unknown }).email;
      if (typeof emailRaw !== "string" || !emailRaw.trim()) {
        res.status(400).json({ error: "email is required" });
        return;
      }
      const email = emailRaw.trim().toLowerCase();

      if (await rejectDisallowedEmail(res, email)) return;

      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) {
        res.status(409).json({
          error: "An account with this email already exists",
        });
        return;
      }

      const otpCode = generateSixDigitOtp();
      const expiresAt = new Date(Date.now() + OTP_TTL_MS);

      await prisma.otpRecord.deleteMany({ where: { email } });
      const record = await prisma.otpRecord.create({
        data: { email, otp: otpCode, expiresAt },
      });

      try {
        await sendOtpEmail(email, otpCode, "Sign Up");
      } catch (err) {
        await prisma.otpRecord.delete({ where: { id: record.id } }).catch(() => {});
        throw err;
      }

      res.status(200).json({ ok: true });
    } catch (err) {
      next(err);
    }
  }

  async function registerWithOtp(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const body = req.body as Record<string, unknown>;
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const email =
        typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      const mobile =
        typeof body.mobile === "string" ? body.mobile.trim() : "";
      const password =
        typeof body.password === "string" ? body.password : "";
      const otp = typeof body.otp === "string" ? body.otp.trim() : "";

      if (!name || !email || !mobile || !password || !otp) {
        res.status(400).json({
          error: "name, email, mobile, password, and otp are required",
        });
        return;
      }
      if (password.length < 8) {
        res.status(400).json({
          error: "password must be at least 8 characters",
        });
        return;
      }

      if (await rejectDisallowedEmail(res, email)) return;

      const secret = process.env.JWT_SECRET;
      if (!secret) {
        res.status(500).json({ error: "JWT_SECRET is not configured" });
        return;
      }

      const existingUser = await prisma.user.findUnique({ where: { email } });
      if (existingUser) {
        res.status(409).json({
          error: "An account with this email already exists",
        });
        return;
      }

      const record = await prisma.otpRecord.findFirst({
        where: { email },
        orderBy: { createdAt: "desc" },
      });

      if (
        !record ||
        record.otp !== otp ||
        record.expiresAt <= new Date()
      ) {
        res.status(401).json({ error: "Invalid or expired OTP" });
        return;
      }

      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

      await prisma.$transaction(async (tx) => {
        await tx.user.create({
          data: {
            email,
            password: passwordHash,
            name,
            mobile,
            role: Role.USER,
          },
        });
        await tx.otpRecord.delete({ where: { id: record.id } });
      });

      const user = await prisma.user.findUnique({ where: { email } });
      if (!user) {
        res.status(500).json({ error: "Registration failed" });
        return;
      }

      const token = jwt.sign(
        { sub: user.id, email: user.email },
        secret,
        { expiresIn: "7d" },
      );

      res.status(200).json({ token });
    } catch (err) {
      next(err);
    }
  }

  /**
   * Step 1: verify password. Step 2: OTP sent via email (unless Razorpay test bypass).
   */
  async function login(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const body = req.body as Record<string, unknown>;
      const identifierRaw =
        typeof body.email === "string" && body.email.trim()
          ? body.email
          : typeof body.phone === "string" && body.phone.trim()
            ? body.phone
            : typeof body.identifier === "string"
              ? body.identifier
              : "";
      const password =
        typeof body.password === "string" ? body.password : "";

      if (!identifierRaw.trim() || !password) {
        res.status(400).json({
          error: "email (or phone) and password are required",
        });
        return;
      }

      const secret = process.env.JWT_SECRET;
      if (!secret) {
        res.status(500).json({ error: "JWT_SECRET is not configured" });
        return;
      }

      const identifier = identifierRaw.trim();
      const emailForBypass = identifier.includes("@")
        ? identifier.toLowerCase()
        : "";

      if (
        emailForBypass &&
        isRazorpayBypassLogin(emailForBypass, password)
      ) {
        const user = await ensureRazorpayTestUser(prisma);
        const token = jwt.sign(
          { sub: user.id, email: user.email },
          secret,
          { expiresIn: "7d" },
        );
        res.status(200).json({
          success: true,
          token,
          user: sanitizeUser(user),
        });
        return;
      }

      const user = await findUserByLoginIdentifier(prisma, identifier);
      if (!user) {
        res.status(401).json({ error: "Invalid email or password" });
        return;
      }

      if (await rejectDisallowedEmail(res, user.email)) return;

      const passwordOk = await bcrypt.compare(password, user.password);
      if (!passwordOk) {
        res.status(401).json({ error: "Invalid email or password" });
        return;
      }

      const otpCode = generateSixDigitOtp();
      const otpExpiry = new Date(Date.now() + OTP_TTL_MS);

      await prisma.user.update({
        where: { id: user.id },
        data: { otpCode, otpExpiry },
      });

      await sendOtpEmail(user.email, otpCode, "Login");

      res.status(200).json({
        otpRequired: true,
        email: user.email,
      });
    } catch (err) {
      next(err);
    }
  }

  async function verifyOtp(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
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

      if (await rejectDisallowedEmail(res, email)) return;

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

      res.status(200).json({
        success: true,
        token,
        user: sanitizeUser(user),
      });
    } catch (err) {
      next(err);
    }
  }

  return {
    sendSignupOtp,
    registerWithOtp,
    login,
    verifyOtp,
  };
}
