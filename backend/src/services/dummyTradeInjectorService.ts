import { randomUUID } from "node:crypto";
import {
  SubscriptionStatus,
  TradeStatus,
  type PrismaClient,
} from "@prisma/client";
import { EXIT_REASON } from "../constants/exitReasons.js";
import { recordTradePnl } from "../controllers/subscriptionController.js";
import { computePerTradeRevenueShareAmt, computeUserBookedPnlAndRevenueDue } from "./dashboardMetricsService.js";

const DEFAULT_INJECT_SYMBOL = "DUMMY-INJECT";

export type InjectTradeInput = {
  userId: string;
  grossPnl: number;
  symbol?: string;
  strategyId?: string;
};

export type InjectTradeResult = {
  tradeId: string;
  pnlRecordId: string;
  strategyId: string;
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

/** @deprecated use InjectTradeInput */
export type InjectDummyTradeInput = InjectTradeInput & {
  strategyId: string;
  symbol: string;
};

/** @deprecated use InjectTradeResult */
export type InjectDummyTradeResult = InjectTradeResult;

async function resolveInjectStrategyId(
  prisma: PrismaClient,
  userId: string,
  strategyId?: string,
): Promise<string> {
  const explicit = strategyId?.trim();
  if (explicit) return explicit;

  const active = await prisma.userStrategySubscription.findFirst({
    where: {
      userId,
      isActive: true,
      status: SubscriptionStatus.ACTIVE,
    },
    orderBy: { joinedDate: "desc" },
    select: { strategyId: true },
  });
  if (active) return active.strategyId;

  const anySub = await prisma.userStrategySubscription.findFirst({
    where: { userId },
    orderBy: { joinedDate: "desc" },
    select: { strategyId: true },
  });
  if (!anySub) {
    throw new Error(
      "User has no strategy subscription — subscribe them or pass strategyId",
    );
  }
  return anySub.strategyId;
}

function parseInjectTradeBody(body: {
  userId?: unknown;
  grossPnl?: unknown;
  symbol?: unknown;
  strategyId?: unknown;
}): InjectTradeInput {
  const userId = typeof body.userId === "string" ? body.userId.trim() : "";
  const grossPnl =
    typeof body.grossPnl === "number"
      ? body.grossPnl
      : typeof body.grossPnl === "string"
        ? Number.parseFloat(body.grossPnl)
        : NaN;
  const symbol =
    typeof body.symbol === "string" && body.symbol.trim()
      ? body.symbol.trim()
      : undefined;
  const strategyId =
    typeof body.strategyId === "string" && body.strategyId.trim()
      ? body.strategyId.trim()
      : undefined;

  if (!userId) {
    throw new Error("userId is required");
  }
  if (!Number.isFinite(grossPnl)) {
    throw new Error("grossPnl must be a finite number");
  }

  return {
    userId,
    grossPnl,
    ...(symbol ? { symbol } : {}),
    ...(strategyId ? { strategyId } : {}),
  };
}

export function isInjectTradeClientError(message: string): boolean {
  return (
    message.includes("required") ||
    message.includes("not found") ||
    message.includes("finite") ||
    message.includes("subscription") ||
    message.includes("Failed to create")
  );
}

/** Admin debug — simulate a closed trade (no exchange); runs PnL + commission chain. */
export async function injectTrade(
  prisma: PrismaClient,
  input: InjectTradeInput,
): Promise<InjectTradeResult> {
  const userId = input.userId.trim();
  const grossPnl = Number(input.grossPnl);
  const symbol = input.symbol?.trim() || DEFAULT_INJECT_SYMBOL;
  const strategyId = await resolveInjectStrategyId(
    prisma,
    userId,
    input.strategyId,
  );

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
  const revenueShareAmt = computePerTradeRevenueShareAmt(
    grossPnl,
    profitSharePct,
  );

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
    `[inject-trade] created Trade id=${trade.id} user=${userId} ` +
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
    throw new Error("Failed to create PnL record for injected trade");
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
    `[inject-trade] complete tradeId=${trade.id} pnlRecordId=${pnlResult.pnlRecordId} ` +
      `appRevenue=$${pnlResult.commissionAmount.toFixed(4)} ` +
      `commissions=${pnlResult.commissionsCreated} skipped=${pnlResult.commissionsSkipped} ` +
      `bookedGross=$${bookedAfter.grossPnl.toFixed(2)}`,
  );

  return {
    tradeId: trade.id,
    pnlRecordId: pnlResult.pnlRecordId,
    strategyId,
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

/** @deprecated use injectTrade */
export const injectDummyTrade = injectTrade;

export async function handleInjectTradeRequest(
  prisma: PrismaClient,
  body: Record<string, unknown>,
): Promise<InjectTradeResult> {
  return injectTrade(prisma, parseInjectTradeBody(body));
}

export type ClearDummyTradesResult = {
  tradesDeleted: number;
  pnlRecordsDeleted: number;
  commissionLedgersDeleted: number;
};

function dummyTradeWhere() {
  return {
    OR: [
      { isDummy: true },
      { exitReason: EXIT_REASON.DUMMY_INJECT },
    ],
  };
}

/**
 * Remove all admin-injected dummy trades and linked PnL / commission rows.
 * Order: CommissionLedger → PnLRecord → Trade (FK-safe).
 */
export async function clearDummyTrades(
  prisma: PrismaClient,
): Promise<ClearDummyTradesResult> {
  return prisma.$transaction(async (tx) => {
    const dummyPnlRows = await tx.pnLRecord.findMany({
      where: { isDummy: true },
      select: { id: true },
    });
    const pnlRecordIds = dummyPnlRows.map((r) => r.id);

    const commissionLedgersDeleted = await tx.commissionLedger.deleteMany({
      where:
        pnlRecordIds.length > 0
          ? { pnlRecordId: { in: pnlRecordIds } }
          : { id: { in: [] } },
    });

    const pnlRecordsDeleted = await tx.pnLRecord.deleteMany({
      where: { isDummy: true },
    });

    const tradesDeleted = await tx.trade.deleteMany({
      where: dummyTradeWhere(),
    });

    console.log(
      `[clear-dummy-trades] removed trades=${tradesDeleted.count} ` +
        `pnlRecords=${pnlRecordsDeleted.count} ` +
        `commissionLedgers=${commissionLedgersDeleted.count}`,
    );

    return {
      tradesDeleted: tradesDeleted.count,
      pnlRecordsDeleted: pnlRecordsDeleted.count,
      commissionLedgersDeleted: commissionLedgersDeleted.count,
    };
  });
}
