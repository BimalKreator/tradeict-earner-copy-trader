import {
  type PrismaClient,
  SubscriptionStatus,
  TradeStatus,
  UserStatus,
} from "@prisma/client";
import {
  fetchCosmicOpenPositions,
  type CosmicLedTrade,
} from "./cosmicClient.js";
import {
  executeTrade,
  fetchDeltaTicker,
  type TradeSide,
} from "./exchangeService.js";
import { recordTradePnl } from "../controllers/subscriptionController.js";
import { notifyTradeExecuted } from "./telegramService.js";
import { logUserActivity } from "./userActivityService.js";

const POLL_MIN_MS = 2000;
const POLL_MAX_MS = 3000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomPollMs(): number {
  return (
    POLL_MIN_MS +
    Math.floor(Math.random() * (POLL_MAX_MS - POLL_MIN_MS + 1))
  );
}

function percentSlippage(entry: number, market: number): number {
  if (entry <= 0) return Number.POSITIVE_INFINITY;
  return (Math.abs(market - entry) / entry) * 100;
}

async function recordTrade(
  prisma: PrismaClient,
  args: {
    userId: string;
    strategyId: string;
    symbol: string;
    side: string;
    size: number;
    entryPrice: number;
    status: TradeStatus;
    exitPrice?: number | null;
    pnl?: number | null;
  },
) {
  await prisma.trade.create({
    data: {
      userId: args.userId,
      strategyId: args.strategyId,
      symbol: args.symbol,
      side: args.side,
      size: args.size,
      entryPrice: args.entryPrice,
      status: args.status,
      ...(args.exitPrice != null ? { exitPrice: args.exitPrice } : {}),
      ...(args.pnl != null ? { pnl: args.pnl } : {}),
    },
  });

  if (
    args.status === TradeStatus.CLOSED &&
    args.pnl != null &&
    Number.isFinite(args.pnl)
  ) {
    await recordTradePnl(prisma, {
      userId: args.userId,
      strategyId: args.strategyId,
      tradeProfit: args.pnl,
    });
  }

  if (args.status === TradeStatus.OPEN) {
    void notifyTradeExecuted(prisma, {
      userId: args.userId,
      strategyId: args.strategyId,
      symbol: args.symbol,
      side: args.side,
      size: args.size,
      entryPrice: args.entryPrice,
    }).catch((err) => {
      console.warn("[telegram] notifyTradeExecuted:", err);
    });
  }

  if (args.status === TradeStatus.FAILED) {
    void logUserActivity(prisma, {
      userId: args.userId,
      kind: "TRADE_SKIPPED",
      message: `Trade skipped: ${args.symbol} ${args.side} @ ${args.entryPrice} (size ${args.size})`,
    });
  }
}

function realizedPnlUsd(args: {
  side: TradeSide;
  entryPrice: number;
  exitPrice: number;
  size: number;
}): number {
  const diff = args.exitPrice - args.entryPrice;
  return args.side === "BUY" ? diff * args.size : -diff * args.size;
}

function entryPriceMatches(stored: number, cosmic: number): boolean {
  const eps = Math.max(1e-8, Math.abs(cosmic) * 1e-6);
  return Math.abs(stored - cosmic) <= eps;
}

/**
 * Marks the follower's matching OPEN trade CLOSED and writes PnL + commission row.
 */
