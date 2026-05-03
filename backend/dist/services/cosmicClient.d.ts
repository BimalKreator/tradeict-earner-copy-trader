import type { CosmicLedTrade } from "./cosmicPositionsParse.js";
export type { CosmicLedTrade } from "./cosmicPositionsParse.js";
export { buildCosmicTradeId, parseCosmicPositionsPayload } from "./cosmicPositionsParse.js";
/**
 * Logs into Cosmic via headless browser (see `cosmicBrowserScraper.ts` + env vars),
 * collects position JSON, maps symbols to Delta perpetuals, and returns led trades.
 */
export declare function fetchCosmicOpenPositions(cosmicEmail: string, cosmicPassword: string): Promise<CosmicLedTrade[]>;
//# sourceMappingURL=cosmicClient.d.ts.map