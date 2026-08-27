-- Strategy reference capital for multiplier = deployedCapital / baseCapital
ALTER TABLE "Strategy" ADD COLUMN IF NOT EXISTS "baseCapital" DOUBLE PRECISION NOT NULL DEFAULT 10;

UPDATE "Strategy"
SET "baseCapital" = GREATEST("minCapital", 10)
WHERE "baseCapital" IS NULL OR "baseCapital" <= 0;
