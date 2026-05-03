import { type PrismaClient } from "@prisma/client";
export type LiveTradeRow = {
    entryTime: string | null;
    token: string;
    entryPrice: number | null;
    stopLoss: number | null;
    target: number | null;
    livePnl: number | null;
    markPrice: number | null;
    side: string;
};
export type UserLiveTradeRow = LiveTradeRow & {
    strategyId: string;
    strategyTitle: string;
};
export type AdminFollowerRow = LiveTradeRow & {
    userEmail: string;
};
export type AdminCosmicGroupRow = {
    cosmic: LiveTradeRow;
    followers: AdminFollowerRow[];
};
export type CosmicScrapeDiagnostics = {
    payloadChunkCount: number;
    payloadPositionRows: number;
    tradesAfterDeltaFilter: number;
    domRowsMatched?: number;
    domPositionsParsed?: number;
    walletBalanceDom?: string | null;
    scrapeAbortedReason?: string;
    extractError?: string;
};
export type AdminStrategyLiveSection = {
    strategyId: string;
    strategyTitle: string;
    groups: AdminCosmicGroupRow[];
    /** Why Cosmic rows might be empty (does not prove login succeeded). */
    cosmicMeta: {
        scraperEnvConfigured: boolean;
        credentialsPresent: boolean;
        /** Set when Puppeteer / scrape threw before returning structured meta. */
        fetchException?: string;
        /** Latest headless scrape stats (admin Live trades runs one scrape per load). */
        lastScrape?: CosmicScrapeDiagnostics;
    };
};
export declare function getUserLiveTradeRows(prisma: PrismaClient, userId: string): Promise<UserLiveTradeRow[]>;
export declare function getAdminGroupedLiveTrades(prisma: PrismaClient): Promise<AdminStrategyLiveSection[]>;
//# sourceMappingURL=liveTradesService.d.ts.map