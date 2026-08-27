-- CreateEnum
CREATE TYPE "InvoiceKind" AS ENUM ('REVENUE_SHARE', 'STRATEGY_FEE');

-- AlterTable
ALTER TABLE "UserSubscription" ADD COLUMN "isStrategyFeePaid" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "UserSubscription" ADD COLUMN "strategyFeeCycleEndsAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN "kind" "InvoiceKind" NOT NULL DEFAULT 'REVENUE_SHARE';

-- DropIndex
DROP INDEX "Invoice_userId_strategyId_month_year_key";

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_userId_strategyId_month_year_kind_key" ON "Invoice"("userId", "strategyId", "month", "year", "kind");

-- CreateIndex
CREATE INDEX "Invoice_kind_idx" ON "Invoice"("kind");
