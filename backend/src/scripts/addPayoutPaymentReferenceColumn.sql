-- Payment reference (UTR / bank txn id) required when completing partner payouts.
ALTER TABLE "PayoutRequest"
  ADD COLUMN IF NOT EXISTS "paymentReference" TEXT;
