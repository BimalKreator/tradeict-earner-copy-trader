import type { Page } from "puppeteer";
/** Tailwind arbitrary grid template — Cosmic portfolio position rows. */
export declare const COSMIC_PORTFOLIO_ROW_GRID_SELECTOR = ".grid-cols-\\[1\\.5fr_1fr_1fr_1fr_1fr_1fr_1fr_auto\\]";
/** Fallback when compiled class string differs slightly in DOM. */
export declare const COSMIC_PORTFOLIO_ROW_GRID_SELECTOR_FALLBACK = "[class*=\"1.5fr_1fr_1fr_1fr_1fr_1fr_1fr_auto\"]";
/** Cosmic wraps each position row with `bg-table-row` + arbitrary grid template columns. */
export declare const COSMIC_PORTFOLIO_ROW_BG_FALLBACK = "div.bg-table-row[class*=\"1.5fr_1fr_1fr_1fr_1fr_1fr_1fr_auto\"]";
export type PortfolioDomExtract = {
    walletTotalBalance: string | null;
    positions: Record<string, unknown>[];
};
/**
 * Parses Cosmic `/portfolio` DOM using the canonical grid row class and label/value rules.
 * Caller should navigate to portfolio and `waitForSelector` the grid before invoking.
 */
export declare function extractCosmicPortfolioDom(page: Page): Promise<PortfolioDomExtract>;
//# sourceMappingURL=cosmicPortfolioDomExtract.d.ts.map