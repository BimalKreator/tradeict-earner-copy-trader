-- Simulation mode columns (isolated test data for Delta revenue pipeline)
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "allowSimulation" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "DeltaLedgerEntry" ADD COLUMN IF NOT EXISTS "isSimulated" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS "DeltaLedgerEntry_isSimulated_idx" ON "DeltaLedgerEntry"("isSimulated");

ALTER TABLE "StructurePnl" ADD COLUMN IF NOT EXISTS "isSimulated" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS "StructurePnl_isSimulated_idx" ON "StructurePnl"("isSimulated");

ALTER TABLE "StructureLegPnl" ADD COLUMN IF NOT EXISTS "isSimulated" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "DailyPnlSnapshot" ADD COLUMN IF NOT EXISTS "isSimulated" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS "DailyPnlSnapshot_isSimulated_idx" ON "DailyPnlSnapshot"("isSimulated");

ALTER TABLE "MonthlyRevenueInvoice" ADD COLUMN IF NOT EXISTS "isSimulated" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS "MonthlyRevenueInvoice_isSimulated_idx" ON "MonthlyRevenueInvoice"("isSimulated");

ALTER TABLE "CommissionLedger" ADD COLUMN IF NOT EXISTS "isSimulated" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS "CommissionLedger_isSimulated_idx" ON "CommissionLedger"("isSimulated");

ALTER TABLE "PnLRecord" ADD COLUMN IF NOT EXISTS "isSimulated" BOOLEAN NOT NULL DEFAULT false;
