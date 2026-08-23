-- Ledger amount conflicts (Delta corrected a row) and late-row recompute flag.
ALTER TABLE "DeltaLedgerEntry"
  ADD COLUMN IF NOT EXISTS "conflictAmount" DECIMAL(24, 10),
  ADD COLUMN IF NOT EXISTS "conflictSeenAt" TIMESTAMP(3);

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "deltaLedgerRecomputeRequired" BOOLEAN NOT NULL DEFAULT false;