async function closeFollowerTradeAndRecordPnl(
  prisma: PrismaClient,
  args: {
    userId: string;
    strategyId: string;
    cosmic: CosmicLedTrade;
    sizedPosition: number;
    exitPrice: number;
  },
): Promise<void> {
  const candidates = await prisma.trade.findMany({
    where: {
      userId: args.userId,
      strategyId: args.strategyId,
      symbol: args.cosmic.deltaSymbol,
      side: args.cosmic.side,
      status: TradeStatus.OPEN,
    },
    orderBy: { createdAt: "asc" },
  });

  const open = candidates.find((t) =>
    entryPriceMatches(t.entryPrice, args.cosmic.entryPrice),
  );

  if (!open) return;

  const tradeProfit = realizedPnlUsd({
    side: args.cosmic.side,
    entryPrice: args.cosmic.entryPrice,
    exitPrice: args.exitPrice,
    size: args.sizedPosition,
  });

  await prisma.trade.update({
    where: { id: open.id },
    data: {
      exitPrice: args.exitPrice,
      pnl: tradeProfit,
      status: TradeStatus.CLOSED,
    },
  });

  await recordTradePnl(prisma, {
    userId: args.userId,
    strategyId: args.strategyId,
    tradeProfit,
  });
}

async function processRemovedCosmicPositions(
  prisma: PrismaClient,
  strategy: { id: string },
  removed: CosmicLedTrade[],
): Promise<void> {
  for (const cosmic of removed) {
    let exitPrice: number | undefined;
    try {
      const t = await fetchDeltaTicker(cosmic.deltaSymbol);
      exitPrice = t.last;
    } catch {
      exitPrice = undefined;
    }
    if (exitPrice === undefined || !Number.isFinite(exitPrice)) continue;

    const subs = await prisma.userSubscription.findMany({
      where: {
        strategyId: strategy.id,
        status: SubscriptionStatus.ACTIVE,
        user: { status: UserStatus.ACTIVE },
      },
    });

    for (const sub of subs) {
      const userSize = cosmic.size * sub.multiplier;
      await closeFollowerTradeAndRecordPnl(prisma, {
        userId: sub.userId,
        strategyId: strategy.id,
        cosmic,
        sizedPosition: userSize,
        exitPrice,
      });
    }
  }
}

/**
 * Late-join: after subscribe, mirror each currently open Cosmic position onto Delta for one subscriber.
 * Guarded by `strategy.syncActiveTrades` at the caller.
 */
export async function lateJoinMirrorOpenPositionsForSubscriber(
  prisma: PrismaClient,
  args: { strategyId: string; userId: string },
): Promise<void> {
  const strategy = await prisma.strategy.findUnique({
    where: { id: args.strategyId },
  });
  if (!strategy || !strategy.syncActiveTrades) return;

  const sub = await prisma.userSubscription.findFirst({
    where: {
      strategyId: args.strategyId,
      userId: args.userId,
      status: SubscriptionStatus.ACTIVE,
    },
    include: {
      exchangeAccount: true,
      user: { include: { deltaApiKeys: true } },
    },
  });
  if (!sub || sub.user.status !== UserStatus.ACTIVE) return;

  let scraped: CosmicLedTrade[];
  try {
    scraped = await fetchCosmicOpenPositions(
      strategy.cosmicEmail,
      strategy.cosmicPassword,
      strategy.scraperMappings,
    );
  } catch (err) {
    console.error("[late-join] Cosmic fetch failed:", err);
    return;
  }

  for (const cosmic of scraped) {
    let marketPrice: number | undefined;
    try {
      const t = await fetchDeltaTicker(cosmic.deltaSymbol);
      marketPrice = t.last;
    } catch {
      marketPrice = undefined;
    }

    const userSize = cosmic.size * sub.multiplier;

    if (
      marketPrice !== undefined &&
      percentSlippage(cosmic.entryPrice, marketPrice) > strategy.slippage
    ) {
      await recordTrade(prisma, {
        userId: sub.userId,
        strategyId: strategy.id,
        symbol: cosmic.deltaSymbol,
        side: cosmic.side,
        size: userSize,
        entryPrice: cosmic.entryPrice,
        status: TradeStatus.FAILED,
      });
      continue;
    }

    if (marketPrice === undefined) {
      await recordTrade(prisma, {
        userId: sub.userId,
        strategyId: strategy.id,
        symbol: cosmic.deltaSymbol,
        side: cosmic.side,
        size: userSize,
        entryPrice: cosmic.entryPrice,
        status: TradeStatus.FAILED,
      });
      continue;
    }

    const creds =
      sub.exchangeAccount != null
        ? {
            apiKey: sub.exchangeAccount.apiKey,
            apiSecret: sub.exchangeAccount.apiSecret,
          }
        : sub.user.deltaApiKeys[0] != null
          ? {
              apiKey: sub.user.deltaApiKeys[0]!.apiKey,
              apiSecret: sub.user.deltaApiKeys[0]!.apiSecret,
            }
          : null;

    if (!creds) {
      await recordTrade(prisma, {
        userId: sub.userId,
        strategyId: strategy.id,
        symbol: cosmic.deltaSymbol,
        side: cosmic.side,
        size: userSize,
        entryPrice: cosmic.entryPrice,
        status: TradeStatus.FAILED,
      });
      continue;
    }

    const result = await executeTrade(
      creds.apiKey,
      creds.apiSecret,
      cosmic.deltaSymbol,
      cosmic.side,
      userSize,
    );

    await recordTrade(prisma, {
      userId: sub.userId,
      strategyId: strategy.id,
      symbol: cosmic.deltaSymbol,
      side: cosmic.side,
      size: userSize,
      entryPrice: cosmic.entryPrice,
      status: result.success ? TradeStatus.OPEN : TradeStatus.FAILED,
    });
  }
}

