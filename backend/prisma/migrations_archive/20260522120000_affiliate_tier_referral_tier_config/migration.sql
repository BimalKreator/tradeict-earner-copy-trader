-- Rename legacy Director tier to Senior Manager (additive-safe enum rename)
ALTER TYPE "Role" RENAME VALUE 'DIRECTOR' TO 'SENIOR_MANAGER';
ALTER TYPE "SalesTier" RENAME VALUE 'DIRECTOR' TO 'SENIOR_MANAGER';

-- Referral nomination workflow (Phase 1 schema — approval logic in Phase 2)
CREATE TYPE "ReferralRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

CREATE TABLE "ReferralRequest" (
    "id" TEXT NOT NULL,
    "sponsorId" TEXT NOT NULL,
    "referredEmail" TEXT NOT NULL,
    "status" "ReferralRequestStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReferralRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ReferralRequest_sponsorId_idx" ON "ReferralRequest"("sponsorId");
CREATE INDEX "ReferralRequest_status_createdAt_idx" ON "ReferralRequest"("status", "createdAt");
CREATE INDEX "ReferralRequest_referredEmail_idx" ON "ReferralRequest"("referredEmail");

ALTER TABLE "ReferralRequest" ADD CONSTRAINT "ReferralRequest_sponsorId_fkey" FOREIGN KEY ("sponsorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Dynamic tier configuration (admin UI in Phase 3)
CREATE TABLE "TierConfig" (
    "id" TEXT NOT NULL,
    "tierLevel" "SalesTier" NOT NULL,
    "directCommissionRate" DOUBLE PRECISION NOT NULL,
    "teamCommissionRate" DOUBLE PRECISION NOT NULL,
    "networkCommissionRate" DOUBLE PRECISION NOT NULL,
    "minReferralsRequired" INTEGER NOT NULL DEFAULT 0,
    "benefits" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TierConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TierConfig_tierLevel_key" ON "TierConfig"("tierLevel");

-- Seed default tier rows (admin can override via Phase 3 UI)
INSERT INTO "TierConfig" (
    "id",
    "tierLevel",
    "directCommissionRate",
    "teamCommissionRate",
    "networkCommissionRate",
    "minReferralsRequired",
    "benefits",
    "createdAt",
    "updatedAt"
) VALUES
(
    gen_random_uuid()::text,
    'EXECUTIVE',
    5,
    2,
    1,
    0,
    '["Direct client commissions","Partner dashboard access","Referral tracking"]'::jsonb,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
),
(
    gen_random_uuid()::text,
    'MANAGER',
    5,
    2,
    1,
    10,
    '["Team override commissions","10 active direct referrals required","Manager milestone rewards"]'::jsonb,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
),
(
    gen_random_uuid()::text,
    'SENIOR_MANAGER',
    5,
    2,
    1,
    10,
    '["Network commission tier","Senior leadership incentives","Laptop & motorcycle rewards"]'::jsonb,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
);
