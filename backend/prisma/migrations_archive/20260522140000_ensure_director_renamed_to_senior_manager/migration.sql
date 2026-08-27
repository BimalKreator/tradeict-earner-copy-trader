-- Idempotent safety net when 20260522120000 was skipped or partially applied on production.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'Role' AND e.enumlabel = 'DIRECTOR'
  ) THEN
    ALTER TYPE "Role" RENAME VALUE 'DIRECTOR' TO 'SENIOR_MANAGER';
  END IF;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'SalesTier' AND e.enumlabel = 'DIRECTOR'
  ) THEN
    ALTER TYPE "SalesTier" RENAME VALUE 'DIRECTOR' TO 'SENIOR_MANAGER';
  END IF;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
