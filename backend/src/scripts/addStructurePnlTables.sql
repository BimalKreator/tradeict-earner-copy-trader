CREATE TABLE IF NOT EXISTS "StructurePnl" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "botStructureId" INTEGER NOT NULL,
  "hedgePositionId" INTEGER NOT NULL,
  "underlying" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "openedAt" TIMESTAMP(3) NOT NULL,
  "closedAt" TIMESTAMP(3),
  "closeReason" TEXT,
  "grossCashflow" DECIMAL(24,10) NOT NULL,
  "commissionTotal" DECIMAL(24,10) NOT NULL,
  "realizedPnl" DECIMAL(24,10),
  "legCount" INTEGER NOT NULL,
  "closedLegCount" INTEGER NOT NULL,
  "matchedTxnCount" INTEGER NOT NULL,
  "computedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StructurePnl_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "StructurePnl_userId_botStructureId_key"
  ON "StructurePnl"("userId", "botStructureId");

CREATE TABLE IF NOT EXISTS "StructureLegPnl" (
  "id" TEXT NOT NULL,
  "structurePnlId" TEXT NOT NULL,
  "botLegId" INTEGER NOT NULL,
  "legRole" TEXT NOT NULL,
  "basketSeq" INTEGER,
  "adjSeq" INTEGER,
  "productId" INTEGER NOT NULL,
  "symbol" TEXT,
  "strike" DOUBLE PRECISION,
  "side" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL,
  "openedAt" TIMESTAMP(3) NOT NULL,
  "closedAt" TIMESTAMP(3),
  "grossCashflow" DECIMAL(24,10) NOT NULL,
  "commissionTotal" DECIMAL(24,10) NOT NULL,
  "realizedPnl" DECIMAL(24,10),
  "matchedTxnCount" INTEGER NOT NULL,
  CONSTRAINT "StructureLegPnl_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "StructureLegPnl_structurePnlId_botLegId_key"
  ON "StructureLegPnl"("structurePnlId", "botLegId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'StructurePnl_userId_fkey'
  ) THEN
    ALTER TABLE "StructurePnl"
      ADD CONSTRAINT "StructurePnl_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'StructureLegPnl_structurePnlId_fkey'
  ) THEN
    ALTER TABLE "StructureLegPnl"
      ADD CONSTRAINT "StructureLegPnl_structurePnlId_fkey"
      FOREIGN KEY ("structurePnlId") REFERENCES "StructurePnl"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
