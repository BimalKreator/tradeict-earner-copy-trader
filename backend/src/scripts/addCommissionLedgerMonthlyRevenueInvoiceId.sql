-- Link partner commission rows to MonthlyRevenueInvoice (delta pipeline billing).
ALTER TABLE "CommissionLedger"
  ADD COLUMN IF NOT EXISTS "monthlyRevenueInvoiceId" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CommissionLedger_monthlyRevenueInvoiceId_fkey'
  ) THEN
    ALTER TABLE "CommissionLedger"
      ADD CONSTRAINT "CommissionLedger_monthlyRevenueInvoiceId_fkey"
      FOREIGN KEY ("monthlyRevenueInvoiceId") REFERENCES "MonthlyRevenueInvoice"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "CommissionLedger_monthlyRevenueInvoiceId_idx"
  ON "CommissionLedger"("monthlyRevenueInvoiceId");
