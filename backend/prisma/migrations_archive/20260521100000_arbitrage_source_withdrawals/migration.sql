-- AlterTable
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "arbitrageSourceUserId" TEXT;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'User_arbitrageSourceUserId_fkey'
  ) THEN
    ALTER TABLE "User"
      ADD CONSTRAINT "User_arbitrageSourceUserId_fkey"
      FOREIGN KEY ("arbitrageSourceUserId") REFERENCES "User"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "ArbitrageWithdrawal" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArbitrageWithdrawal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ArbitrageWithdrawal_userId_date_idx" ON "ArbitrageWithdrawal"("userId", "date");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ArbitrageWithdrawal_userId_fkey'
  ) THEN
    ALTER TABLE "ArbitrageWithdrawal"
      ADD CONSTRAINT "ArbitrageWithdrawal_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
