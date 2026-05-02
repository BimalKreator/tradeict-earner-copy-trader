-- AlterTable
ALTER TABLE "User" ADD COLUMN     "otpCode" TEXT,
ADD COLUMN     "otpExpiry" TIMESTAMP(3);
