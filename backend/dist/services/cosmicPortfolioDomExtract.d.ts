import type { Page } from "puppeteer";
/**
 * Escaped selectors for Puppeteer `waitForSelector` only — parsing uses plain
 * `div.bg-table-row` + innerText line scans (no Tailwind arbitrary-class selectors).
 */
export declare const COSMIC_PORTFOLIO_ROW_GRID_SELECTOR = ".grid-cols-\\[1\\.5fr_1fr_1fr_1fr_1fr_1fr_1fr_auto\\]";
export declare const COSMIC_PORTFOLIO_ROW_GRID_SELECTOR_FALLBACK = "[class*=\"1.5fr_1fr_1fr_1fr_1fr_1fr_1fr_auto\"]";
export declare const COSMIC_PORTFOLIO_ROW_BG_FALLBACK = "div.bg-table-row[class*=\"1.5fr_1fr_1fr_1fr_1fr_1fr_1fr_auto\"]";
export type PortfolioDomExtract = {
    walletTotalBalance: string | null;
    positions: Record<string, unknown>[];
    domRowsMatched: number;
    extractError?: string;
};
/** Normalize Prisma JSON / API payloads into string selectors for `page.evaluate`. */
export declare function coerceScraperMappings(raw: unknown): Record<string, string> | undefined;
/** Later sources override earlier (for `scraperMappings` over legacy `scraperStudioSelectors`). */
export declare function mergeScraperMappingsJson(...sources: unknown[]): Record<string, string> | undefined;
/**
 * Resilient Cosmic `/portfolio` parse: optional per-strategy CSS mappings from Scraper Studio,
 * then `bg-table-row` + innerText lines + regex fallbacks.
 * Delta mapping (`ETHUSD` → `ETHUSDT`) runs later in `parseCosmicPositionsPayload`.
 */
export declare function extractCosmicPortfolioDom(page: Page, scraperMappings?: Record<string, string> | null): Promise<PortfolioDomExtract>;
//# sourceMappingURL=cosmicPortfolioDomExtract.d.ts.map