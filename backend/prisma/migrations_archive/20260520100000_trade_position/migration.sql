-- CreateEnum
CREATE TYPE "TradePositionStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateTable
CREATE TABLE "TradePosition" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "isMaster" BOOLEAN NOT NULL DEFAULT false,
    "strategyId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "entryPrice" DOUBLE PRECISION NOT NULL,
    "clientOrderId" TEXT NOT NULL,
    "status" "TradePositionStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TradePosition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TradePosition_clientOrderId_key" ON "TradePosition"("clientOrderId");

-- CreateIndex
CREATE INDEX "TradePosition_strategyId_status_idx" ON "TradePosition"("strategyId", "status");

-- CreateIndex
CREATE INDEX "TradePosition_userId_strategyId_status_idx" ON "TradePosition"("userId", "strategyId", "status");

-- CreateIndex
CREATE INDEX "TradePosition_isMaster_strategyId_status_symbol_side_idx" ON "TradePosition"("isMaster", "strategyId", "status", "symbol", "side");

-- AddForeignKey
ALTER TABLE "TradePosition" ADD CONSTRAINT "TradePosition_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradePosition" ADD CONSTRAINT "TradePosition_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
