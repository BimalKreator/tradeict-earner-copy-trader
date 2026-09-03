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
import {
  resolveEmailRecipientName,
  sendTemplateEmailAsync,
} from "../services/emailService.js";
import {
  clearAuthCookie,
  extractAccessToken,
  setAdminAuthCookie,
  setAuthCookie,
  signAdminAuthToken,
  signAuthToken,
} from "../utils/authToken.js";
import { isPlatformAdminUser } from "../utils/platformAdmin.js";
import {
  bumpUserTokenVersion,
  consumeLoginOtp,
  consumeResetOtp,
  storeLoginOtp,
  storeResetOtp,
} from "../services/userAuthService.js";
import {
  incrementAffiliateDirectAcquiredCount,
  resolveAffiliateUserIdByReferralCode,
} from "../services/affiliateMemberService.js";
import { normalizeAffiliateRoleEnum } from "../utils/roleNormalize.js";

const OTP_TTL_MS = 10 * 60 * 1000;
const BCRYPT_ROUNDS = 12;

function generateSixDigitOtp(): string {
  return String(crypto.randomInt(100_000, 1_000_000));
}

function sanitizeUser(user: {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  arbAccess?: boolean;
}) {
  const role = normalizeAffiliateRoleEnum(user.role) ?? user.role;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role,
    arbAccess: user.arbAccess === true,
  };
}

function issueAuthSession(
  res: Response,
  user: {
    id: string;
    email: string;
    role: Role;
    adminRole?: import("@prisma/client").AdminRole | null;
    tokenVersion: number;
  },
  secret: string,
): string {
  const payload = {
    sub: user.id,
    email: user.email,
    role: user.role,
    tokenVersion: user.tokenVersion,
  };
  const token = signAuthToken(payload, secret);
  setAuthCookie(res, token);

  // Separate short-TTL admin cookie — do not silently reuse the 30d customer cookie.
  if (isPlatformAdminUser(user)) {
    const adminToken = signAdminAuthToken(payload, secret);
    setAdminAuthCookie(res, adminToken);
    return adminToken;
  }

  return token;
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

export function createAuthController(prisma: PrismaClient) {
  /**
   * SIGNUP ONLY. Never call from login, verify-otp, or password reset —
   * narrowing the domain list must not lock out an existing account.
   */
  async function rejectDisallowedEmail(
    res: Response,
    email: string,
  ): Promise<boolean> {
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
      const referralCode =
        typeof body.referralCode === "string" ? body.referralCode.trim() : "";

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

      const acquiredById = referralCode
        ? await resolveAffiliateUserIdByReferralCode(
            prisma,
            referralCode,
            email,
          )
        : null;

      await prisma.$transaction(async (tx) => {
        await tx.user.create({
          data: {
            email,
            password: passwordHash,
            name,
            mobile,
            role: Role.USER,
            ...(acquiredById ? { acquiredById } : {}),
          },
        });
        if (acquiredById) {
          await incrementAffiliateDirectAcquiredCount(tx, acquiredById);
        }
        await tx.otpRecord.delete({ where: { id: record.id } });
      });

      const user = await prisma.user.findUnique({ where: { email } });
      if (!user) {
        res.status(500).json({ error: "Registration failed" });
        return;
      }

      const token = issueAuthSession(res, user, secret);

      sendTemplateEmailAsync(user.email, "welcome", {
        userName: resolveEmailRecipientName(user.name, user.email),
      });

      res.status(200).json({
        token,
        user: sanitizeUser(user),
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * Step 1: verify password. Step 2: OTP sent via email (unless isOtpBypassed).
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

      const user = await findUserByLoginIdentifier(prisma, identifier);
      if (!user) {
        res.status(401).json({ error: "Invalid email or password" });
        return;
      }

      const passwordOk = await bcrypt.compare(password, user.password);
      if (!passwordOk) {
        res.status(401).json({ error: "Invalid email or password" });
        return;
      }

      if (user.isOtpBypassed) {
        const token = issueAuthSession(res, user, secret);
        res.status(200).json({
          success: true,
          token,
          user: sanitizeUser(user),
        });
        return;
      }

      const otpCode = generateSixDigitOtp();
      await storeLoginOtp(prisma, user.id, otpCode);
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

      const secret = process.env.JWT_SECRET;
      if (!secret) {
        res.status(500).json({ error: "JWT_SECRET is not configured" });
        return;
      }

      const user = await prisma.user.findUnique({ where: { email } });
      if (!user) {
        res.status(401).json({ error: "Invalid or expired OTP" });
        return;
      }

      const consumed = await consumeLoginOtp(prisma, user.id, otpCode);
      if (consumed !== "ok") {
        res.status(401).json({ error: "Invalid or expired OTP" });
        return;
      }

      const fresh = await prisma.user.findUnique({ where: { id: user.id } });
      if (!fresh) {
        res.status(401).json({ error: "Invalid or expired OTP" });
        return;
      }

      const token = issueAuthSession(res, fresh, secret);

      res.status(200).json({
        success: true,
        token,
        user: sanitizeUser(fresh),
      });
    } catch (err) {
      next(err);
    }
  }

  async function logout(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const secret = process.env.JWT_SECRET;
      const token = extractAccessToken(req);
      if (secret && token) {
        try {
          const decoded = jwt.verify(token, secret);
          if (
            typeof decoded === "object" &&
            decoded !== null &&
            typeof (decoded as { sub?: unknown }).sub === "string"
          ) {
            await bumpUserTokenVersion(
              prisma,
              (decoded as { sub: string }).sub,
            );
          }
        } catch {
          // Expired or invalid token — still clear the cookie.
        }
      }
      clearAuthCookie(res);
      res.status(200).json({ ok: true });
    } catch (err) {
      next(err);
    }
  }

  async function forgotPassword(
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

      const user = await prisma.user.findUnique({ where: { email } });
      if (user) {
        const otpCode = generateSixDigitOtp();
        await storeResetOtp(prisma, user.id, otpCode);
        await sendOtpEmail(email, otpCode, "Password Reset");
      }

      res.status(200).json({
        ok: true,
        message:
          "If an account exists for this email, a password reset code has been sent.",
      });
    } catch (err) {
      next(err);
    }
  }

  async function resetPassword(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const body = req.body as {
        email?: unknown;
        otp?: unknown;
        newPassword?: unknown;
      };
      const email =
        typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      const otp =
        typeof body.otp === "string"
          ? body.otp.trim()
          : typeof body.otp === "number"
            ? String(body.otp)
            : "";
      const newPassword =
        typeof body.newPassword === "string" ? body.newPassword : "";

      if (!email || !otp || !newPassword) {
        res.status(400).json({
          error: "email, otp, and newPassword are required",
        });
        return;
      }
      if (newPassword.length < 8) {
        res.status(400).json({
          error: "newPassword must be at least 8 characters",
        });
        return;
      }

      const user = await prisma.user.findUnique({ where: { email } });
      if (!user) {
        res.status(401).json({ error: "Invalid or expired OTP" });
        return;
      }

      const consumed = await consumeResetOtp(prisma, user.id, otp);
      if (consumed !== "ok") {
        res.status(401).json({ error: "Invalid or expired OTP" });
        return;
      }

      const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

      await prisma.user.update({
        where: { id: user.id },
        data: {
          password: passwordHash,
          loginOtpHash: null,
          loginOtpExpiry: null,
          loginOtpAttempts: 0,
          tokenVersion: { increment: 1 },
        },
      });

      res.status(200).json({
        ok: true,
        message: "Password reset successful. You can sign in with your new password.",
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
    logout,
    forgotPassword,
    resetPassword,
  };
}
