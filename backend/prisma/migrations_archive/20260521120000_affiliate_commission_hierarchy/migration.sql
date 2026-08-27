-- AlterEnum: extend Role for partner sales tiers (additive — existing ADMIN/USER unchanged)
ALTER TYPE "Role" ADD VALUE 'EXECUTIVE';
ALTER TYPE "Role" ADD VALUE 'MANAGER';
ALTER TYPE "Role" ADD VALUE 'DIRECTOR';

-- CreateEnum
CREATE TYPE "CommissionLedgerStatus" AS ENUM ('EARNED', 'PAYABLE', 'WITHDRAWABLE', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "SalesTier" AS ENUM ('EXECUTIVE', 'MANAGER', 'DIRECTOR');

-- AlterTable: sales hierarchy on User
ALTER TABLE "User" ADD COLUMN "parentId" TEXT;
ALTER TABLE "User" ADD COLUMN "acquiredById" TEXT;

-- CreateTable
CREATE TABLE "AffiliateProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "referralCode" TEXT NOT NULL,
    "directAcquiredCount" INTEGER NOT NULL DEFAULT 0,
    "networkAum" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "upgradedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "upgradedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AffiliateProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionLedger" (
    "id" TEXT NOT NULL,
    "profitDate" DATE NOT NULL,
    "sourceUserId" TEXT NOT NULL,
    "beneficiaryUserId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "appRevenueBase" DOUBLE PRECISION NOT NULL,
    "commissionRate" DOUBLE PRECISION NOT NULL,
    "beneficiaryTier" "SalesTier" NOT NULL,
    "status" "CommissionLedgerStatus" NOT NULL DEFAULT 'EARNED',
    "unlockDate" TIMESTAMP(3) NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "invoiceId" TEXT,
    "pnlRecordId" TEXT,
    "paymentTransactionId" TEXT,
    "earnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payableAt" TIMESTAMP(3),
    "withdrawableAt" TIMESTAMP(3),
    "withdrawnAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommissionLedger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AffiliateProfile_userId_key" ON "AffiliateProfile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AffiliateProfile_referralCode_key" ON "AffiliateProfile"("referralCode");

-- CreateIndex
CREATE INDEX "AffiliateProfile_upgradedById_idx" ON "AffiliateProfile"("upgradedById");

-- CreateIndex
CREATE UNIQUE INDEX "CommissionLedger_idempotencyKey_key" ON "CommissionLedger"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CommissionLedger_beneficiaryUserId_status_idx" ON "CommissionLedger"("beneficiaryUserId", "status");

-- CreateIndex
CREATE INDEX "CommissionLedger_sourceUserId_profitDate_idx" ON "CommissionLedger"("sourceUserId", "profitDate");

-- CreateIndex
CREATE INDEX "CommissionLedger_status_unlockDate_idx" ON "CommissionLedger"("status", "unlockDate");

-- CreateIndex
CREATE INDEX "CommissionLedger_invoiceId_idx" ON "CommissionLedger"("invoiceId");

-- CreateIndex
CREATE INDEX "CommissionLedger_profitDate_idx" ON "CommissionLedger"("profitDate");

-- CreateIndex
CREATE INDEX "User_parentId_idx" ON "User"("parentId");

-- CreateIndex
CREATE INDEX "User_acquiredById_idx" ON "User"("acquiredById");

-- CreateIndex
CREATE INDEX "User_role_idx" ON "User"("role");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_acquiredById_fkey" FOREIGN KEY ("acquiredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AffiliateProfile" ADD CONSTRAINT "AffiliateProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AffiliateProfile" ADD CONSTRAINT "AffiliateProfile_upgradedById_fkey" FOREIGN KEY ("upgradedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionLedger" ADD CONSTRAINT "CommissionLedger_sourceUserId_fkey" FOREIGN KEY ("sourceUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionLedger" ADD CONSTRAINT "CommissionLedger_beneficiaryUserId_fkey" FOREIGN KEY ("beneficiaryUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionLedger" ADD CONSTRAINT "CommissionLedger_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionLedger" ADD CONSTRAINT "CommissionLedger_pnlRecordId_fkey" FOREIGN KEY ("pnlRecordId") REFERENCES "PnLRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionLedger" ADD CONSTRAINT "CommissionLedger_paymentTransactionId_fkey" FOREIGN KEY ("paymentTransactionId") REFERENCES "PaymentTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
