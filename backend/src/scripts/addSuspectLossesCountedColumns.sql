-- Asymmetric suspect handling: track suspect losses counted into HWM/cumulative
ALTER TABLE "MonthlyRevenueInvoice"
  ADD COLUMN IF NOT EXISTS "suspectLossesCountedCount" INTEGER,
  ADD COLUMN IF NOT EXISTS "suspectLossesCountedAmount" DECIMAL(24, 10);
