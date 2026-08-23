-- Customer cost components beyond cashflow/commission (funding, settlement, liquidation).
ALTER TABLE "StructureLegPnl"
  ADD COLUMN IF NOT EXISTS "fundingTotal" DECIMAL(24, 10),
  ADD COLUMN IF NOT EXISTS "settlementTotal" DECIMAL(24, 10),
  ADD COLUMN IF NOT EXISTS "liquidationFeeTotal" DECIMAL(24, 10);
