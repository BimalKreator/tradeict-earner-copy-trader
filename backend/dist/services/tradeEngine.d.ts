import { type PrismaClient } from "@prisma/client";
/**
 * Late-join: after subscribe, mirror each currently open Cosmic position onto Delta for one subscriber.
 * Guarded by `strategy.syncActiveTrades` at the caller.
 */
export declare function lateJoinMirrorOpenPositionsForSubscriber(prisma: PrismaClient, args: {
    strategyId: string;
    userId: string;
}): Promise<void>;
/**
 * Runs {@link lateJoinMirrorOpenPositionsForSubscriber} for every active subscriber.
 * Use when `syncActiveTrades` is turned on for a strategy that already has subscriptions
 * (subscribe-time late-join only runs for new signups).
 */
export declare function lateJoinMirrorForAllActiveSubscribers(prisma: PrismaClient, strategyId: string): Promise<void>;
/**
 * Polls each subscribed strategy’s Cosmic account via headless browser login (see `cosmicBrowserScraper.ts`
 * and `COSMIC_SCRAPER_*` env vars), maps symbols to Delta per `COSMIC_TO_DELTA_SYMBOL`, and mirrors trades for subscribers on Delta Exchange.
 */
export declare function startTradeEngine(prisma: PrismaClient): () => void;
//# sourceMappingURL=tradeEngine.d.ts.map