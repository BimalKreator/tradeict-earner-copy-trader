-- Wallet withdrawal requests and locked balance

CREATE TYPE "WalletWithdrawalStatus" AS ENUM ('PENDING', 'COMPLETED', 'REJECTED');

ALTER TYPE "TransactionType" ADD VALUE 'WITHDRAWAL_REQUEST';
ALTER TYPE "TransactionType" ADD VALUE 'ADMIN_ADJUSTMENT';

ALTER TYPE "TransactionStatus" ADD VALUE 'COMPLETED';

ALTER TABLE "Wallet" ADD COLUMN "lockedBalance" DOUBLE PRECISION NOT NULL DEFAULT 0;

ALTER TABLE "Transaction" ADD COLUMN "note" TEXT;

CREATE TABLE "WalletWithdrawalRequest" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "status" "WalletWithdrawalStatus" NOT NULL DEFAULT 'PENDING',
    "bankName" TEXT,
    "bankAccountNumber" TEXT,
    "bankIfsc" TEXT,
    "transactionId" TEXT,
    "adminRemarks" TEXT,
    "ledgerTransactionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WalletWithdrawalRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WalletWithdrawalRequest_ledgerTransactionId_key" ON "WalletWithdrawalRequest"("ledgerTransactionId");

CREATE INDEX "WalletWithdrawalRequest_status_createdAt_idx" ON "WalletWithdrawalRequest"("status", "createdAt");

CREATE INDEX "WalletWithdrawalRequest_userId_status_idx" ON "WalletWithdrawalRequest"("userId", "status");

ALTER TABLE "WalletWithdrawalRequest" ADD CONSTRAINT "WalletWithdrawalRequest_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "WalletWithdrawalRequest" ADD CONSTRAINT "WalletWithdrawalRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "WalletWithdrawalRequest" ADD CONSTRAINT "WalletWithdrawalRequest_ledgerTransactionId_fkey" FOREIGN KEY ("ledgerTransactionId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
