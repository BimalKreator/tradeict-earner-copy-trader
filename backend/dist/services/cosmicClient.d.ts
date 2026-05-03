import type { TradeSide } from "./exchangeService.js";
export interface CosmicLedTrade {
    id: string;
    /** Symbol as returned by Cosmic (e.g. ETHUSD, ETH/USD) */
    cosmicSymbol: string;
    /** Delta Exchange / ccxt market id (e.g. ETHUSDT) */
    deltaSymbol: string;
    side: TradeSide;
    size: number;
    entryPrice: number;
}
/**
 * Build a stable id for deduplication (Cosmic side, before Delta mapping).
 */
export declare function buildCosmicTradeId(parts: {
    cosmicSymbol: string;
    side: string;
    entryPrice: number;
    size: number;
}): string;
/**
 * GET open positions for the linked Cosmic account.
 * Set `COSMIC_POSITIONS_HTTP_URL` to the full URL (e.g. https://api.cosmic.trade/v1/positions).
 * The response is parsed flexibly; adjust env or extend `extractPositionRows` if the payload differs.
 */
export declare function fetchCosmicOpenPositions(apiKey: string, apiSecret: string): Promise<CosmicLedTrade[]>;
//# sourceMappingURL=cosmicClient.d.ts.map