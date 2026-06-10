-- CreateEnum
CREATE TYPE "AffiliateProfileStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- AlterTable
ALTER TABLE "AffiliateProfile" ADD COLUMN "status" "AffiliateProfileStatus" NOT NULL DEFAULT 'ACTIVE';
