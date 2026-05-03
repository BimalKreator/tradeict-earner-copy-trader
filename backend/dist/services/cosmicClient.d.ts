import type { CosmicLedTrade } from "./cosmicPositionsParse.js";
import { type CosmicScrapeMeta } from "./cosmicBrowserScraper.js";
export type { CosmicLedTrade } from "./cosmicPositionsParse.js";
export { buildCosmicTradeId, parseCosmicPositionsPayload } from "./cosmicPositionsParse.js";
export declare function fetchCosmicOpenPositions(cosmicEmail: string, cosmicPassword: string): Promise<CosmicLedTrade[]>;
/** Admin probe: same scrape plus optional JPEG screenshot of the logged-in viewport. */
export declare function probeCosmicOpenPositions(cosmicEmail: string, cosmicPassword: string, captureScreenshot: boolean): Promise<{
    trades: CosmicLedTrade[];
    screenshotBase64?: string;
    scrapeMeta?: CosmicScrapeMeta;
}>;
//# sourceMappingURL=cosmicClient.d.ts.map