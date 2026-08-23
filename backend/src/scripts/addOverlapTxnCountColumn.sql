-- Track ambiguous leg-attribution overlaps per invoice period.
ALTER TABLE "MonthlyRevenueInvoice"
  ADD COLUMN IF NOT EXISTS "overlapTxnCount" INTEGER;
