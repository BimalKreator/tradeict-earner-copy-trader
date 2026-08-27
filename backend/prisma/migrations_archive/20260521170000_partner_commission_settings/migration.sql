-- Partner commission % of app revenue — admin-configurable via SystemSettings
ALTER TABLE "SystemSettings" ADD COLUMN "partnerMaxCommissionPct" DOUBLE PRECISION NOT NULL DEFAULT 8;
ALTER TABLE "SystemSettings" ADD COLUMN "partnerExecutiveDirectPct" DOUBLE PRECISION NOT NULL DEFAULT 5;
ALTER TABLE "SystemSettings" ADD COLUMN "partnerManagerUnderExecPct" DOUBLE PRECISION NOT NULL DEFAULT 2;
ALTER TABLE "SystemSettings" ADD COLUMN "partnerDirectorUnderExecPct" DOUBLE PRECISION NOT NULL DEFAULT 1;
ALTER TABLE "SystemSettings" ADD COLUMN "partnerManagerDirectPct" DOUBLE PRECISION NOT NULL DEFAULT 6;
ALTER TABLE "SystemSettings" ADD COLUMN "partnerDirectorUnderMgrPct" DOUBLE PRECISION NOT NULL DEFAULT 2;
ALTER TABLE "SystemSettings" ADD COLUMN "partnerDirectorDirectPct" DOUBLE PRECISION NOT NULL DEFAULT 8;
