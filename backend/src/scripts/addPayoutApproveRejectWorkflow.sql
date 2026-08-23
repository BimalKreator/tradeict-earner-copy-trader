-- Partner payout approve/reject workflow + audit columns.

ALTER TYPE "PayoutRequestStatus" ADD VALUE IF NOT EXISTS 'APPROVED';
ALTER TYPE "PayoutRequestStatus" ADD VALUE IF NOT EXISTS 'REJECTED';

ALTER TABLE "PayoutRequest"
  ADD COLUMN IF NOT EXISTS "approvedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "approvedById" TEXT,
  ADD COLUMN IF NOT EXISTS "approvalReason" TEXT,
  ADD COLUMN IF NOT EXISTS "rejectedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "rejectedById" TEXT,
  ADD COLUMN IF NOT EXISTS "rejectionReason" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'PayoutRequest_approvedById_fkey'
  ) THEN
    ALTER TABLE "PayoutRequest"
      ADD CONSTRAINT "PayoutRequest_approvedById_fkey"
      FOREIGN KEY ("approvedById") REFERENCES "User"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'PayoutRequest_rejectedById_fkey'
  ) THEN
    ALTER TABLE "PayoutRequest"
      ADD CONSTRAINT "PayoutRequest_rejectedById_fkey"
      FOREIGN KEY ("rejectedById") REFERENCES "User"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "PayoutRequest_approvedById_idx"
  ON "PayoutRequest" ("approvedById");

CREATE INDEX IF NOT EXISTS "PayoutRequest_rejectedById_idx"
  ON "PayoutRequest" ("rejectedById");
