-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'USER', 'EXECUTIVE', 'MANAGER', 'SENIOR_MANAGER');

-- CreateEnum
CREATE TYPE "AdminRole" AS ENUM ('SUPER_ADMIN', 'MANAGER', 'SUPPORT');

-- CreateEnum
CREATE TYPE "CommissionLedgerStatus" AS ENUM ('EARNED', 'PAYABLE', 'WITHDRAWABLE', 'WITHDRAWN', 'REVERSED');

-- CreateEnum
CREATE TYPE "SalesTier" AS ENUM ('EXECUTIVE', 'MANAGER', 'SENIOR_MANAGER');

-- CreateEnum
CREATE TYPE "ReferralRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "PayoutRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'COMPLETED', 'REJECTED');

-- CreateEnum
CREATE TYPE "AffiliateProfileStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "NominatedSalesRole" AS ENUM ('MANAGER', 'EXECUTIVE');

-- CreateEnum
CREATE TYPE "MemberUpgradeRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'PAUSED_DUE_TO_FUNDS', 'PAUSED_BY_USER', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TradeStatus" AS ENUM ('OPEN', 'CLOSED', 'FAILED');

-- CreateEnum
CREATE TYPE "TradePositionStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('PAYMENT', 'FEE', 'WITHDRAWAL_REQUEST', 'ADMIN_ADJUSTMENT');

