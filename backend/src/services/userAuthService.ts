import bcrypt from "bcrypt";
import type { PrismaClient } from "@prisma/client";

const BCRYPT_ROUNDS = 12;
const OTP_TTL_MS = 10 * 60 * 1000;

/** 6th failed guess clears the stored OTP (attempts 1–5 keep it). */
export const OTP_FAIL_LIMIT = 6;

export type OtpConsumeResult = "ok" | "invalid";

async function hashOtp(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, BCRYPT_ROUNDS);
}

export async function storeLoginOtp(
  prisma: PrismaClient,
  userId: string,
  plaintext: string,
): Promise<void> {
  const loginOtpHash = await hashOtp(plaintext);
  await prisma.user.update({
    where: { id: userId },
    data: {
      loginOtpHash,
      loginOtpExpiry: new Date(Date.now() + OTP_TTL_MS),
      loginOtpAttempts: 0,
    },
  });
}

export async function storeResetOtp(
  prisma: PrismaClient,
  userId: string,
  plaintext: string,
): Promise<void> {
  const resetOtpHash = await hashOtp(plaintext);
  await prisma.user.update({
    where: { id: userId },
    data: {
      resetOtpHash,
      resetOtpExpiry: new Date(Date.now() + OTP_TTL_MS),
      resetOtpAttempts: 0,
    },
  });
}

async function clearLoginOtp(prisma: PrismaClient, userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: {
      loginOtpHash: null,
      loginOtpExpiry: null,
      loginOtpAttempts: 0,
    },
  });
}

async function clearResetOtp(prisma: PrismaClient, userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: {
      resetOtpHash: null,
      resetOtpExpiry: null,
      resetOtpAttempts: 0,
    },
  });
}

/**
 * Verify a login OTP. Correct code is cleared immediately.
 * After {@link OTP_FAIL_LIMIT} failures the hash is nulled (fresh request required).
 */
export async function consumeLoginOtp(
  prisma: PrismaClient,
  userId: string,
  plaintext: string,
): Promise<OtpConsumeResult> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      loginOtpHash: true,
      loginOtpExpiry: true,
      loginOtpAttempts: true,
    },
  });
  if (
    !user?.loginOtpHash ||
    !user.loginOtpExpiry ||
    user.loginOtpExpiry <= new Date()
  ) {
    return "invalid";
  }

  const match = await bcrypt.compare(plaintext, user.loginOtpHash);
  if (match) {
    await clearLoginOtp(prisma, userId);
    return "ok";
  }

  const attempts = user.loginOtpAttempts + 1;
  if (attempts >= OTP_FAIL_LIMIT) {
    await clearLoginOtp(prisma, userId);
    return "invalid";
  }
  await prisma.user.update({
    where: { id: userId },
    data: { loginOtpAttempts: attempts },
  });
  return "invalid";
}

/**
 * Verify a password-reset OTP. A login OTP will not match these fields.
 */
export async function consumeResetOtp(
  prisma: PrismaClient,
  userId: string,
  plaintext: string,
): Promise<OtpConsumeResult> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      resetOtpHash: true,
      resetOtpExpiry: true,
      resetOtpAttempts: true,
    },
  });
  if (
    !user?.resetOtpHash ||
    !user.resetOtpExpiry ||
    user.resetOtpExpiry <= new Date()
  ) {
    return "invalid";
  }

  const match = await bcrypt.compare(plaintext, user.resetOtpHash);
  if (match) {
    await clearResetOtp(prisma, userId);
    return "ok";
  }

  const attempts = user.resetOtpAttempts + 1;
  if (attempts >= OTP_FAIL_LIMIT) {
    await clearResetOtp(prisma, userId);
    return "invalid";
  }
  await prisma.user.update({
    where: { id: userId },
    data: { resetOtpAttempts: attempts },
  });
  return "invalid";
}

export async function bumpUserTokenVersion(
  prisma: PrismaClient,
  userId: string,
): Promise<number> {
  const updated = await prisma.user.update({
    where: { id: userId },
    data: { tokenVersion: { increment: 1 } },
    select: { tokenVersion: true },
  });
  return updated.tokenVersion;
}
