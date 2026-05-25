-- Per-strategy copy subscription: explicit isActive gate + one row per user/strategy pair.

ALTER TABLE "UserSubscription" ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN NOT NULL DEFAULT true;

UPDATE "UserSubscription"
SET "isActive" = ("status" = 'ACTIVE')
WHERE "isActive" IS DISTINCT FROM ("status" = 'ACTIVE');

CREATE UNIQUE INDEX IF NOT EXISTS "UserSubscription_userId_strategyId_key"
ON "UserSubscription"("userId", "strategyId");
