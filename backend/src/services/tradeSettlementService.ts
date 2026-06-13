import { type PrismaClient, TradeStatus } from "@prisma/client";
import { recordTradePnl } from "../controllers/subscriptionController.js";
import {
  EXIT_REASON,
  resolveCloseExitReason,
  type ExitReasonValue,
} from "../constants/exitReasons.js";
import {
  fetchDeltaOpenPositions,
  fetchDeltaSettlementExitPrice,
  fetchDeltaSwapContractSize,
  fetchDeltaTicker,
  type DeltaLivePosition,
  type TradeSide,
} from "./exchangeService.js";
import { tradePositionSymbolsAlign } from "./tradePositionService.js";

export function entryPriceMatches(stored: number, leader: number): boolean {
  const eps = Math.max(1e-8, Math.abs(leader) * 1e-6);
  return Math.abs(stored - leader) <= eps;
}

function deltaContractSizeFallback(symbol: string): number {
  const u = symbol.toUpperCase();
  if (u.includes("BTC")) return 0.001;
  if (u.includes("ETH")) return 0.01;
  return 1;
}

export async function realizedPnlUsd(args: {
  symbol: string;
  side: TradeSide;
  entryPrice: number;
  exitPrice: number;
  contracts: number;
}): Promise<number> {
  let contractFactor = deltaContractSizeFallback(args.symbol);
  try {
    contractFactor = await fetchDeltaSwapContractSize(args.symbol);
  } catch {
    /* keep fallback */
  }
  const realBaseSize = Math.abs(args.contracts) * contractFactor;
  const diff = args.exitPrice - args.entryPrice;
  return args.side === "BUY" ? diff * realBaseSize : -diff * realBaseSize;
}

function computeRevenueShareAmt(
  realizedPnl: number,
  profitSharePct: number,
): number {
  if (!Number.isFinite(realizedPnl) || realizedPnl <= 0) return 0;
  if (!Number.isFinite(profitSharePct) || profitSharePct <= 0) return 0;
  return realizedPnl * (profitSharePct / 100);
}

/**
 * Master close fills must not become follower OPEN rows. Drop any opposite-side OPEN
 * phantom rows (no PnL booking) when the real opening leg settles.
 */
export async function voidOrphanOppositeOpenCopyTrades(
  prisma: PrismaClient,
  args: {
    userId: string;
    strategyId: string;
    symbol: string;
    settledSide: TradeSide;
  },
): Promise<number> {
  const oppositeSide: TradeSide = args.settledSide === "BUY" ? "SELL" : "BUY";
  const orphans = await prisma.trade.findMany({
    where: {
      userId: args.userId,
      strategyId: args.strategyId,
      side: oppositeSide,
      status: TradeStatus.OPEN,
    },
  });
  const matching = orphans.filter((t) =>
    tradePositionSymbolsAlign(args.symbol, t.symbol),
  );
  for (const orphan of matching) {
    await prisma.trade.update({
      where: { id: orphan.id },
      data: {
        status: TradeStatus.FAILED,
        pnl: 0,
        tradePnl: 0,
        revenueShareAmt: 0,
        exitReason: EXIT_REASON.EXECUTION_FAILED,
      },
    });
  }
  if (matching.length > 0) {
    console.log(
      `[trade-settlement] voided ${matching.length} orphan ${oppositeSide} OPEN row(s) ` +
        `user=${args.userId} ${args.symbol} (opening leg ${args.settledSide} settled)`,
    );
  }
  return matching.length;
}

export type SettleOpenCopyTradesArgs = {
  userId: string;
  strategyId: string;
  symbol: string;
  side: TradeSide;
  exitPrice: number;
  exitFee?: number;
  exitReason?: ExitReasonValue | null | undefined;
  /** Prefer trades whose entry matches the master leg (optional). */
  masterEntryPrice?: number | null;
  /** When false, only the best-matching single OPEN row is settled. */
  closeAllMatching?: boolean;
  /** When set, only this OPEN trade row is updated. */
  tradeId?: string;
};

/**
 * Book realized PnL + commission for OPEN {@link Trade} rows when a copy leg closes.
 * Uses flexible symbol matching (same as TradePosition ledger).
 */
