-- Voluntary user pause vs funds/overdue pause.
ALTER TYPE "SubscriptionStatus" ADD VALUE IF NOT EXISTS 'PAUSED_BY_USER';

ALTER TABLE "UserSubscription"
  ADD COLUMN IF NOT EXISTS "profitSharePctSnapshot" DECIMAL(6, 3);

-- Backfill snapshot from current strategy rate (override wins when present).
UPDATE "UserSubscription" us
SET "profitSharePctSnapshot" = COALESCE(us."profitShareOverride", s."profitShare")
FROM "Strategy" s
WHERE us."strategyId" = s.id
  AND us."profitSharePctSnapshot" IS NULL;
