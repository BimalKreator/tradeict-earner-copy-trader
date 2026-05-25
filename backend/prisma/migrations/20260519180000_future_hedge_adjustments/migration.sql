-- CreateEnum
CREATE TYPE "FutureHedgeBatchTrend" AS ENUM ('UPTREND', 'DOWNTREND');

-- AlterTable
ALTER TABLE "FutureHedgeConfig" ADD COLUMN IF NOT EXISTS "batchTrend" "FutureHedgeBatchTrend";
ALTER TABLE "FutureHedgeConfig" ADD COLUMN IF NOT EXISTS "batchOptionProductId" TEXT;
ALTER TABLE "FutureHedgeConfig" ADD COLUMN IF NOT EXISTS "batchOptionExpiryMs" BIGINT;

-- CreateTable
CREATE TABLE "FutureHedgeExecution" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "configId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "leg" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "lots" INTEGER NOT NULL,
    "price" FLOAT,
    "orderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FutureHedgeExecution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FutureHedgeExecution_batchId_createdAt_idx" ON "FutureHedgeExecution"("batchId", "createdAt");
CREATE INDEX "FutureHedgeExecution_configId_batchId_idx" ON "FutureHedgeExecution"("configId", "batchId");

-- AddForeignKey
ALTER TABLE "FutureHedgeExecution" ADD CONSTRAINT "FutureHedgeExecution_configId_fkey" FOREIGN KEY ("configId") REFERENCES "FutureHedgeConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;
