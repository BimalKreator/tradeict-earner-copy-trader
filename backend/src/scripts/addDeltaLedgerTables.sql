ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "deltaLedgerSyncedUpTo" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "DeltaLedgerEntry" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "deltaUuid" TEXT NOT NULL,
  "productId" INTEGER,
  "productSymbol" TEXT,
  "transactionType" TEXT NOT NULL,
  "amount" DECIMAL(24,10) NOT NULL,
  "balanceAfter" DECIMAL(24,10),
  "metaJson" JSONB,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "ingestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DeltaLedgerEntry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "DeltaLedgerEntry_userId_deltaUuid_key"
  ON "DeltaLedgerEntry"("userId", "deltaUuid");

CREATE INDEX IF NOT EXISTS "DeltaLedgerEntry_userId_productId_occurredAt_idx"
  ON "DeltaLedgerEntry"("userId", "productId", "occurredAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'DeltaLedgerEntry_userId_fkey'
  ) THEN
    ALTER TABLE "DeltaLedgerEntry"
      ADD CONSTRAINT "DeltaLedgerEntry_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
