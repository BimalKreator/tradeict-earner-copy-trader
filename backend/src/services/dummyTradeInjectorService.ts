import { randomUUID } from "node:crypto";
import { TradeStatus, type PrismaClient } from "@prisma/client";
import { EXIT_REASON } from "../constants/exitReasons.js";
import { recordTradePnl } from "../controllers/subscriptionController.js";
import { computeUserBookedPnlAndRevenueDue } from "./dashboardMetricsService.js";

export type InjectDummyTradeInput = {
  userId: string;
  strategyId: string;
  grossPnl: number;
  symbol: string;
};

export type InjectDummyTradeResult = {
  tradeId: string;
  pnlRecordId: string;
  grossPnl: number;
  appRevenue: number;
  profitSharePct: number;
  isDummy: true;
  symbol: string;
  commissionsCreated: number;
  commissionsSkipped: number;
  commissionLedger: Array<{
    id: string;
    beneficiaryUserId: string;
    amount: number;
    commissionRate: number;
    status: string;
  }>;
  bookedAfter: {
    grossPnl: number;
    appRevenue: number;
    netEarnedPnl: number;
  };
};

export async function injectDummyTrade(
  prisma: PrismaClient,
  input: InjectDummyTradeInput,
): Promise<InjectDummyTradeResult> {
  const userId = input.userId.trim();
  const strategyId = input.strategyId.trim();
  const symbol = input.symbol.trim();
  const grossPnl = Number(input.grossPnl);

  if (!userId || !strategyId || !symbol) {
    throw new Error("userId, strategyId, and symbol are required");
  }
  if (!Number.isFinite(grossPnl)) {
    throw new Error("grossPnl must be a finite number");
  }

  const [user, strategy] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true },
    }),
    prisma.strategy.findUnique({
      where: { id: strategyId },
      select: { id: true, title: true, profitShare: true },
    }),
  ]);

  if (!user) {
    throw new Error("User not found");
  }
  if (!strategy) {
    throw new Error("Strategy not found");
  }

  const profitSharePct = strategy.profitShare;
  const revenueShareAmt =
    grossPnl > 0 && profitSharePct > 0
      ? grossPnl * (profitSharePct / 100)
      : 0;

  const clientOrderId = `dummy-${randomUUID()}`;

  const trade = await prisma.trade.create({
    data: {
      userId,
      strategyId,
      symbol,
      side: "BUY",
      size: 1,
      entryPrice: 1,
      exitPrice: 1,
      pnl: grossPnl,
      tradePnl: grossPnl,
      tradingFee: 0,
      revenueShareAmt,
      status: TradeStatus.CLOSED,
      exitReason: EXIT_REASON.DUMMY_INJECT,
      clientOrderId,
      isDummy: true,
    },
  });

  console.log(
    `[inject-dummy-trade] created Trade id=${trade.id} user=${userId} ` +
      `strategy=${strategyId} symbol=${symbol} grossPnl=$${grossPnl.toFixed(2)} isDummy=true`,
  );

  const pnlResult = await recordTradePnl(prisma, {
    userId,
    strategyId,
    tradeProfit: grossPnl,
    isDummy: true,
    awaitCommissionDistribution: true,
  });

  if (!pnlResult) {
    throw new Error("Failed to create PnL record for dummy trade");
  }

  const commissionLedger = await prisma.commissionLedger.findMany({
    where: { pnlRecordId: pnlResult.pnlRecordId },
    select: {
      id: true,
      beneficiaryUserId: true,
      amount: true,
      commissionRate: true,
      status: true,
    },
    orderBy: { createdAt: "asc" },
  });

  const bookedAfter = await computeUserBookedPnlAndRevenueDue(
    prisma,
    userId,
    null,
  );

  console.log(
    `[inject-dummy-trade] complete tradeId=${trade.id} pnlRecordId=${pnlResult.pnlRecordId} ` +
      `appRevenue=$${pnlResult.commissionAmount.toFixed(4)} ` +
      `commissions=${pnlResult.commissionsCreated} skipped=${pnlResult.commissionsSkipped} ` +
      `bookedGross=$${bookedAfter.grossPnl.toFixed(2)}`,
  );

  return {
    tradeId: trade.id,
    pnlRecordId: pnlResult.pnlRecordId,
    grossPnl,
    appRevenue: pnlResult.commissionAmount,
    profitSharePct,
    isDummy: true,
    symbol,
    commissionsCreated: pnlResult.commissionsCreated,
    commissionsSkipped: pnlResult.commissionsSkipped,
    commissionLedger,
    bookedAfter: {
      grossPnl: bookedAfter.grossPnl,
      appRevenue: bookedAfter.appRevenue,
      netEarnedPnl: bookedAfter.netEarnedPnl,
    },
  };
}
