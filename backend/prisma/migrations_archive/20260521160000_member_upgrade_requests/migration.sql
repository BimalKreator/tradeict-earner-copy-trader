-- CreateEnum
CREATE TYPE "NominatedSalesRole" AS ENUM ('MANAGER', 'EXECUTIVE');

-- CreateEnum
CREATE TYPE "MemberUpgradeRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "MemberUpgradeRequest" (
    "id" TEXT NOT NULL,
    "targetUserEmail" TEXT NOT NULL,
    "requestedRole" "NominatedSalesRole" NOT NULL,
    "requesterId" TEXT NOT NULL,
    "assignedParentId" TEXT NOT NULL,
    "status" "MemberUpgradeRequestStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemberUpgradeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MemberUpgradeRequest_status_idx" ON "MemberUpgradeRequest"("status");

-- CreateIndex
CREATE INDEX "MemberUpgradeRequest_requesterId_idx" ON "MemberUpgradeRequest"("requesterId");

-- CreateIndex
CREATE INDEX "MemberUpgradeRequest_targetUserEmail_idx" ON "MemberUpgradeRequest"("targetUserEmail");

-- AddForeignKey
ALTER TABLE "MemberUpgradeRequest" ADD CONSTRAINT "MemberUpgradeRequest_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberUpgradeRequest" ADD CONSTRAINT "MemberUpgradeRequest_assignedParentId_fkey" FOREIGN KEY ("assignedParentId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
