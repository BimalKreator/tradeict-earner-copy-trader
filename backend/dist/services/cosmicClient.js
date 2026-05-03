import { parseCosmicPositionsPayload } from "./cosmicPositionsParse.js";
import { scrapeCosmicPositionsData, } from "./cosmicBrowserScraper.js";
export { buildCosmicTradeId, parseCosmicPositionsPayload } from "./cosmicPositionsParse.js";
/**
 * Logs into Cosmic via headless browser (see `cosmicBrowserScraper.ts` + env vars),
 * collects position JSON, maps symbols to Delta perpetuals, and returns led trades.
 */
function tradesFromPayloads(payloads) {
    const byId = new Map();
    for (const chunk of payloads) {
        for (const t of parseCosmicPositionsPayload(chunk)) {
            byId.set(t.id, t);
        }
    }
    return [...byId.values()];
}
export async function fetchCosmicOpenPositions(cosmicEmail, cosmicPassword) {
    const { payloads } = await scrapeCosmicPositionsData(cosmicEmail.trim(), cosmicPassword.trim());
    return tradesFromPayloads(payloads);
}
/** Admin probe: same scrape plus optional JPEG screenshot of the logged-in viewport. */
export async function probeCosmicOpenPositions(cosmicEmail, cosmicPassword, captureScreenshot) {
    const { payloads, screenshotBase64, scrapeMeta } = await scrapeCosmicPositionsData(cosmicEmail.trim(), cosmicPassword.trim(), captureScreenshot ? { captureScreenshot: true } : undefined);
    const out = {
        trades: tradesFromPayloads(payloads),
    };
    if (screenshotBase64 !== undefined && screenshotBase64.length > 0) {
        out.screenshotBase64 = screenshotBase64;
    }
    if (scrapeMeta !== undefined) {
        out.scrapeMeta = scrapeMeta;
    }
    return out;
}
//# sourceMappingURL=cosmicClient.js.map