export async function settleOpenCopyTradesForLeg(
  prisma: PrismaClient,
  args: SettleOpenCopyTradesArgs,
): Promise<number> {
  const exitReason = resolveCloseExitReason(
    args.strategyId,
    args.symbol,
    args.exitReason,
  );

  const allOpen = await prisma.trade.findMany({
    where: {
      userId: args.userId,
      strategyId: args.strategyId,
      side: args.side,
      status: TradeStatus.OPEN,
    },
    orderBy: { createdAt: "asc" },
  });

  const matching = allOpen.filter((t) =>
    tradePositionSymbolsAlign(args.symbol, t.symbol),
  );
  const scoped =
    args.tradeId != null
      ? matching.filter((t) => t.id === args.tradeId)
      : matching;
  if (scoped.length === 0) return 0;

  let toClose = scoped;
  if (
    args.masterEntryPrice != null &&
    Number.isFinite(args.masterEntryPrice) &&
    args.masterEntryPrice > 0
  ) {
    const byEntry = scoped.filter((t) =>
      entryPriceMatches(t.entryPrice, args.masterEntryPrice!),
    );
    if (byEntry.length > 0) {
      toClose = args.closeAllMatching === true ? byEntry : [byEntry[0]!];
    } else if (args.closeAllMatching !== true) {
      toClose = [scoped[0]!];
    }
  } else if (args.closeAllMatching !== true) {
    toClose = [scoped[0]!];
  }

  const strategyMeta = await prisma.strategy.findUnique({
    where: { id: args.strategyId },
    select: { profitShare: true },
  });
  const profitSharePct = strategyMeta?.profitShare ?? 0;
  const exitFeeTotal = Math.max(0, Number(args.exitFee ?? 0));

  let closed = 0;
  for (let i = 0; i < toClose.length; i += 1) {
    const open = toClose[i]!;
    const legExitFee =
      i === toClose.length - 1 ? exitFeeTotal : 0;
    const contracts =
      open.size != null && Number.isFinite(open.size) && open.size > 0
        ? open.size
        : 0;
    if (contracts <= 0) continue;

    const grossPnl = await realizedPnlUsd({
      symbol: open.symbol,
      side: args.side,
      entryPrice: open.entryPrice,
      exitPrice: args.exitPrice,
      contracts,
    });
    const totalTradingFee =
      Math.max(0, Number(open.tradingFee ?? 0)) + legExitFee;
    const netPnl = grossPnl - totalTradingFee;
    const revenueShareAmt = computeRevenueShareAmt(netPnl, profitSharePct);

    await prisma.trade.update({
      where: { id: open.id },
      data: {
        exitPrice: args.exitPrice,
        tradingFee: totalTradingFee,
        pnl: netPnl,
        tradePnl: netPnl,
        revenueShareAmt,
        status: TradeStatus.CLOSED,
        exitReason,
      },
    });

    await recordTradePnl(prisma, {
      userId: args.userId,
      strategyId: args.strategyId,
      tradeProfit: netPnl,
    });
    closed += 1;
  }

  if (closed > 0) {
    await voidOrphanOppositeOpenCopyTrades(prisma, {
      userId: args.userId,
      strategyId: args.strategyId,
      symbol: args.symbol,
      settledSide: args.side,
    });
    console.log(
      `[trade-settlement] CLOSED ${closed} trade(s) user=${args.userId} ` +
        `${args.symbol} ${args.side} exit=${args.exitPrice}`,
    );
  }

  return closed;
}

async function resolveSettlementExitPrice(
  symbol: string,
  side: TradeSide,
  entryPrice: number,
): Promise<number> {
  const fromMarket = await fetchDeltaSettlementExitPrice(symbol, side);
  if (fromMarket != null && Number.isFinite(fromMarket) && fromMarket > 0) {
    return fromMarket;
  }
  try {
    const tick = await fetchDeltaTicker(symbol);
    if (tick.last != null && Number.isFinite(tick.last) && tick.last > 0) {
      return tick.last;
    }
  } catch {
    /* optional */
  }
  return entryPrice > 0 ? entryPrice : 0;
}

function exchangeLegStillOpen(
  exchangeOpen: DeltaLivePosition[],
  symbol: string,
  side: TradeSide,
): boolean {
  return exchangeOpen.some(
    (p) =>
      p.side === side &&
      tradePositionSymbolsAlign(symbol, p.symbolKey) &&
      Math.abs(p.contracts) >= 1e-12,
  );
}

/**
 * Close or void DB OPEN rows when the follower's Delta book is flat for that leg.
 * Used by the copy-engine safety net and admin "settle stale OPEN" action.
 */
export async function reconcileStaleOpenTradesForUser(
  prisma: PrismaClient,
  args: {
    userId: string;
    apiKey: string;
    apiSecret: string;
  },
): Promise<{ settled: number; voided: number; skippedStillOpen: number }> {
  const openTrades = await prisma.trade.findMany({
    where: { userId: args.userId, status: TradeStatus.OPEN },
    orderBy: { createdAt: "asc" },
  });
  if (openTrades.length === 0) {
    return { settled: 0, voided: 0, skippedStillOpen: 0 };
  }

  let exchangeOpen: DeltaLivePosition[] = [];
  try {
    exchangeOpen = await fetchDeltaOpenPositions(
      args.apiKey,
      args.apiSecret,
      { lite: true, skipCache: true },
    );
  } catch (err) {
    console.warn(
      `[trade-settlement] stale reconcile fetch failed user=${args.userId}:`,
      err instanceof Error ? err.message : err,
    );
    throw err;
  }

  let settled = 0;
  let voided = 0;
  let skippedStillOpen = 0;

  for (const trade of openTrades) {
    const side: TradeSide =
      trade.side.toUpperCase() === "SELL" ? "SELL" : "BUY";
    if (exchangeLegStillOpen(exchangeOpen, trade.symbol, side)) {
      skippedStillOpen += 1;
      continue;
    }

    const exitPrice = await resolveSettlementExitPrice(
      trade.symbol,
      side,
      trade.entryPrice,
    );

    const closed = await settleOpenCopyTradesForLeg(prisma, {
      userId: args.userId,
      strategyId: trade.strategyId,
      symbol: trade.symbol,
      side,
      exitPrice,
      exitFee: 0,
      exitReason: EXIT_REASON.RECONCILE_GHOST,
      tradeId: trade.id,
    });

    if (closed > 0) {
      settled += closed;
      continue;
    }

    const stillOpen = await prisma.trade.findUnique({
      where: { id: trade.id },
      select: { status: true },
    });
    if (stillOpen?.status !== TradeStatus.OPEN) continue;

    await prisma.trade.update({
      where: { id: trade.id },
      data: {
        status: TradeStatus.FAILED,
        exitPrice: exitPrice > 0 ? exitPrice : trade.entryPrice,
        pnl: 0,
        tradePnl: 0,
        revenueShareAmt: 0,
        exitReason: EXIT_REASON.RECONCILE_GHOST,
      },
    });
    voided += 1;
  }

  if (settled > 0 || voided > 0) {
    console.log(
      `[trade-settlement] stale reconcile user=${args.userId} settled=${settled} voided=${voided} skipped=${skippedStillOpen}`,
    );
  }

  return { settled, voided, skippedStillOpen };
}
