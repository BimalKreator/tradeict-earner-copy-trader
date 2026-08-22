ALTER TABLE "Trade" ADD COLUMN IF NOT EXISTS "source" TEXT;

UPDATE "Trade" t
SET "source" = 'BOT_SYNC_LEGACY'
FROM "Strategy" s
WHERE t."strategyId" = s.id
  AND t."exitReason" = 'BOT_SYNC_CLOSE'
  AND s."botStrategyType" IS NOT NULL
  AND s."botStrategyType" <> ''
  AND (t."source" IS NULL OR t."source" = '');