async function processNewCosmicTrade(
  prisma: PrismaClient,
  strategy: {
    id: string;
    slippage: number;
  },
  cosmic: CosmicLedTrade,
) {
  let marketPrice: number | undefined;
  try {
    const t = await fetchDeltaTicker(cosmic.deltaSymbol);
    marketPrice = t.last;
  } catch {
    marketPrice = undefined;
  }

  const subs = await prisma.userSubscription.findMany({
    where: {
      strategyId: strategy.id,
      status: SubscriptionStatus.ACTIVE,
      user: { status: UserStatus.ACTIVE },
    },
    include: {
      exchangeAccount: true,
      user: {
        include: { deltaApiKeys: true },
      },
    },
  });

  if (
    marketPrice !== undefined &&
    percentSlippage(cosmic.entryPrice, marketPrice) > strategy.slippage
  ) {
    console.log(
      `[tradeEngine] Slippage exceeded for ${cosmic.deltaSymbol} (${cosmic.cosmicSymbol})`,
    );
    for (const sub of subs) {
      const userSize = cosmic.size * sub.multiplier;
      await recordTrade(prisma, {
        userId: sub.userId,
        strategyId: strategy.id,
        symbol: cosmic.deltaSymbol,
        side: cosmic.side,
        size: userSize,
        entryPrice: cosmic.entryPrice,
        status: TradeStatus.FAILED,
      });
    }
    return;
  }

  if (marketPrice === undefined) {
    for (const sub of subs) {
      const userSize = cosmic.size * sub.multiplier;
      await recordTrade(prisma, {
        userId: sub.userId,
        strategyId: strategy.id,
        symbol: cosmic.deltaSymbol,
        side: cosmic.side,
        size: userSize,
        entryPrice: cosmic.entryPrice,
        status: TradeStatus.FAILED,
      });
    }
    return;
  }

  for (const sub of subs) {
    const userSize = cosmic.size * sub.multiplier;

    const creds =
      sub.exchangeAccount != null
        ? {
            apiKey: sub.exchangeAccount.apiKey,
            apiSecret: sub.exchangeAccount.apiSecret,
          }
        : sub.user.deltaApiKeys[0] != null
          ? {
              apiKey: sub.user.deltaApiKeys[0]!.apiKey,
              apiSecret: sub.user.deltaApiKeys[0]!.apiSecret,
            }
          : null;

    if (!creds) {
      await recordTrade(prisma, {
        userId: sub.userId,
        strategyId: strategy.id,
        symbol: cosmic.deltaSymbol,
        side: cosmic.side,
        size: userSize,
        entryPrice: cosmic.entryPrice,
        status: TradeStatus.FAILED,
      });
      continue;
    }

    const result = await executeTrade(
      creds.apiKey,
      creds.apiSecret,
      cosmic.deltaSymbol,
      cosmic.side,
      userSize,
    );

    await recordTrade(prisma, {
      userId: sub.userId,
      strategyId: strategy.id,
      symbol: cosmic.deltaSymbol,
      side: cosmic.side,
      size: userSize,
      entryPrice: cosmic.entryPrice,
      status: result.success ? TradeStatus.OPEN : TradeStatus.FAILED,
    });
  }
}

