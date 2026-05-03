import type { CosmicLedTrade } from "./cosmicPositionsParse.js";
import { parseCosmicPositionsPayload } from "./cosmicPositionsParse.js";
import {
  scrapeCosmicPositionsData,
  type CosmicScrapeMeta,
  type CosmicScrapeOptions,
} from "./cosmicBrowserScraper.js";
import { mergeScraperMappingsJson } from "./cosmicPortfolioDomExtract.js";

export type { CosmicLedTrade } from "./cosmicPositionsParse.js";
export { buildCosmicTradeId, parseCosmicPositionsPayload } from "./cosmicPositionsParse.js";

/**
 * Logs into Cosmic via headless browser (see `cosmicBrowserScraper.ts` + env vars),
 * collects position JSON, maps symbols to Delta perpetuals, and returns led trades.
 */
function buildCosmicScrapeOptions(args: {
  captureScreenshot?: boolean;
  scraperMappingsJson?: unknown;
  /** Legacy JSON column name; merged under `scraperMappings` (primary wins). */
  scraperStudioSelectorsJson?: unknown;
}): CosmicScrapeOptions | undefined {
  const mapped = mergeScraperMappingsJson(
    args.scraperStudioSelectorsJson,
    args.scraperMappingsJson,
  );
  const opts: CosmicScrapeOptions = {};
  if (args.captureScreenshot) opts.captureScreenshot = true;
  if (mapped !== undefined) opts.scraperMappings = mapped;
  return Object.keys(opts).length > 0 ? opts : undefined;
}

function tradesFromPayloads(payloads: unknown[]): CosmicLedTrade[] {
  const byId = new Map<string, CosmicLedTrade>();
  for (const chunk of payloads) {
    for (const t of parseCosmicPositionsPayload(chunk)) {
      byId.set(t.id, t);
    }
  }
  return [...byId.values()];
}

/** Raw position-like rows in payloads before Delta symbol filtering (best-effort). */
function countPayloadPositionRows(payloads: unknown[]): number {
  let n = 0;
  for (const chunk of payloads) {
    if (!chunk || typeof chunk !== "object") continue;
    const list = (chunk as { positions?: unknown }).positions;
    if (Array.isArray(list)) n += list.length;
  }
  return n;
}

/** Same as `fetchCosmicOpenPositions` plus scrape meta for admin diagnostics. */
export async function fetchCosmicOpenPositionsWithMeta(
  cosmicEmail: string,
  cosmicPassword: string,
  scraperMappingsJson?: unknown,
  scraperStudioSelectorsJson?: unknown,
): Promise<{
  trades: CosmicLedTrade[];
  scrapeMeta?: CosmicScrapeMeta;
  payloadChunkCount: number;
  payloadPositionRows: number;
}> {
  const opts = buildCosmicScrapeOptions({
    scraperMappingsJson,
    scraperStudioSelectorsJson,
  });
  const result = await scrapeCosmicPositionsData(
    cosmicEmail.trim(),
    cosmicPassword.trim(),
    opts,
  );
  const trades = tradesFromPayloads(result.payloads);
  const out: {
    trades: CosmicLedTrade[];
    scrapeMeta?: CosmicScrapeMeta;
    payloadChunkCount: number;
    payloadPositionRows: number;
  } = {
    trades,
    payloadChunkCount: result.payloads.length,
    payloadPositionRows: countPayloadPositionRows(result.payloads),
  };
  if (result.scrapeMeta !== undefined) out.scrapeMeta = result.scrapeMeta;
  return out;
}

export async function fetchCosmicOpenPositions(
  cosmicEmail: string,
  cosmicPassword: string,
  scraperMappingsJson?: unknown,
  scraperStudioSelectorsJson?: unknown,
): Promise<CosmicLedTrade[]> {
  const { trades } = await fetchCosmicOpenPositionsWithMeta(
    cosmicEmail,
    cosmicPassword,
    scraperMappingsJson,
    scraperStudioSelectorsJson,
  );
  return trades;
}

/** Admin probe: same scrape plus optional JPEG screenshot of the logged-in viewport. */
export async function probeCosmicOpenPositions(
  cosmicEmail: string,
  cosmicPassword: string,
  captureScreenshot: boolean,
  scraperMappingsJson?: unknown,
  scraperStudioSelectorsJson?: unknown,
): Promise<{
  trades: CosmicLedTrade[];
  screenshotBase64?: string;
  scrapeMeta?: CosmicScrapeMeta;
}> {
  const { payloads, screenshotBase64, scrapeMeta } =
    await scrapeCosmicPositionsData(
      cosmicEmail.trim(),
      cosmicPassword.trim(),
      buildCosmicScrapeOptions({
        captureScreenshot,
        scraperMappingsJson,
        scraperStudioSelectorsJson,
      }),
    );
  const out: {
    trades: CosmicLedTrade[];
    screenshotBase64?: string;
    scrapeMeta?: CosmicScrapeMeta;
  } = {
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
