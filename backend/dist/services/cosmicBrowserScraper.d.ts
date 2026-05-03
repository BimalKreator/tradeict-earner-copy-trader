/**
 * Headless browser login to Cosmic.trade (or URL from env) and collects JSON + portfolio DOM.
 *
 * Configure via environment:
 * - COSMIC_SCRAPER_LOGIN_URL — full login page URL (required for scraping).
 * - COSMIC_SCRAPER_PORTFOLIO_URL — optional; defaults to https://app.cosmic.trade/portfolio after login.
 * - COSMIC_SCRAPER_POST_LOGIN_URL — optional intermediate URL before portfolio (rare).
 * - COSMIC_SCRAPER_EMAIL_SELECTOR — comma-separated CSS selectors (first match wins).
 * - COSMIC_SCRAPER_PASSWORD_SELECTOR — comma-separated CSS selectors.
 * - COSMIC_SCRAPER_SUBMIT_SELECTOR — comma-separated CSS selectors for login button/form submit.
 *
 * Optional strategy `scraperMappings` (Scraper Studio): single-selector slots
 * `login_email` / `Login email`, `login_password` / `Login password`, `login_submit` / `Login submit`
 * override the env CSV lists when present and the selector matches; otherwise env defaults apply.
 * - COSMIC_SCRAPER_RESPONSE_FILTER — substring to match JSON XHR URLs (default: "position").
 * - COSMIC_SCRAPER_POSITIONS_FETCH_PATH — optional relative path fetched in-page after portfolio load.
 *
 * After login the scraper navigates to the portfolio page, waits for the Cosmic grid
 * `.grid-cols-[1.5fr_1fr_1fr_1fr_1fr_1fr_1fr_auto]` (30s), parses rows via `cosmicPortfolioDomExtract.ts`,
 * then captures a screenshot when `options.captureScreenshot` is true (admin probe sets this when COSMIC_SCRAPER_PROBE_SCREENSHOT is enabled).
 */
import type { Browser, Page } from "puppeteer";
export type CosmicScrapeOptions = {
    /** Capture viewport JPEG after portfolio grid is visible (admin probe). */
    captureScreenshot?: boolean;
    /** Per-strategy CSS slots from Scraper Studio (`symbol`, `size`, `position_row`, …). */
    scraperMappings?: Record<string, string> | null;
};
export type CosmicScrapeMeta = {
    domRowsMatched: number;
    domPositionsParsed: number;
    walletBalanceDom: string | null;
    payloadChunkCount: number;
    /** In-page evaluate failed or threw (see logs). */
    extractError?: string;
    /** Entire browser scrape threw before finishing (launch/login/goto). */
    scrapeAbortedReason?: string;
};
export type CosmicScrapeResult = {
    payloads: unknown[];
    screenshotBase64?: string;
    scrapeMeta?: CosmicScrapeMeta;
};
/** Same Chromium launch flags as position scraping (stealth + sandbox overrides). */
export declare function launchCosmicStealthBrowser(): Promise<Browser>;
/**
 * Fills email/password and submits using `COSMIC_SCRAPER_*_SELECTOR` env (Cosmic defaults).
 * Call after navigating to a login page that matches those selectors.
 */
export declare function submitCosmicLoginFormIfPresent(page: Page, email: string, password: string): Promise<boolean>;
/**
 * Scraper Studio / Cosmic: wait for `#username` & `#password`, fill, submit,
 * `networkidle2` navigation, then open `targetUrl` (e.g. portfolio) before DOM capture.
 */
export declare function performCosmicInspectLogin(page: Page, email: string, password: string, targetUrl: string): Promise<void>;
/**
 * Returns JSON blobs captured during navigation / optional in-page fetch,
 * plus DOM-parsed positions from the portfolio grid.
 */
export declare function scrapeCosmicPositionsData(cosmicEmail: string, cosmicPassword: string, options?: CosmicScrapeOptions): Promise<CosmicScrapeResult>;
//# sourceMappingURL=cosmicBrowserScraper.d.ts.map