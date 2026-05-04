import ccxt from "ccxt";
/**
 * Single factory for `ccxt.delta`: swap markets, rate limit, and **Delta India** REST URLs
 * (required for India API keys and tickers).
 */
export declare function initializeDeltaClient(apiKey?: string, secret?: string): InstanceType<typeof ccxt.delta>;
export type TradeSide = "BUY" | "SELL";
export interface ExecuteTradeResult {
    success: boolean;
    orderId?: string;
    raw?: unknown;
    error?: string;
}
/** Normalized open perpetual position from Delta (for dashboards). */
export interface DeltaLivePosition {
    /** CCXT unified symbol (Delta India linear perps: e.g. ETH/USD:USD) */
    symbol: string;
    /** Compact ticker-style id aligned with copy-trade symbols (e.g. ETHUSDT). */
    symbolKey: string;
    side: TradeSide;
    contracts: number;
    entryPrice: number | null;
    markPrice: number | null;
    unrealizedPnl: number | null;
    stopLoss: number | null;
    takeProfit: number | null;
    entryTime: string | null;
}
/**
 * Converts compact keys (e.g. `ETHUSDT`, `ETHUSD`) or partial unified symbols into
 * CCXT swap symbols for **Delta Exchange India** (`api.india.delta.exchange`).
 * India linear perps use `BASE/USD:USD`, not `BASE/USDT:USDT` (those markets do not exist there).
 */
export declare function normalizeDeltaPerpSymbolForCcxt(raw: string): string;
/** Boot-time check: compact key used in Cosmic/copy rows → CCXT symbol on Delta India. */
export declare const DELTA_INDIA_CCXT_SAMPLE_SYMBOL: string;
/**
 * Decrypts stored Delta Exchange credentials and submits a market order.
 */
export declare function executeTrade(encryptedApiKey: string, encryptedApiSecret: string, symbol: string, side: TradeSide, size: number): Promise<ExecuteTradeResult>;
/**
 * Public market data for slippage checks (no API keys required).
 * Uses Delta India via {@link initializeDeltaClient}. Returns `{ last: null }` on any failure
 * (missing market, network, etc.) so callers never throw.
 */
export declare function fetchDeltaTicker(symbol: string): Promise<{
    last: number | null;
}>;
/**
 * Authenticated: fetch non-flat perpetual positions from Delta India (swap).
 */
export declare function fetchDeltaOpenPositions(apiKeyStored: string, apiSecretStored: string): Promise<DeltaLivePosition[]>;
//# sourceMappingURL=exchangeService.d.ts.map