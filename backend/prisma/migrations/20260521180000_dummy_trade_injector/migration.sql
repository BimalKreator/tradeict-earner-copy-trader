-- Admin trade injector — flag test trades and PnL rows
ALTER TABLE "Trade" ADD COLUMN "isDummy" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PnLRecord" ADD COLUMN "isDummy" BOOLEAN NOT NULL DEFAULT false;
