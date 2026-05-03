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
export type AdminStrategyLiveSection = {
    strategyId: string;
    strategyTitle: string;
    groups: AdminCosmicGroupRow[];
};
export declare function getUserLiveTradeRows(prisma: PrismaClient, userId: string): Promise<UserLiveTradeRow[]>;
export declare function getAdminGroupedLiveTrades(prisma: PrismaClient): Promise<AdminStrategyLiveSection[]>;
//# sourceMappingURL=liveTradesService.d.ts.map