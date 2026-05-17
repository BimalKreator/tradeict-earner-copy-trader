import cron from "node-cron";
import { UserStatus, type PrismaClient } from "@prisma/client";
import {
  CACHE_TTL_MS,
  filterValidDexArbitrageRows,
  getDexArbitrageData,
  type DexArbitrageRow,
} from "./arbitrageService.js";

/** Same window as Dex scanner cache — skip repeating the same venue pair. */
const DUPLICATE_LOOKBACK_MS = CACHE_TTL_MS;

const DEFAULT_CRON = "*/4 * * * *";

export type ArbitrageCycleResult = {
  usersEligible: number;
  tradesExecuted: number;
  bestToken: string | null;
  bestNetSpreadPercent: number | null;
};

export function opportunityFingerprint(row: DexArbitrageRow): string {
  return `${row.token}|${row.lowestDex}|${row.highestDex}`;
}

/** Highest netSpreadPercent row with netSpreadPercent > 0. */
export function pickBestArbitrageOpportunity(
  rows: DexArbitrageRow[],
): DexArbitrageRow | null {
  let best: DexArbitrageRow | null = null;
  for (const row of rows) {
    if (
      row.basePrice <= 0 ||
      row.lowestPrice <= 0 ||
      row.highestPrice <= 0 ||
      !Number.isFinite(row.netSpreadPercent) ||
      row.netSpreadPercent <= 0
    ) {
      continue;
    }
    if (!best || row.netSpreadPercent > best.netSpreadPercent) {
      best = row;
    }
  }
  return best;
}

function roundMoney(n: number): number {
  return Math.round(n * 1e8) / 1e8;
}

export type ArbitrageTradeMath = {
  capitalAllocated: number;
  qty: number;
  grossProfit: number;
  feePercent: number;
  feeAmount: number;
  netProfit: number;
};

/**
 * PnL from allocated capital × scanner percentages (not fee-on-profit).
 * gross = capital × spread%; fee = capital × fee%; net = capital × netSpread%.
 */
export function computeArbitrageTradeMath(
  userBalance: number,
  capitalPerTradePercent: number,
  opportunity: DexArbitrageRow,
): ArbitrageTradeMath | null {
  if (
    !Number.isFinite(opportunity.netSpreadPercent) ||
    opportunity.netSpreadPercent <= 0
  ) {
    return null;
  }

  const buyPrice = opportunity.lowestPrice;
  const sellPrice = opportunity.highestPrice;
  if (
    !Number.isFinite(userBalance) ||
    userBalance <= 0 ||
    !Number.isFinite(capitalPerTradePercent) ||
    capitalPerTradePercent <= 0 ||
    !Number.isFinite(buyPrice) ||
    buyPrice <= 0 ||
    !Number.isFinite(sellPrice) ||
    sellPrice <= 0 ||
    sellPrice <= buyPrice
  ) {
    return null;
  }

  const capitalAllocated = roundMoney(
    userBalance * (capitalPerTradePercent / 100),
  );
  if (capitalAllocated <= 0) return null;

  const grossProfit = roundMoney(
    capitalAllocated * (opportunity.spreadPercentage / 100),
  );
  const feePercent = opportunity.estimatedFeePercent;
  const feeAmount = roundMoney(
    capitalAllocated * (feePercent / 100),
  );
  const netProfit = roundMoney(
    capitalAllocated * (opportunity.netSpreadPercent / 100),
  );
  if (netProfit <= 0) return null;

  const qty = roundMoney(capitalAllocated / buyPrice);
  if (qty <= 0) return null;

  return {
    capitalAllocated,
    qty,
    grossProfit,
    feePercent,
    feeAmount,
    netProfit,
  };
}

