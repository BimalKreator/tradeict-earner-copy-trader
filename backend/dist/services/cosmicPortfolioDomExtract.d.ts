import type { Page } from "puppeteer";
/**
 * Escaped selectors for Puppeteer `waitForSelector` only — DOM parsing does not use these
 * (avoids querySelector issues with Tailwind arbitrary classes like `grid-cols-[…]`).
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
/**
 * Parses Cosmic `/portfolio` rows via `div.bg-table-row` + innerText / label siblings (no bracket CSS).
 * Delta symbol mapping runs later in `parseCosmicPositionsPayload` / `mapCosmicSymbolToDelta`.
 */
export declare function extractCosmicPortfolioDom(page: Page): Promise<PortfolioDomExtract>;
//# sourceMappingURL=cosmicPortfolioDomExtract.d.ts.map