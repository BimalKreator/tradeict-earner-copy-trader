-- CreateEnum
CREATE TYPE "PayoutRequestStatus" AS ENUM ('PENDING', 'COMPLETED');

-- CreateTable
CREATE TABLE "PayoutRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "status" "PayoutRequestStatus" NOT NULL DEFAULT 'PENDING',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "completedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayoutRequest_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "CommissionLedger" ADD COLUMN "payoutRequestId" TEXT;

-- CreateIndex
CREATE INDEX "PayoutRequest_userId_status_idx" ON "PayoutRequest"("userId", "status");

-- CreateIndex
CREATE INDEX "PayoutRequest_status_requestedAt_idx" ON "PayoutRequest"("status", "requestedAt");

-- CreateIndex
CREATE INDEX "CommissionLedger_payoutRequestId_idx" ON "CommissionLedger"("payoutRequestId");

-- AddForeignKey
ALTER TABLE "PayoutRequest" ADD CONSTRAINT "PayoutRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutRequest" ADD CONSTRAINT "PayoutRequest_completedById_fkey" FOREIGN KEY ("completedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionLedger" ADD CONSTRAINT "CommissionLedger_payoutRequestId_fkey" FOREIGN KEY ("payoutRequestId") REFERENCES "PayoutRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;
