/**
 * Headless browser login to Cosmic.trade (or URL from env) and collects JSON position payloads.
 *
 * Configure via environment:
 * - COSMIC_SCRAPER_LOGIN_URL — full login page URL (required for scraping).
 * - COSMIC_SCRAPER_POST_LOGIN_URL — optional URL to open after login (positions/dashboard).
 * - COSMIC_SCRAPER_EMAIL_SELECTOR — comma-separated CSS selectors (first match wins).
 * - COSMIC_SCRAPER_PASSWORD_SELECTOR — comma-separated CSS selectors.
 * - COSMIC_SCRAPER_SUBMIT_SELECTOR — comma-separated CSS selectors for login button/form submit.
 * - COSMIC_SCRAPER_RESPONSE_FILTER — substring to match JSON XHR URLs (default: "position").
 * - COSMIC_SCRAPER_POSITIONS_FETCH_PATH — optional relative path e.g. "/api/positions" fetched in-page with credentials after login.
 */
export type CosmicScrapeOptions = {
    /** Capture viewport JPEG (base64) after login flow — for admin “preview” only. */
    captureScreenshot?: boolean;
};
export type CosmicScrapeResult = {
    payloads: unknown[];
    screenshotBase64?: string;
};
/**
 * Returns JSON blobs captured during navigation / optional in-page fetch.
 * Caller merges with {@link parseCosmicPositionsPayload}.
 */
export declare function scrapeCosmicPositionsData(cosmicEmail: string, cosmicPassword: string, options?: CosmicScrapeOptions): Promise<CosmicScrapeResult>;
//# sourceMappingURL=cosmicBrowserScraper.d.ts.map