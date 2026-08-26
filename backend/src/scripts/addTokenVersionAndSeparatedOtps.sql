-- 14.4 / 14.5 — Hand-apply on production (review before running).
-- Adds revocable JWT versioning and separated, hashed login vs reset OTPs.
-- New columns on existing "User" — no new table, no chown.
-- Apply on the SERVER database, then restart the API.
-- Local .env DATABASE_URL is not production.

BEGIN;

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "tokenVersion" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "loginOtpHash" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "loginOtpExpiry" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "loginOtpAttempts" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "resetOtpHash" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "resetOtpExpiry" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "resetOtpAttempts" INTEGER NOT NULL DEFAULT 0;

-- Drop the plaintext shared OTP columns (login and reset used the same field).
ALTER TABLE "User" DROP COLUMN IF EXISTS "otpCode";
ALTER TABLE "User" DROP COLUMN IF EXISTS "otpExpiry";

COMMIT;
