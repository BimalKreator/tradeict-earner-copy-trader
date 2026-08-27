-- CreateTable
CREATE TABLE "FutureHedgeConfig" (
    "id" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "isAutoEnabled" BOOLEAN NOT NULL DEFAULT false,
    "baseLots" INTEGER NOT NULL DEFAULT 1,
    "emaPeriod" INTEGER NOT NULL DEFAULT 200,
    "adjustmentPct" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "targetProfitUsd" DOUBLE PRECISION NOT NULL DEFAULT 10.0,
    "currentBatchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FutureHedgeConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FutureHedgeConfig_strategyId_key" ON "FutureHedgeConfig"("strategyId");

-- AddForeignKey
ALTER TABLE "FutureHedgeConfig" ADD CONSTRAINT "FutureHedgeConfig_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
