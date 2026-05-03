import type { Page } from "puppeteer";
export type PortfolioDomExtract = {
    walletTotalBalance: string | null;
    positions: Record<string, unknown>[];
};
/**
 * Parses Cosmic portfolio DOM (wallet + open positions grid).
 * Selectors align with Cosmic UI: text-pnl-value, font-text pairs, grid rows, TP/SL color tokens.
 */
export declare function extractCosmicPortfolioDom(page: Page): Promise<PortfolioDomExtract>;
//# sourceMappingURL=cosmicPortfolioDomExtract.d.ts.map