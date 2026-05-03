import { parseCosmicPositionsPayload } from "./cosmicPositionsParse.js";
import { scrapeCosmicPositionsData } from "./cosmicBrowserScraper.js";
export { buildCosmicTradeId, parseCosmicPositionsPayload } from "./cosmicPositionsParse.js";
/**
 * Logs into Cosmic via headless browser (see `cosmicBrowserScraper.ts` + env vars),
 * collects position JSON, maps symbols to Delta perpetuals, and returns led trades.
 */
export async function fetchCosmicOpenPositions(cosmicEmail, cosmicPassword) {
    const chunks = await scrapeCosmicPositionsData(cosmicEmail.trim(), cosmicPassword.trim());
    const byId = new Map();
    for (const chunk of chunks) {
        for (const t of parseCosmicPositionsPayload(chunk)) {
            byId.set(t.id, t);
        }
    }
    return [...byId.values()];
}
//# sourceMappingURL=cosmicClient.js.map