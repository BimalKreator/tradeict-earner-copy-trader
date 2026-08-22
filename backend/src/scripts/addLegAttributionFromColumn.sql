-- Per-leg attribution window override (mirrors bot attribution_from)
ALTER TABLE "StructureLegPnl"
  ADD COLUMN IF NOT EXISTS "attributionFrom" TIMESTAMP(3);
