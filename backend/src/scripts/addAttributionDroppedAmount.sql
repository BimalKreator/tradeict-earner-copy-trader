-- 15.1: record how much attribution could not assign (overlap / refused rows).
-- Apply by hand on the server (column on existing table — no chown needed).
--
--   psql "$DATABASE_URL" -f backend/src/scripts/addAttributionDroppedAmount.sql

ALTER TABLE "StructurePnl"
  ADD COLUMN IF NOT EXISTS "attributionDroppedAmount" DECIMAL(24, 10);
