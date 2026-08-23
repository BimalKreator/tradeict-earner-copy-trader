-- Per-account ledger sync: tag rows with exchangeAccountId; move sync cursor to ExchangeAccount.
ALTER TABLE "ExchangeAccount"
  ADD COLUMN IF NOT EXISTS "deltaLedgerSyncedUpTo" TIMESTAMP(3);

-- Seed per-account cursors from the legacy per-user cursor (idempotent).
UPDATE "ExchangeAccount" ea
SET "deltaLedgerSyncedUpTo" = u."deltaLedgerSyncedUpTo"
FROM "User" u
WHERE ea."userId" = u.id
  AND ea."deltaLedgerSyncedUpTo" IS NULL
  AND u."deltaLedgerSyncedUpTo" IS NOT NULL;

ALTER TABLE "DeltaLedgerEntry"
  ADD COLUMN IF NOT EXISTS "exchangeAccountId" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'DeltaLedgerEntry_exchangeAccountId_fkey'
  ) THEN
    ALTER TABLE "DeltaLedgerEntry"
      ADD CONSTRAINT "DeltaLedgerEntry_exchangeAccountId_fkey"
      FOREIGN KEY ("exchangeAccountId") REFERENCES "ExchangeAccount"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "DeltaLedgerEntry_exchangeAccountId_idx"
  ON "DeltaLedgerEntry"("exchangeAccountId");
