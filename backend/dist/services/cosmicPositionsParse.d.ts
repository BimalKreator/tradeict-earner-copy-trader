import type { TradeSide } from "./exchangeService.js";
export interface CosmicLedTrade {
    id: string;
    cosmicSymbol: string;
    deltaSymbol: string;
    side: TradeSide;
    size: number;
    entryPrice: number;
    stopLoss?: number | null;
    takeProfit?: number | null;
    openedAt?: string | null;
}
export declare function buildCosmicTradeId(parts: {
    cosmicSymbol: string;
    side: string;
    entryPrice: number;
    size: number;
}): string;
export declare function parseCosmicPositionsPayload(data: unknown): CosmicLedTrade[];
//# sourceMappingURL=cosmicPositionsParse.d.ts.map