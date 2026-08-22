-- Lifetime cumulative P&L audit column on monthly revenue invoices
ALTER TABLE "MonthlyRevenueInvoice"
  ADD COLUMN IF NOT EXISTS "cumulativeRealizedPnl" DECIMAL(24, 10);
