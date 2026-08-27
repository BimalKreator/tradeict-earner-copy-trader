-- AlterTable
ALTER TABLE "FutureHedgeConfig" ADD COLUMN "isBreakevenExitEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "FutureHedgeConfig" ADD COLUMN "breakevenPrice1" DOUBLE PRECISION;
ALTER TABLE "FutureHedgeConfig" ADD COLUMN "breakevenPrice2" DOUBLE PRECISION;
