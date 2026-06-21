-- KYC / personal profile fields on User; rename aadhaarNumber -> aadharNumber

ALTER TABLE "User" RENAME COLUMN "aadhaarNumber" TO "aadharNumber";

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "dob" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "guardianName" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "gender" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "city" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "state" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "pinCode" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "bankName" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "bankAccountNumber" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "bankIfsc" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "upiId" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "nomineeName" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "nomineeRelationship" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "nomineeMobile" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "User_aadharNumber_key" ON "User"("aadharNumber");
CREATE UNIQUE INDEX IF NOT EXISTS "User_panNumber_key" ON "User"("panNumber");

ALTER TABLE "ProfileUpdateRequest" RENAME COLUMN "aadhaarNumber" TO "aadharNumber";
