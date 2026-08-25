-- 11.6 — Hand-apply on production (review before running).
-- Separates real vs simulated DailyPnlSnapshot / MonthlyRevenueInvoice unique slots.
-- Prisma cannot ship this via migrate for this task — apply manually.

-- Prerequisite: ensure isSimulated columns exist (already on live schema).
-- If any duplicate (userId, date/period, isSimulated) rows exist, resolve them
-- before creating the new unique indexes.

BEGIN;

DROP INDEX IF EXISTS "DailyPnlSnapshot_userId_snapshotDate_key";
CREATE UNIQUE INDEX "DailyPnlSnapshot_userId_snapshotDate_isSimulated_key"
  ON "DailyPnlSnapshot" ("userId", "snapshotDate", "isSimulated");

DROP INDEX IF EXISTS "MonthlyRevenueInvoice_userId_periodYear_periodMonth_key";
CREATE UNIQUE INDEX "MonthlyRevenueInvoice_userId_periodYear_periodMonth_isSimulated_key"
  ON "MonthlyRevenueInvoice" ("userId", "periodYear", "periodMonth", "isSimulated");

COMMIT;