async function userRecentlyTradedOpportunity(
  prisma: PrismaClient,
  userId: string,
  opportunity: DexArbitrageRow,
  since: Date,
): Promise<boolean> {
  const recent = await prisma.arbitrageTrade.findFirst({
    where: {
      userId,
      createdAt: { gte: since },
      token: opportunity.token,
      buyDex: opportunity.lowestDex,
      sellDex: opportunity.highestDex,
    },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  return recent != null;
}

/**
 * One engine cycle: refresh scanner data, pick the best net spread, execute at most
 * one trade per eligible user (skip duplicate venue pairs within the lookback window).
 */
export async function runArbitrageEngineCycle(
  prisma: PrismaClient,
): Promise<ArbitrageCycleResult> {
  const { data } = await getDexArbitrageData(true);
  const best = pickBestArbitrageOpportunity(
    filterValidDexArbitrageRows(data.rows),
  );

  if (!best) {
    return {
      usersEligible: 0,
      tradesExecuted: 0,
      bestToken: null,
      bestNetSpreadPercent: null,
    };
  }

  const users = await prisma.user.findMany({
    where: {
      cryptoArbitrageEnabled: true,
      status: UserStatus.ACTIVE,
      cryptoBalance: { gt: 0 },
    },
    select: {
      id: true,
      cryptoBalance: true,
      cryptoCapitalPerTradePercent: true,
    },
  });

  const since = new Date(Date.now() - DUPLICATE_LOOKBACK_MS);
  let tradesExecuted = 0;

  for (const user of users) {
    const math = computeArbitrageTradeMath(
      user.cryptoBalance,
      user.cryptoCapitalPerTradePercent,
      best,
    );
    if (!math) continue;

    const isDuplicate = await userRecentlyTradedOpportunity(
      prisma,
      user.id,
      best,
      since,
    );
    if (isDuplicate) continue;

    try {
      await prisma.$transaction(async (tx) => {
        await tx.arbitrageTrade.create({
          data: {
            userId: user.id,
            token: best.token,
            qty: math.qty,
            buyPrice: best.lowestPrice,
            sellPrice: best.highestPrice,
            buyDex: best.lowestDex,
            sellDex: best.highestDex,
            feePercent: math.feePercent,
            feeAmount: math.feeAmount,
            netProfit: math.netProfit,
          },
        });
        await tx.user.update({
          where: { id: user.id },
          data: { cryptoBalance: { increment: math.netProfit } },
        });
      });
      tradesExecuted += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[arbitrage-engine] trade failed userId=${user.id} token=${best.token}:`,
        msg,
      );
    }
  }

  return {
    usersEligible: users.length,
    tradesExecuted,
    bestToken: best.token,
    bestNetSpreadPercent: best.netSpreadPercent,
  };
}

/**
 * Schedules the automated arbitrage worker (default: every 4 minutes, UTC).
 * Set `ARBITRAGE_ENGINE_ENABLED=false` to disable. Override schedule with
 * `ARBITRAGE_ENGINE_CRON` (node-cron expression).
 */
export function initArbitrageEngine(prisma: PrismaClient): void {
  if (process.env.ARBITRAGE_ENGINE_ENABLED === "false") {
    console.log("[arbitrage-engine] Disabled (ARBITRAGE_ENGINE_ENABLED=false)");
    return;
  }

  const expression =
    process.env.ARBITRAGE_ENGINE_CRON?.trim() || DEFAULT_CRON;

  cron.schedule(
    expression,
    () => {
      void runArbitrageEngineCycle(prisma)
        .then((res) => {
          if (res.tradesExecuted > 0) {
            console.log(
              `[arbitrage-engine] ${res.tradesExecuted} trade(s) on ${res.bestToken} ` +
                `(net ${res.bestNetSpreadPercent?.toFixed(2)}%) · ${res.usersEligible} eligible user(s)`,
            );
          }
        })
        .catch((err) => {
          console.error("[arbitrage-engine] Cycle failed:", err);
        });
    },
    { timezone: "Etc/UTC" },
  );

  const startupDelayMs = Number(process.env.ARBITRAGE_ENGINE_STARTUP_DELAY_MS ?? 15_000);
  if (Number.isFinite(startupDelayMs) && startupDelayMs > 0) {
    setTimeout(() => {
      void runArbitrageEngineCycle(prisma).catch((err) => {
        console.error("[arbitrage-engine] Startup cycle failed:", err);
      });
    }, startupDelayMs);
  }

  console.log(
    `[arbitrage-engine] Scheduled (${expression}, UTC); startup delay ${startupDelayMs}ms`,
  );
}
