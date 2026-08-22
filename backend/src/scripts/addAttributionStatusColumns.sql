-- Block billing on structures with incomplete leg attribution
ALTER TABLE "StructurePnl"
  ADD COLUMN IF NOT EXISTS "attributionStatus" TEXT,
  ADD COLUMN IF NOT EXISTS "attributionNote" TEXT;

CREATE INDEX IF NOT EXISTS "StructurePnl_attributionStatus_idx"
  ON "StructurePnl"("attributionStatus");

ALTER TABLE "MonthlyRevenueInvoice"
  ADD COLUMN IF NOT EXISTS "suspectStructuresCount" INTEGER;
