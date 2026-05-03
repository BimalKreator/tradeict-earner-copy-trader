import type { CosmicLedTrade } from "./cosmicPositionsParse.js";
import { parseCosmicPositionsPayload } from "./cosmicPositionsParse.js";
import { scrapeCosmicPositionsData } from "./cosmicBrowserScraper.js";

export type { CosmicLedTrade } from "./cosmicPositionsParse.js";
export { buildCosmicTradeId, parseCosmicPositionsPayload } from "./cosmicPositionsParse.js";

/**
 * Logs into Cosmic via headless browser (see `cosmicBrowserScraper.ts` + env vars),
 * collects position JSON, maps symbols to Delta perpetuals, and returns led trades.
 */
export async function fetchCosmicOpenPositions(
  cosmicEmail: string,
  cosmicPassword: string,
): Promise<CosmicLedTrade[]> {
  const chunks = await scrapeCosmicPositionsData(
    cosmicEmail.trim(),
    cosmicPassword.trim(),
  );
  const byId = new Map<string, CosmicLedTrade>();
  for (const chunk of chunks) {
    for (const t of parseCosmicPositionsPayload(chunk)) {
      byId.set(t.id, t);
    }
  }
  return [...byId.values()];
}
