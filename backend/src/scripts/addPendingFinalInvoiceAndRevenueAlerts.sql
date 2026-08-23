ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "pendingFinalInvoiceSince" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "pendingFinalInvoicePeriodYear" INTEGER,
  ADD COLUMN IF NOT EXISTS "pendingFinalInvoicePeriodMonth" INTEGER,
  ADD COLUMN IF NOT EXISTS "revenueFrozenPeriodAlerts" JSONB;
