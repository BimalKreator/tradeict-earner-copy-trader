-- 15.6: Trade.closedAt for month-straddling billing (bill in the month closed).
ALTER TABLE "Trade" ADD COLUMN IF NOT EXISTS "closedAt" TIMESTAMP(3);

UPDATE "Trade"
SET "closedAt" = "updatedAt"
WHERE status = 'CLOSED' AND "closedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "Trade_status_closedAt_idx" ON "Trade" ("status", "closedAt");
