CREATE TABLE IF NOT EXISTS "DailyPnlSnapshot" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "snapshotDate" TIMESTAMP(3) NOT NULL,
  "realizedDelta" DECIMAL(24,10) NOT NULL,
  "cumulativeRealized" DECIMAL(24,10) NOT NULL,
  "highWaterMark" DECIMAL(24,10) NOT NULL,
  "commissionAccrued" DECIMAL(24,10) NOT NULL,
  "commissionCumulative" DECIMAL(24,10) NOT NULL,
  "openStructureCount" INTEGER NOT NULL,
  "computedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DailyPnlSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "DailyPnlSnapshot_userId_snapshotDate_key"
  ON "DailyPnlSnapshot"("userId", "snapshotDate");

CREATE TABLE IF NOT EXISTS "MonthlyRevenueInvoice" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "periodYear" INTEGER NOT NULL,
  "periodMonth" INTEGER NOT NULL,
  "structuresClosed" INTEGER NOT NULL,
  "realizedPnl" DECIMAL(24,10) NOT NULL,
  "hwmBefore" DECIMAL(24,10) NOT NULL,
  "hwmAfter" DECIMAL(24,10) NOT NULL,
  "billableProfit" DECIMAL(24,10) NOT NULL,
  "profitSharePct" DECIMAL(6,3) NOT NULL,
  "commissionAmount" DECIMAL(24,10) NOT NULL,
  "status" TEXT NOT NULL,
  "generatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MonthlyRevenueInvoice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "MonthlyRevenueInvoice_userId_periodYear_periodMonth_key"
  ON "MonthlyRevenueInvoice"("userId", "periodYear", "periodMonth");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'DailyPnlSnapshot_userId_fkey'
  ) THEN
    ALTER TABLE "DailyPnlSnapshot"
      ADD CONSTRAINT "DailyPnlSnapshot_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MonthlyRevenueInvoice_userId_fkey'
  ) THEN
    ALTER TABLE "MonthlyRevenueInvoice"
      ADD CONSTRAINT "MonthlyRevenueInvoice_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
