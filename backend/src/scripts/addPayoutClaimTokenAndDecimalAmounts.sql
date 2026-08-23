-- Race-safe partner payouts: claim token + Decimal amounts + one PENDING per user.

ALTER TABLE "CommissionLedger"
  ADD COLUMN IF NOT EXISTS "payoutClaimToken" TEXT;

ALTER TABLE "PayoutRequest"
  ADD COLUMN IF NOT EXISTS "payoutClaimToken" TEXT;

-- Float → Decimal(24,10); cast preserves existing numeric values.
ALTER TABLE "CommissionLedger"
  ALTER COLUMN "amount" TYPE DECIMAL(24, 10)
  USING ("amount"::DOUBLE PRECISION)::DECIMAL(24, 10);

ALTER TABLE "PayoutRequest"
  ALTER COLUMN "amount" TYPE DECIMAL(24, 10)
  USING ("amount"::DOUBLE PRECISION)::DECIMAL(24, 10);

CREATE UNIQUE INDEX IF NOT EXISTS "PayoutRequest_payoutClaimToken_key"
  ON "PayoutRequest" ("payoutClaimToken")
  WHERE "payoutClaimToken" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "CommissionLedger_payoutClaimToken_idx"
  ON "CommissionLedger" ("payoutClaimToken");

-- At most one PENDING payout request per partner.
CREATE UNIQUE INDEX IF NOT EXISTS "PayoutRequest_userId_pending_unique"
  ON "PayoutRequest" ("userId")
  WHERE status = 'PENDING';
