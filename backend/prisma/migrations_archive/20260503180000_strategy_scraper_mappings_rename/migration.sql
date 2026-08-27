-- Align DB column with Strategy.scraperMappings (rename legacy column if present).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'Strategy'
      AND column_name = 'scraperStudioSelectors'
  ) THEN
    ALTER TABLE "Strategy" RENAME COLUMN "scraperStudioSelectors" TO "scraperMappings";
  ELSIF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'Strategy'
      AND column_name = 'scraperMappings'
  ) THEN
    ALTER TABLE "Strategy" ADD COLUMN "scraperMappings" JSONB;
  END IF;
END $$;