/** Prefer last row in API order — often newest at bottom. */
function pickLatestTrade(trades: CosmicLedTrade[]): CosmicLedTrade | null {
  if (trades.length === 0) return null;
  return trades[trades.length - 1]!;
}

type StrategyDedupe = {
  lastId: string | undefined;
  prevOpenById: Map<string, CosmicLedTrade>;
};

async function runEngineLoop(
  prisma: PrismaClient,
  cancelled: { value: boolean },
  dedupeByStrategy: Map<string, StrategyDedupe>,
): Promise<void> {
  while (!cancelled.value) {
    try {
      const strategies = await prisma.strategy.findMany({
        where: {
          subscriptions: {
            some: { status: SubscriptionStatus.ACTIVE },
          },
        },
      });

      for (const strategy of strategies) {
        let scraped: CosmicLedTrade[];
        try {
          scraped = await fetchCosmicOpenPositions(
            strategy.cosmicEmail,
            strategy.cosmicPassword,
            strategy.scraperMappings,
          );
        } catch (err) {
          console.error(
            `[tradeEngine] Cosmic fetch failed for strategy ${strategy.id}:`,
            err,
          );
          continue;
        }

        let dedupe = dedupeByStrategy.get(strategy.id);
        if (!dedupe) {
          dedupe = { lastId: undefined, prevOpenById: new Map() };
          dedupeByStrategy.set(strategy.id, dedupe);
        }

        const currentOpen = new Map(scraped.map((t) => [t.id, t]));

        const removed: CosmicLedTrade[] = [];
        for (const [id, trade] of dedupe.prevOpenById) {
          if (!currentOpen.has(id)) {
            removed.push(trade);
          }
        }

        if (removed.length > 0) {
          await processRemovedCosmicPositions(prisma, strategy, removed);
        }

        dedupe.prevOpenById = currentOpen;

        const latest = pickLatestTrade(scraped);

        if (!latest) {
          continue;
        }

        if (dedupe.lastId === undefined) {
          dedupe.lastId = latest.id;
          continue;
        }
        if (latest.id === dedupe.lastId) {
          continue;
        }

        try {
          await processNewCosmicTrade(prisma, strategy, latest);
        } catch (err) {
          console.error(
            `[tradeEngine] strategy ${strategy.id} copy failed:`,
            err,
          );
        }

        dedupe.lastId = latest.id;
      }
    } catch (err) {
      console.error("[tradeEngine] loop iteration failed:", err);
    }

    await sleep(randomPollMs());
  }
}

/**
 * Polls each subscribed strategy’s Cosmic account via headless browser login (see `cosmicBrowserScraper.ts`
 * and `COSMIC_SCRAPER_*` env vars), maps symbols to Delta per `COSMIC_TO_DELTA_SYMBOL`, and mirrors trades for subscribers on Delta Exchange.
 */
export function startTradeEngine(prisma: PrismaClient): () => void {
  const cancelled = { value: false };
  const dedupeByStrategy = new Map<string, StrategyDedupe>();

  void runEngineLoop(prisma, cancelled, dedupeByStrategy);

  return () => {
    cancelled.value = true;
  };
}
