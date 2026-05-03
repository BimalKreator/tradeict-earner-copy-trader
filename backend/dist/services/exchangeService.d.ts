export type TradeSide = "BUY" | "SELL";
export interface ExecuteTradeResult {
    success: boolean;
    orderId?: string;
    raw?: unknown;
    error?: string;
}
/**
 * Decrypts stored Delta Exchange credentials and submits a market order.
 */
export declare function executeTrade(encryptedApiKey: string, encryptedApiSecret: string, symbol: string, side: TradeSide, size: number): Promise<ExecuteTradeResult>;
/**
 * Public market data for slippage checks (no API keys required).
 */
export declare function fetchDeltaTicker(symbol: string): Promise<{
    last?: number;
}>;
//# sourceMappingURL=exchangeService.d.ts.map