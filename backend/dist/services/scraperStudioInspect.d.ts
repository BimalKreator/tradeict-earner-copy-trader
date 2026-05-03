export type ScraperStudioInspectElement = {
    x: number;
    y: number;
    width: number;
    height: number;
    text: string;
    selector: string;
};
export type ScraperStudioInspectResult = {
    screenshotBase64: string;
    elements: ScraperStudioInspectElement[];
    /** Document pixel size used for screenshot + overlay alignment */
    captureWidth: number;
    captureHeight: number;
};
/**
 * Admin Visual Scraper Studio: navigate (optional Cosmic-style login), collect visible
 * div/span/button geometry + CSS path + full-page PNG.
 */
export declare function runScraperStudioInspect(args: {
    url: string;
    email: string;
    password: string;
}): Promise<ScraperStudioInspectResult>;
//# sourceMappingURL=scraperStudioInspect.d.ts.map