-- CreateEnum
CREATE TYPE "WalletWithdrawalStatus" AS ENUM ('PENDING', 'COMPLETED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ProfileUpdateStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('PENDING', 'PAID', 'OVERDUE');

-- CreateEnum
CREATE TYPE "InvoiceKind" AS ENUM ('REVENUE_SHARE', 'STRATEGY_FEE');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "FutureHedgeBatchTrend" AS ENUM ('UPTREND', 'DOWNTREND');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "name" TEXT,
    "mobile" TEXT,
    "dob" TIMESTAMP(3),
    "guardianName" TEXT,
    "gender" TEXT,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "pinCode" TEXT,
    "aadharNumber" TEXT,
    "panNumber" TEXT,
    "bankName" TEXT,
    "bankAccountNumber" TEXT,
    "bankIfsc" TEXT,
    "upiId" TEXT,
    "nomineeName" TEXT,
    "nomineeRelationship" TEXT,
    "nomineeMobile" TEXT,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "adminRole" "AdminRole",
    "parentId" TEXT,
    "acquiredById" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "copyTradingPaused" BOOLEAN NOT NULL DEFAULT false,
    "cryptoArbitrageEnabled" BOOLEAN NOT NULL DEFAULT false,
    "cryptoBalance" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "cryptoCapitalPerTradePercent" DOUBLE PRECISION NOT NULL DEFAULT 10.0,
    "arbitrageSourceUserId" TEXT,
    "deltaBalanceDisplayOffset" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "isOtpBypassed" BOOLEAN NOT NULL DEFAULT false,
    "allowSimulation" BOOLEAN NOT NULL DEFAULT false,
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "loginOtpHash" TEXT,
    "loginOtpExpiry" TIMESTAMP(3),
    "loginOtpAttempts" INTEGER NOT NULL DEFAULT 0,
    "resetOtpHash" TEXT,
    "resetOtpExpiry" TIMESTAMP(3),
    "resetOtpAttempts" INTEGER NOT NULL DEFAULT 0,
    "telegramChatId" TEXT,
    "telegramLinkToken" TEXT,
    "telegramLinkExpires" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deltaLedgerSyncedUpTo" TIMESTAMP(3),
    "deltaLedgerRecomputeRequired" BOOLEAN NOT NULL DEFAULT false,
    "pendingFinalInvoiceSince" TIMESTAMP(3),
    "pendingFinalInvoicePeriodYear" INTEGER,
    "pendingFinalInvoicePeriodMonth" INTEGER,
    "revenueFrozenPeriodAlerts" JSONB,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OtpRecord" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "otp" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OtpRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserActivity" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Strategy" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "masterApiKey" TEXT NOT NULL DEFAULT '',
    "masterApiSecret" TEXT NOT NULL DEFAULT '',
    "performanceMetrics" JSONB,
    "slippage" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "monthlyFee" DOUBLE PRECISION NOT NULL,
    "profitShare" DOUBLE PRECISION NOT NULL DEFAULT 20.0,
    "minCapital" DOUBLE PRECISION NOT NULL,
    "baseCapital" DOUBLE PRECISION NOT NULL DEFAULT 10,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "syncActiveTrades" BOOLEAN NOT NULL DEFAULT false,
    "botUrl" TEXT,
    "botStrategyType" TEXT,
    "autoExitTarget" DOUBLE PRECISION,
    "autoExitStopLoss" DOUBLE PRECISION,
    "autoExitEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Strategy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FutureHedgeConfig" (
    "id" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "isAutoEnabled" BOOLEAN NOT NULL DEFAULT false,
    "baseLots" INTEGER NOT NULL DEFAULT 1,
    "emaPeriod" INTEGER NOT NULL DEFAULT 200,
    "adjustmentPct" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "targetProfitUsd" DOUBLE PRECISION NOT NULL DEFAULT 10.0,
    "isBreakevenExitEnabled" BOOLEAN NOT NULL DEFAULT false,
    "breakevenPrice1" DOUBLE PRECISION,
    "breakevenPrice2" DOUBLE PRECISION,
    "currentBatchId" TEXT,
    "lastEntryPrice" DOUBLE PRECISION,
    "batchTrend" "FutureHedgeBatchTrend",
    "batchOptionProductId" TEXT,
    "batchOptionExpiryMs" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FutureHedgeConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FutureHedgeExecution" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "configId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "leg" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "lots" INTEGER NOT NULL,
    "price" DOUBLE PRECISION,
    "orderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FutureHedgeExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserSubscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "exchangeAccountId" TEXT,
    "multiplier" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "syncStatus" TEXT NOT NULL DEFAULT 'SYNCED',
    "syncError" TEXT,
    "isStrategyFeePaid" BOOLEAN NOT NULL DEFAULT false,
    "strategyFeeCycleEndsAt" TIMESTAMP(3),
    "botSlaveId" TEXT,
    "profitShareOverride" DECIMAL(6,3),
    "profitSharePctSnapshot" DECIMAL(6,3),
    "joinedDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExchangeAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "nickname" TEXT NOT NULL,
    "exchange" TEXT NOT NULL DEFAULT 'Delta',
    "apiKey" TEXT NOT NULL,
    "apiSecret" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deltaLedgerSyncedUpTo" TIMESTAMP(3),

    CONSTRAINT "ExchangeAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeltaLedgerEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "exchangeAccountId" TEXT,
    "deltaUuid" TEXT NOT NULL,
    "productId" INTEGER,
    "productSymbol" TEXT,
    "transactionType" TEXT NOT NULL,
    "amount" DECIMAL(24,10) NOT NULL,
    "balanceAfter" DECIMAL(24,10),
    "metaJson" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "ingestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "conflictAmount" DECIMAL(24,10),
    "conflictSeenAt" TIMESTAMP(3),
    "isSimulated" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "DeltaLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StructurePnl" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "botStructureId" INTEGER NOT NULL,
    "hedgePositionId" INTEGER NOT NULL,
    "underlying" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "closeReason" TEXT,
    "grossCashflow" DECIMAL(24,10) NOT NULL,
    "commissionTotal" DECIMAL(24,10) NOT NULL,
    "realizedPnl" DECIMAL(24,10),
    "legCount" INTEGER NOT NULL,
    "closedLegCount" INTEGER NOT NULL,
    "matchedTxnCount" INTEGER NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL,
    "attributionStatus" TEXT,
    "attributionNote" TEXT,
    "attributionDroppedAmount" DECIMAL(24,10),
    "isSimulated" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "StructurePnl_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StructureLegPnl" (
    "id" TEXT NOT NULL,
    "structurePnlId" TEXT NOT NULL,
    "botLegId" INTEGER NOT NULL,
    "legRole" TEXT NOT NULL,
    "basketSeq" INTEGER,
    "adjSeq" INTEGER,
    "productId" INTEGER NOT NULL,
    "symbol" TEXT,
    "strike" DOUBLE PRECISION,
    "side" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL,
    "attributionFrom" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "grossCashflow" DECIMAL(24,10) NOT NULL,
    "commissionTotal" DECIMAL(24,10) NOT NULL,
    "fundingTotal" DECIMAL(24,10),
    "settlementTotal" DECIMAL(24,10),
    "liquidationFeeTotal" DECIMAL(24,10),
    "realizedPnl" DECIMAL(24,10),
    "matchedTxnCount" INTEGER NOT NULL,
    "isSimulated" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "StructureLegPnl_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyPnlSnapshot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "snapshotDate" TIMESTAMP(3) NOT NULL,
    "realizedDelta" DECIMAL(24,10) NOT NULL,
    "cumulativeRealized" DECIMAL(24,10) NOT NULL,
    "highWaterMark" DECIMAL(24,10) NOT NULL,
    "commissionAccrued" DECIMAL(24,10) NOT NULL,
    "commissionCumulative" DECIMAL(24,10) NOT NULL,
    "openStructureCount" INTEGER NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL,
    "isSimulated" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "DailyPnlSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonthlyRevenueInvoice" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "periodYear" INTEGER NOT NULL,
    "periodMonth" INTEGER NOT NULL,
    "structuresClosed" INTEGER NOT NULL,
    "suspectStructuresCount" INTEGER,
    "suspectLossesCountedCount" INTEGER,
    "suspectLossesCountedAmount" DECIMAL(24,10),
    "overlapTxnCount" INTEGER,
    "realizedPnl" DECIMAL(24,10) NOT NULL,
    "cumulativeRealizedPnl" DECIMAL(24,10),
    "hwmBefore" DECIMAL(24,10) NOT NULL,
    "hwmAfter" DECIMAL(24,10) NOT NULL,
    "billableProfit" DECIMAL(24,10) NOT NULL,
    "profitSharePct" DECIMAL(6,3) NOT NULL,
    "commissionAmount" DECIMAL(24,10) NOT NULL,
    "status" TEXT NOT NULL,
    "invoicedAt" TIMESTAMP(3),
    "dueDate" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "amountInr" DECIMAL(24,10),
    "usdInrRate" DECIMAL(24,10),
    "paymentReference" TEXT,
    "creditNoteAmount" DECIMAL(24,10),
    "creditNoteReason" TEXT,
    "isFinal" BOOLEAN NOT NULL DEFAULT false,
    "isSimulated" BOOLEAN NOT NULL DEFAULT false,
    "generatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MonthlyRevenueInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Trade" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "size" DOUBLE PRECISION NOT NULL,
    "entryPrice" DOUBLE PRECISION NOT NULL,
    "exitPrice" DOUBLE PRECISION,
    "pnl" DOUBLE PRECISION,
    "tradePnl" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "tradingFee" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "revenueShareAmt" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" "TradeStatus" NOT NULL DEFAULT 'OPEN',
    "exitReason" TEXT,
    "clientOrderId" TEXT,
    "isDummy" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Trade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradePosition" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "isMaster" BOOLEAN NOT NULL DEFAULT false,
    "strategyId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "entryPrice" DOUBLE PRECISION NOT NULL,
    "clientOrderId" TEXT NOT NULL,
    "status" "TradePositionStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TradePosition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Wallet" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "balance" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "lockedBalance" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "pendingFees" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "overdueDays" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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

-- CreateTable
CREATE TABLE "WalletTransaction" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "type" "TransactionType" NOT NULL DEFAULT 'PAYMENT',
    "utrNumber" TEXT,
    "note" TEXT,
    "status" "TransactionStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProfileUpdateRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "address" TEXT,
    "panNumber" TEXT,
    "aadharNumber" TEXT,
    "status" "ProfileUpdateStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),

    CONSTRAINT "ProfileUpdateRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemSettings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "pgFeePercent" DOUBLE PRECISION NOT NULL DEFAULT 2.36,
    "allowedEmailDomains" TEXT NOT NULL DEFAULT 'gmail.com,yahoo.com,hotmail.com,outlook.com',
    "usdInrRate" DOUBLE PRECISION,
    "usdInrRateUpdatedAt" TIMESTAMP(3),
    "maintenanceMode" BOOLEAN NOT NULL DEFAULT false,
    "maintenanceMessage" TEXT,
    "partnerMaxCommissionPct" DOUBLE PRECISION NOT NULL DEFAULT 8,
    "partnerExecutiveDirectPct" DOUBLE PRECISION NOT NULL DEFAULT 5,
    "partnerManagerUnderExecPct" DOUBLE PRECISION NOT NULL DEFAULT 2,
    "partnerDirectorUnderExecPct" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "partnerManagerDirectPct" DOUBLE PRECISION NOT NULL DEFAULT 6,
    "partnerDirectorUnderMgrPct" DOUBLE PRECISION NOT NULL DEFAULT 2,
    "partnerDirectorDirectPct" DOUBLE PRECISION NOT NULL DEFAULT 8,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentTransaction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "baseAmountInr" DOUBLE PRECISION NOT NULL,
    "feeAmountInr" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalAmountInr" DOUBLE PRECISION NOT NULL,
    "netCreditUsd" DOUBLE PRECISION NOT NULL,
    "referenceId" TEXT,
    "razorpayOrderId" TEXT,
    "razorpayPaymentId" TEXT,
    "depositRequestId" TEXT,
    "status" "TransactionStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DepositRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'UPI',
    "baseAmountInr" DOUBLE PRECISION,
    "feeAmountInr" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "netCreditUsd" DOUBLE PRECISION,
    "transactionId" TEXT NOT NULL,
    "screenshotUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "adminReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DepositRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DownloadFile" (
    "id" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'READY',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DownloadFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeltaApiKey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "nickname" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "apiSecret" TEXT NOT NULL,

    CONSTRAINT "DeltaApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "totalPnl" DOUBLE PRECISION NOT NULL,
    "amountDue" DOUBLE PRECISION NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'PENDING',
    "kind" "InvoiceKind" NOT NULL DEFAULT 'REVENUE_SHARE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PnLRecord" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "profitAmount" DOUBLE PRECISION NOT NULL,
    "commissionAmount" DOUBLE PRECISION NOT NULL,
    "isDummy" BOOLEAN NOT NULL DEFAULT false,
    "isSimulated" BOOLEAN NOT NULL DEFAULT false,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PnLRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TierConfig" (
    "id" TEXT NOT NULL,
    "tierLevel" "SalesTier" NOT NULL,
    "directCommissionRate" DOUBLE PRECISION NOT NULL,
    "teamCommissionRate" DOUBLE PRECISION NOT NULL,
    "networkCommissionRate" DOUBLE PRECISION NOT NULL,
    "minReferralsRequired" INTEGER NOT NULL DEFAULT 0,
    "benefits" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TierConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferralRequest" (
    "id" TEXT NOT NULL,
    "sponsorId" TEXT NOT NULL,
    "referredEmail" TEXT NOT NULL,
    "status" "ReferralRequestStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReferralRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AffiliateProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "referralCode" TEXT NOT NULL,
    "directAcquiredCount" INTEGER NOT NULL DEFAULT 0,
    "networkAum" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" "AffiliateProfileStatus" NOT NULL DEFAULT 'ACTIVE',
    "upgradedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "upgradedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AffiliateProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberUpgradeRequest" (
    "id" TEXT NOT NULL,
    "targetUserEmail" TEXT NOT NULL,
    "requestedRole" "NominatedSalesRole" NOT NULL,
    "requesterId" TEXT NOT NULL,
    "assignedParentId" TEXT NOT NULL,
    "status" "MemberUpgradeRequestStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemberUpgradeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionLedger" (
    "id" TEXT NOT NULL,
    "profitDate" DATE NOT NULL,
    "sourceUserId" TEXT NOT NULL,
    "beneficiaryUserId" TEXT NOT NULL,
    "amount" DECIMAL(24,10) NOT NULL,
    "appRevenueBase" DOUBLE PRECISION NOT NULL,
    "commissionRate" DOUBLE PRECISION NOT NULL,
    "beneficiaryTier" "SalesTier" NOT NULL,
    "status" "CommissionLedgerStatus" NOT NULL DEFAULT 'EARNED',
    "unlockDate" TIMESTAMP(3) NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "invoiceId" TEXT,
    "monthlyRevenueInvoiceId" TEXT,
    "pnlRecordId" TEXT,
    "paymentTransactionId" TEXT,
    "payoutRequestId" TEXT,
    "payoutClaimToken" TEXT,
    "earnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payableAt" TIMESTAMP(3),
    "withdrawableAt" TIMESTAMP(3),
    "withdrawnAt" TIMESTAMP(3),
    "needsClawback" BOOLEAN NOT NULL DEFAULT false,
    "reversesLedgerId" TEXT,
    "isSimulated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommissionLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayoutRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" DECIMAL(24,10) NOT NULL,
    "status" "PayoutRequestStatus" NOT NULL DEFAULT 'PENDING',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "approvalReason" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "rejectedById" TEXT,
    "rejectionReason" TEXT,
    "completedAt" TIMESTAMP(3),
    "completedById" TEXT,
    "paymentReference" TEXT,
    "payoutClaimToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayoutRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArbitrageTrade" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "qty" DOUBLE PRECISION NOT NULL,
    "buyPrice" DOUBLE PRECISION NOT NULL,
    "sellPrice" DOUBLE PRECISION NOT NULL,
    "buyDex" TEXT NOT NULL,
    "sellDex" TEXT NOT NULL,
    "feePercent" DOUBLE PRECISION NOT NULL,
    "feeAmount" DOUBLE PRECISION NOT NULL,
    "netProfit" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArbitrageTrade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArbitrageWithdrawal" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArbitrageWithdrawal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscountCoupon" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "discountPercentage" INTEGER NOT NULL,
    "maxUses" INTEGER NOT NULL,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscountCoupon_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ticket" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" "TicketStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketMessage" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailLog" (
    "id" TEXT NOT NULL,
    "recipientUserId" TEXT NOT NULL,
    "recipientEmail" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "adminEmail" TEXT,
    "kind" TEXT NOT NULL,
    "templateName" TEXT,
    "subject" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminAuditLog" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "resourceId" TEXT,
    "details" JSONB,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemAlert" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "detail" JSONB,
    "count" INTEGER NOT NULL DEFAULT 1,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedById" TEXT,
    "resolved" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "SystemAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_aadharNumber_key" ON "User"("aadharNumber");

-- CreateIndex
CREATE UNIQUE INDEX "User_panNumber_key" ON "User"("panNumber");

-- CreateIndex
CREATE UNIQUE INDEX "User_telegramChatId_key" ON "User"("telegramChatId");

-- CreateIndex
CREATE UNIQUE INDEX "User_telegramLinkToken_key" ON "User"("telegramLinkToken");

-- CreateIndex
CREATE INDEX "User_parentId_idx" ON "User"("parentId");

-- CreateIndex
CREATE INDEX "User_acquiredById_idx" ON "User"("acquiredById");

-- CreateIndex
CREATE INDEX "User_role_idx" ON "User"("role");

-- CreateIndex
CREATE INDEX "OtpRecord_email_idx" ON "OtpRecord"("email");

-- CreateIndex
CREATE UNIQUE INDEX "FutureHedgeConfig_strategyId_key" ON "FutureHedgeConfig"("strategyId");

-- CreateIndex
CREATE INDEX "FutureHedgeExecution_batchId_createdAt_idx" ON "FutureHedgeExecution"("batchId", "createdAt");

-- CreateIndex
CREATE INDEX "FutureHedgeExecution_configId_batchId_idx" ON "FutureHedgeExecution"("configId", "batchId");

-- CreateIndex
CREATE UNIQUE INDEX "UserSubscription_userId_strategyId_key" ON "UserSubscription"("userId", "strategyId");

-- CreateIndex
CREATE INDEX "ExchangeAccount_userId_idx" ON "ExchangeAccount"("userId");

-- CreateIndex
CREATE INDEX "DeltaLedgerEntry_userId_productId_occurredAt_idx" ON "DeltaLedgerEntry"("userId", "productId", "occurredAt");

-- CreateIndex
CREATE INDEX "DeltaLedgerEntry_exchangeAccountId_idx" ON "DeltaLedgerEntry"("exchangeAccountId");

-- CreateIndex
CREATE INDEX "DeltaLedgerEntry_isSimulated_idx" ON "DeltaLedgerEntry"("isSimulated");

-- CreateIndex
CREATE UNIQUE INDEX "DeltaLedgerEntry_userId_deltaUuid_key" ON "DeltaLedgerEntry"("userId", "deltaUuid");

-- CreateIndex
CREATE INDEX "StructurePnl_isSimulated_idx" ON "StructurePnl"("isSimulated");

-- CreateIndex
CREATE INDEX "StructurePnl_attributionStatus_idx" ON "StructurePnl"("attributionStatus");

-- CreateIndex
CREATE UNIQUE INDEX "StructurePnl_userId_botStructureId_key" ON "StructurePnl"("userId", "botStructureId");

-- CreateIndex
CREATE UNIQUE INDEX "StructureLegPnl_structurePnlId_botLegId_key" ON "StructureLegPnl"("structurePnlId", "botLegId");

-- CreateIndex
CREATE INDEX "DailyPnlSnapshot_isSimulated_idx" ON "DailyPnlSnapshot"("isSimulated");

-- CreateIndex
CREATE UNIQUE INDEX "DailyPnlSnapshot_userId_snapshotDate_isSimulated_key" ON "DailyPnlSnapshot"("userId", "snapshotDate", "isSimulated");

-- CreateIndex
CREATE INDEX "MonthlyRevenueInvoice_isSimulated_idx" ON "MonthlyRevenueInvoice"("isSimulated");

-- CreateIndex
CREATE UNIQUE INDEX "MonthlyRevenueInvoice_userId_periodYear_periodMonth_isSimul_key" ON "MonthlyRevenueInvoice"("userId", "periodYear", "periodMonth", "isSimulated");

-- CreateIndex
CREATE UNIQUE INDEX "Trade_clientOrderId_key" ON "Trade"("clientOrderId");

-- CreateIndex
CREATE INDEX "Trade_status_closedAt_idx" ON "Trade"("status", "closedAt");

-- CreateIndex
CREATE UNIQUE INDEX "TradePosition_clientOrderId_key" ON "TradePosition"("clientOrderId");

-- CreateIndex
CREATE INDEX "TradePosition_strategyId_status_idx" ON "TradePosition"("strategyId", "status");

-- CreateIndex
CREATE INDEX "TradePosition_userId_strategyId_status_idx" ON "TradePosition"("userId", "strategyId", "status");

-- CreateIndex
CREATE INDEX "TradePosition_isMaster_strategyId_status_symbol_side_idx" ON "TradePosition"("isMaster", "strategyId", "status", "symbol", "side");

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_userId_key" ON "Wallet"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "WalletWithdrawalRequest_ledgerTransactionId_key" ON "WalletWithdrawalRequest"("ledgerTransactionId");

-- CreateIndex
CREATE INDEX "WalletWithdrawalRequest_status_createdAt_idx" ON "WalletWithdrawalRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "WalletWithdrawalRequest_userId_status_idx" ON "WalletWithdrawalRequest"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_utrNumber_key" ON "Transaction"("utrNumber");

-- CreateIndex
CREATE INDEX "ProfileUpdateRequest_userId_status_createdAt_idx" ON "ProfileUpdateRequest"("userId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentTransaction_razorpayPaymentId_key" ON "PaymentTransaction"("razorpayPaymentId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentTransaction_depositRequestId_key" ON "PaymentTransaction"("depositRequestId");

-- CreateIndex
CREATE INDEX "PaymentTransaction_userId_createdAt_idx" ON "PaymentTransaction"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentTransaction_status_idx" ON "PaymentTransaction"("status");

-- CreateIndex
CREATE INDEX "DepositRequest_userId_createdAt_idx" ON "DepositRequest"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "DepositRequest_status_createdAt_idx" ON "DepositRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_userId_isRead_createdAt_idx" ON "Notification"("userId", "isRead", "createdAt");

-- CreateIndex
CREATE INDEX "Invoice_status_idx" ON "Invoice"("status");

-- CreateIndex
CREATE INDEX "Invoice_kind_idx" ON "Invoice"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_userId_strategyId_month_year_kind_key" ON "Invoice"("userId", "strategyId", "month", "year", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "TierConfig_tierLevel_key" ON "TierConfig"("tierLevel");

-- CreateIndex
CREATE INDEX "ReferralRequest_sponsorId_idx" ON "ReferralRequest"("sponsorId");

-- CreateIndex
CREATE INDEX "ReferralRequest_status_createdAt_idx" ON "ReferralRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ReferralRequest_referredEmail_idx" ON "ReferralRequest"("referredEmail");

-- CreateIndex
CREATE UNIQUE INDEX "AffiliateProfile_userId_key" ON "AffiliateProfile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AffiliateProfile_referralCode_key" ON "AffiliateProfile"("referralCode");

-- CreateIndex
CREATE INDEX "AffiliateProfile_upgradedById_idx" ON "AffiliateProfile"("upgradedById");

-- CreateIndex
CREATE INDEX "MemberUpgradeRequest_status_idx" ON "MemberUpgradeRequest"("status");

-- CreateIndex
CREATE INDEX "MemberUpgradeRequest_requesterId_idx" ON "MemberUpgradeRequest"("requesterId");

-- CreateIndex
CREATE INDEX "MemberUpgradeRequest_targetUserEmail_idx" ON "MemberUpgradeRequest"("targetUserEmail");

-- CreateIndex
CREATE UNIQUE INDEX "CommissionLedger_idempotencyKey_key" ON "CommissionLedger"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CommissionLedger_beneficiaryUserId_status_idx" ON "CommissionLedger"("beneficiaryUserId", "status");

-- CreateIndex
CREATE INDEX "CommissionLedger_payoutRequestId_idx" ON "CommissionLedger"("payoutRequestId");

-- CreateIndex
CREATE INDEX "CommissionLedger_payoutClaimToken_idx" ON "CommissionLedger"("payoutClaimToken");

-- CreateIndex
CREATE INDEX "CommissionLedger_sourceUserId_profitDate_idx" ON "CommissionLedger"("sourceUserId", "profitDate");

-- CreateIndex
CREATE INDEX "CommissionLedger_status_unlockDate_idx" ON "CommissionLedger"("status", "unlockDate");

-- CreateIndex
CREATE INDEX "CommissionLedger_invoiceId_idx" ON "CommissionLedger"("invoiceId");

-- CreateIndex
CREATE INDEX "CommissionLedger_monthlyRevenueInvoiceId_idx" ON "CommissionLedger"("monthlyRevenueInvoiceId");

-- CreateIndex
CREATE INDEX "CommissionLedger_profitDate_idx" ON "CommissionLedger"("profitDate");

-- CreateIndex
CREATE INDEX "PayoutRequest_userId_status_idx" ON "PayoutRequest"("userId", "status");

-- CreateIndex
CREATE INDEX "PayoutRequest_status_requestedAt_idx" ON "PayoutRequest"("status", "requestedAt");

-- CreateIndex
CREATE INDEX "PayoutRequest_payoutClaimToken_idx" ON "PayoutRequest"("payoutClaimToken");

-- CreateIndex
CREATE INDEX "PayoutRequest_approvedById_idx" ON "PayoutRequest"("approvedById");

-- CreateIndex
CREATE INDEX "PayoutRequest_rejectedById_idx" ON "PayoutRequest"("rejectedById");

-- CreateIndex
CREATE INDEX "ArbitrageTrade_userId_createdAt_idx" ON "ArbitrageTrade"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ArbitrageWithdrawal_userId_date_idx" ON "ArbitrageWithdrawal"("userId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "DiscountCoupon_code_key" ON "DiscountCoupon"("code");

-- CreateIndex
CREATE INDEX "Ticket_userId_status_idx" ON "Ticket"("userId", "status");

-- CreateIndex
CREATE INDEX "Ticket_status_updatedAt_idx" ON "Ticket"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "TicketMessage_ticketId_createdAt_idx" ON "TicketMessage"("ticketId", "createdAt");

-- CreateIndex
CREATE INDEX "EmailLog_recipientUserId_idx" ON "EmailLog"("recipientUserId");

-- CreateIndex
CREATE INDEX "EmailLog_adminUserId_idx" ON "EmailLog"("adminUserId");

-- CreateIndex
CREATE INDEX "EmailLog_createdAt_idx" ON "EmailLog"("createdAt");

-- CreateIndex
CREATE INDEX "AdminAuditLog_adminId_createdAt_idx" ON "AdminAuditLog"("adminId", "createdAt");

-- CreateIndex
CREATE INDEX "AdminAuditLog_action_createdAt_idx" ON "AdminAuditLog"("action", "createdAt");

-- CreateIndex
CREATE INDEX "AdminAuditLog_createdAt_idx" ON "AdminAuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "SystemAlert_key_idx" ON "SystemAlert"("key");

-- CreateIndex
CREATE INDEX "SystemAlert_severity_acknowledgedAt_idx" ON "SystemAlert"("severity", "acknowledgedAt");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_arbitrageSourceUserId_fkey" FOREIGN KEY ("arbitrageSourceUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_acquiredById_fkey" FOREIGN KEY ("acquiredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserActivity" ADD CONSTRAINT "UserActivity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FutureHedgeConfig" ADD CONSTRAINT "FutureHedgeConfig_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FutureHedgeExecution" ADD CONSTRAINT "FutureHedgeExecution_configId_fkey" FOREIGN KEY ("configId") REFERENCES "FutureHedgeConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSubscription" ADD CONSTRAINT "UserSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSubscription" ADD CONSTRAINT "UserSubscription_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSubscription" ADD CONSTRAINT "UserSubscription_exchangeAccountId_fkey" FOREIGN KEY ("exchangeAccountId") REFERENCES "ExchangeAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExchangeAccount" ADD CONSTRAINT "ExchangeAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeltaLedgerEntry" ADD CONSTRAINT "DeltaLedgerEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeltaLedgerEntry" ADD CONSTRAINT "DeltaLedgerEntry_exchangeAccountId_fkey" FOREIGN KEY ("exchangeAccountId") REFERENCES "ExchangeAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StructurePnl" ADD CONSTRAINT "StructurePnl_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StructureLegPnl" ADD CONSTRAINT "StructureLegPnl_structurePnlId_fkey" FOREIGN KEY ("structurePnlId") REFERENCES "StructurePnl"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyPnlSnapshot" ADD CONSTRAINT "DailyPnlSnapshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonthlyRevenueInvoice" ADD CONSTRAINT "MonthlyRevenueInvoice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradePosition" ADD CONSTRAINT "TradePosition_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradePosition" ADD CONSTRAINT "TradePosition_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletWithdrawalRequest" ADD CONSTRAINT "WalletWithdrawalRequest_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletWithdrawalRequest" ADD CONSTRAINT "WalletWithdrawalRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletWithdrawalRequest" ADD CONSTRAINT "WalletWithdrawalRequest_ledgerTransactionId_fkey" FOREIGN KEY ("ledgerTransactionId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletTransaction" ADD CONSTRAINT "WalletTransaction_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfileUpdateRequest" ADD CONSTRAINT "ProfileUpdateRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentTransaction" ADD CONSTRAINT "PaymentTransaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentTransaction" ADD CONSTRAINT "PaymentTransaction_depositRequestId_fkey" FOREIGN KEY ("depositRequestId") REFERENCES "DepositRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepositRequest" ADD CONSTRAINT "DepositRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeltaApiKey" ADD CONSTRAINT "DeltaApiKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PnLRecord" ADD CONSTRAINT "PnLRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PnLRecord" ADD CONSTRAINT "PnLRecord_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralRequest" ADD CONSTRAINT "ReferralRequest_sponsorId_fkey" FOREIGN KEY ("sponsorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AffiliateProfile" ADD CONSTRAINT "AffiliateProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AffiliateProfile" ADD CONSTRAINT "AffiliateProfile_upgradedById_fkey" FOREIGN KEY ("upgradedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberUpgradeRequest" ADD CONSTRAINT "MemberUpgradeRequest_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberUpgradeRequest" ADD CONSTRAINT "MemberUpgradeRequest_assignedParentId_fkey" FOREIGN KEY ("assignedParentId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionLedger" ADD CONSTRAINT "CommissionLedger_sourceUserId_fkey" FOREIGN KEY ("sourceUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionLedger" ADD CONSTRAINT "CommissionLedger_beneficiaryUserId_fkey" FOREIGN KEY ("beneficiaryUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionLedger" ADD CONSTRAINT "CommissionLedger_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionLedger" ADD CONSTRAINT "CommissionLedger_monthlyRevenueInvoiceId_fkey" FOREIGN KEY ("monthlyRevenueInvoiceId") REFERENCES "MonthlyRevenueInvoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionLedger" ADD CONSTRAINT "CommissionLedger_pnlRecordId_fkey" FOREIGN KEY ("pnlRecordId") REFERENCES "PnLRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionLedger" ADD CONSTRAINT "CommissionLedger_paymentTransactionId_fkey" FOREIGN KEY ("paymentTransactionId") REFERENCES "PaymentTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionLedger" ADD CONSTRAINT "CommissionLedger_payoutRequestId_fkey" FOREIGN KEY ("payoutRequestId") REFERENCES "PayoutRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutRequest" ADD CONSTRAINT "PayoutRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutRequest" ADD CONSTRAINT "PayoutRequest_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutRequest" ADD CONSTRAINT "PayoutRequest_rejectedById_fkey" FOREIGN KEY ("rejectedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutRequest" ADD CONSTRAINT "PayoutRequest_completedById_fkey" FOREIGN KEY ("completedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArbitrageTrade" ADD CONSTRAINT "ArbitrageTrade_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArbitrageWithdrawal" ADD CONSTRAINT "ArbitrageWithdrawal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketMessage" ADD CONSTRAINT "TicketMessage_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketMessage" ADD CONSTRAINT "TicketMessage_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminAuditLog" ADD CONSTRAINT "AdminAuditLog_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

