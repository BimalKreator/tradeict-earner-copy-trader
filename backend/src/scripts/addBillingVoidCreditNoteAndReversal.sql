-- Signed commission reversals, credit notes, and billing history protection.

ALTER TYPE "CommissionLedgerStatus" ADD VALUE IF NOT EXISTS 'REVERSED';

ALTER TABLE "CommissionLedger"
  ADD COLUMN IF NOT EXISTS "needsClawback" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "reversesLedgerId" TEXT;

ALTER TABLE "MonthlyRevenueInvoice"
  ADD COLUMN IF NOT EXISTS "creditNoteAmount" DECIMAL(24, 10),
  ADD COLUMN IF NOT EXISTS "creditNoteReason" TEXT;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'DeltaLedgerEntry_userId_fkey'
  ) THEN
    ALTER TABLE "DeltaLedgerEntry" DROP CONSTRAINT "DeltaLedgerEntry_userId_fkey";
  END IF;
  ALTER TABLE "DeltaLedgerEntry"
    ADD CONSTRAINT "DeltaLedgerEntry_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'StructurePnl_userId_fkey'
  ) THEN
    ALTER TABLE "StructurePnl" DROP CONSTRAINT "StructurePnl_userId_fkey";
  END IF;
  ALTER TABLE "StructurePnl"
    ADD CONSTRAINT "StructurePnl_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'DailyPnlSnapshot_userId_fkey'
  ) THEN
    ALTER TABLE "DailyPnlSnapshot" DROP CONSTRAINT "DailyPnlSnapshot_userId_fkey";
  END IF;
  ALTER TABLE "DailyPnlSnapshot"
    ADD CONSTRAINT "DailyPnlSnapshot_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MonthlyRevenueInvoice_userId_fkey'
  ) THEN
    ALTER TABLE "MonthlyRevenueInvoice" DROP CONSTRAINT "MonthlyRevenueInvoice_userId_fkey";
  END IF;
  ALTER TABLE "MonthlyRevenueInvoice"
    ADD CONSTRAINT "MonthlyRevenueInvoice_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CommissionLedger_sourceUserId_fkey'
  ) THEN
    ALTER TABLE "CommissionLedger" DROP CONSTRAINT "CommissionLedger_sourceUserId_fkey";
  END IF;
  ALTER TABLE "CommissionLedger"
    ADD CONSTRAINT "CommissionLedger_sourceUserId_fkey"
    FOREIGN KEY ("sourceUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CommissionLedger_beneficiaryUserId_fkey'
  ) THEN
    ALTER TABLE "CommissionLedger" DROP CONSTRAINT "CommissionLedger_beneficiaryUserId_fkey";
  END IF;
  ALTER TABLE "CommissionLedger"
    ADD CONSTRAINT "CommissionLedger_beneficiaryUserId_fkey"
    FOREIGN KEY ("beneficiaryUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
END $$;
