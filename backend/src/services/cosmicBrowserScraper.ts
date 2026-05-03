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
 * - COSMIC_SCRAPER_RESPONSE_FILTER — substring to match JSON XHR URLs (default: "position").
 * - COSMIC_SCRAPER_POSITIONS_FETCH_PATH — optional relative path fetched in-page after portfolio load.
 *
 * After login the scraper navigates to the portfolio page, waits for the Cosmic grid
 * `.grid-cols-[1.5fr_1fr_1fr_1fr_1fr_1fr_1fr_auto]` (30s), parses rows via `cosmicPortfolioDomExtract.ts`,
 * then captures a screenshot when `options.captureScreenshot` is true (admin probe sets this when COSMIC_SCRAPER_PROBE_SCREENSHOT is enabled).
 */

import type { Browser, HTTPResponse, Page } from "puppeteer";
import vanillaPuppeteer from "puppeteer";
import { addExtra } from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import {
  COSMIC_PORTFOLIO_ROW_BG_FALLBACK,
  COSMIC_PORTFOLIO_ROW_GRID_SELECTOR,
  COSMIC_PORTFOLIO_ROW_GRID_SELECTOR_FALLBACK,
  extractCosmicPortfolioDom,
} from "./cosmicPortfolioDomExtract.js";

/** Puppeteer ≥24 typings omit legacy APIs expected by puppeteer-extra's VanillaPuppeteer shim. */
const puppeteer = addExtra(
  vanillaPuppeteer as unknown as Parameters<typeof addExtra>[0],
);
puppeteer.use(StealthPlugin());

const DEFAULT_PORTFOLIO_URL = "https://app.cosmic.trade/portfolio";

const POSITION_ROW_SELECTORS = [
  COSMIC_PORTFOLIO_ROW_GRID_SELECTOR,
  COSMIC_PORTFOLIO_ROW_GRID_SELECTOR_FALLBACK,
  COSMIC_PORTFOLIO_ROW_BG_FALLBACK,
] as const;

/** Scroll so lazy-mounted portfolio rows can render (Cosmic / Next.js). */
async function settlePortfolioDom(page: Page): Promise<void> {
  await page.evaluate(() => {
    const h = Math.max(
      document.body?.scrollHeight ?? 0,
      document.documentElement?.scrollHeight ?? 0,
    );
    window.scrollTo(0, h);
  });
  await new Promise((r) => setTimeout(r, 1500));
}

async function waitForPortfolioPositionGrid(page: Page): Promise<void> {
  let lastErr: unknown;
  for (const sel of POSITION_ROW_SELECTORS) {
    try {
      await page.waitForSelector(sel, { visible: true, timeout: 25_000 });
      return;
    } catch (e1) {
      lastErr = e1;
      try {
        await page.waitForSelector(sel, { timeout: 10_000 });
        return;
      } catch (e2) {
        lastErr = e2;
      }
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(String(lastErr ?? "portfolio row selectors timed out"));
}

export type CosmicScrapeOptions = {
  /** Capture viewport JPEG after portfolio grid is visible (admin probe). */
  captureScreenshot?: boolean;
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

async function tryFillInput(
  page: Page,
  selectorsCsv: string,
  value: string,
): Promise<boolean> {
  const selectors = selectorsCsv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const sel of selectors) {
    try {
      const h = await page.$(sel);
      if (h) {
        await h.click({ clickCount: 3 });
        await h.type(value, { delay: 12 });
        await h.dispose();
        return true;
      }
    } catch {
      /* try next */
    }
  }
  return false;
}

async function tryClick(
  page: Page,
  selectorsCsv: string,
): Promise<boolean> {
  const selectors = selectorsCsv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const sel of selectors) {
    try {
      const h = await page.$(sel);
      if (h) {
        await h.click();
        await h.dispose();
        return true;
      }
    } catch {
      /* try next */
    }
  }
  return false;
}

/** Same Chromium launch flags as position scraping (stealth + sandbox overrides). */
export async function launchCosmicStealthBrowser(): Promise<Browser> {
  return puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  });
}

/**
 * Fills email/password and submits using `COSMIC_SCRAPER_*_SELECTOR` env (Cosmic defaults).
 * Call after navigating to a login page that matches those selectors.
 */
export async function submitCosmicLoginFormIfPresent(
  page: Page,
  email: string,
  password: string,
): Promise<boolean> {
  const e = email.trim();
  const p = password.trim();
  if (!e || !p) return false;

  const emailSelectors =
    process.env.COSMIC_SCRAPER_EMAIL_SELECTOR?.trim() ??
    '#username,input[name="username"],input[type="email"],input[name="email"],input[name="Email"],#email';
  const passwordSelectors =
    process.env.COSMIC_SCRAPER_PASSWORD_SELECTOR?.trim() ??
    '#password,input[type="password"],input[name="password"]';
  const submitSelectors =
    process.env.COSMIC_SCRAPER_SUBMIT_SELECTOR?.trim() ??
    'button[type="submit"],input[type="submit"],button.login,[data-testid="login-button"]';

  const filledEmail = await tryFillInput(page, emailSelectors, e);
  const filledPass = await tryFillInput(page, passwordSelectors, p);
  if (!filledEmail || !filledPass) return false;

  await Promise.all([
    page
      .waitForNavigation({
        waitUntil: "domcontentloaded",
        timeout: 120_000,
      })
      .catch(() => {}),
    tryClick(page, submitSelectors),
  ]);
  await new Promise((r) => setTimeout(r, 2500));
  return true;
}

/**
 * Returns JSON blobs captured during navigation / optional in-page fetch,
 * plus DOM-parsed positions from the portfolio grid.
 */
export async function scrapeCosmicPositionsData(
  cosmicEmail: string,
  cosmicPassword: string,
  options?: CosmicScrapeOptions,
): Promise<CosmicScrapeResult> {
  const email = cosmicEmail.trim();
  const password = cosmicPassword.trim();
  const loginUrl = process.env.COSMIC_SCRAPER_LOGIN_URL?.trim();

  if (!loginUrl) {
    console.warn(
      "[cosmic-scraper] COSMIC_SCRAPER_LOGIN_URL is not set — cannot scrape Cosmic positions.",
    );
    return { payloads: [] };
  }
  if (!email || !password) {
    console.warn(
      "[cosmic-scraper] Strategy is missing cosmicEmail or cosmicPassword — skip scrape.",
    );
    return { payloads: [] };
  }

  const capturedJson: unknown[] = [];
  const filter =
    process.env.COSMIC_SCRAPER_RESPONSE_FILTER?.trim().toLowerCase() ||
    "position";

  const browser = await launchCosmicStealthBrowser();

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });

    page.on("response", async (response: HTTPResponse) => {
      try {
        const url = response.url().toLowerCase();
        if (!url.includes(filter)) return;
        const ct = (response.headers()["content-type"] ?? "").toLowerCase();
        if (!ct.includes("application/json")) return;
        const body = (await response.json()) as unknown;
        capturedJson.push(body);
      } catch {
        /* non-JSON or unreadable */
      }
    });

    await page.goto(loginUrl, {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });

    const emailSelectors =
      process.env.COSMIC_SCRAPER_EMAIL_SELECTOR?.trim() ??
      '#username,input[name="username"],input[type="email"],input[name="email"],input[name="Email"],#email';
    const passwordSelectors =
      process.env.COSMIC_SCRAPER_PASSWORD_SELECTOR?.trim() ??
      '#password,input[type="password"],input[name="password"]';
    const submitSelectors =
      process.env.COSMIC_SCRAPER_SUBMIT_SELECTOR?.trim() ??
      'button[type="submit"],input[type="submit"],button.login,[data-testid="login-button"]';

    const filledEmail = await tryFillInput(page, emailSelectors, email);
    const filledPass = await tryFillInput(page, passwordSelectors, password);
    if (!filledEmail || !filledPass) {
      console.warn(
        "[cosmic-scraper] Could not locate email/password inputs — check COSMIC_SCRAPER_*_SELECTOR env vars.",
      );
      return { payloads: [] };
    }

    await Promise.all([
      page
        .waitForNavigation({
          waitUntil: "domcontentloaded",
          timeout: 120_000,
        })
        .catch(() => {}),
      tryClick(page, submitSelectors),
    ]);

    await new Promise((r) => setTimeout(r, 2500));

    const postLogin = process.env.COSMIC_SCRAPER_POST_LOGIN_URL?.trim();
    if (postLogin) {
      await page.goto(postLogin, {
        waitUntil: "domcontentloaded",
        timeout: 120_000,
      });
      await new Promise((r) => setTimeout(r, 1000));
    }

    const portfolioUrl =
      process.env.COSMIC_SCRAPER_PORTFOLIO_URL?.trim() ||
      DEFAULT_PORTFOLIO_URL;
    await page.goto(portfolioUrl, {
      waitUntil: "domcontentloaded",
      timeout: 120_000,
    });

    await settlePortfolioDom(page);

    try {
      await waitForPortfolioPositionGrid(page);
    } catch (err) {
      console.warn(
        "[cosmic-scraper] Portfolio grid selector timed out — continuing anyway (DOM may still parse):",
        err instanceof Error ? err.message : err,
      );
      await settlePortfolioDom(page);
      await new Promise((r) => setTimeout(r, 4000));
    }

    await settlePortfolioDom(page);
    await new Promise((r) => setTimeout(r, 500));

    const fetchPath = process.env.COSMIC_SCRAPER_POSITIONS_FETCH_PATH?.trim();
    if (fetchPath) {
      try {
        const fetched = await page.evaluate(async (pathArg: string) => {
          const origin = window.location.origin;
          const url = pathArg.startsWith("http")
            ? pathArg
            : `${origin}${pathArg.startsWith("/") ? pathArg : `/${pathArg}`}`;
          const r = await fetch(url, {
            credentials: "include",
            headers: { Accept: "application/json" },
          });
          if (!r.ok) return null;
          return r.json();
        }, fetchPath);
        if (fetched != null) capturedJson.push(fetched);
      } catch (err) {
        console.warn(
          "[cosmic-scraper] In-page positions fetch failed:",
          err instanceof Error ? err.message : err,
        );
      }
    }

    let scrapeMeta: CosmicScrapeMeta | undefined;
    try {
      const dom = await extractCosmicPortfolioDom(page);
      capturedJson.push({
        walletTotalBalance: dom.walletTotalBalance,
        positions: dom.positions,
      });
      scrapeMeta = {
        domRowsMatched: dom.domRowsMatched,
        domPositionsParsed: dom.positions.length,
        walletBalanceDom: dom.walletTotalBalance,
        payloadChunkCount: capturedJson.length,
      };
      if (dom.extractError !== undefined && dom.extractError.length > 0) {
        scrapeMeta.extractError = dom.extractError;
      }
    } catch (err) {
      console.warn(
        "[cosmic-scraper] Portfolio DOM extract failed:",
        err instanceof Error ? err.message : err,
      );
      scrapeMeta = {
        domRowsMatched: 0,
        domPositionsParsed: 0,
        walletBalanceDom: null,
        payloadChunkCount: capturedJson.length,
        extractError:
          err instanceof Error ? err.message : String(err),
      };
    }

    const out: CosmicScrapeResult = { payloads: capturedJson };
    if (scrapeMeta !== undefined) {
      out.scrapeMeta = scrapeMeta;
    }

    if (options?.captureScreenshot) {
      try {
        const shot = await page.screenshot({
          type: "jpeg",
          quality: 68,
          encoding: "base64",
        });
        if (typeof shot === "string" && shot.length > 0) {
          out.screenshotBase64 = shot;
        }
      } catch {
        /* ignore */
      }
    }

    return out;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error("[cosmic-scraper] Browser scrape failed:", reason);
    return {
      payloads: [],
      scrapeMeta: {
        domRowsMatched: 0,
        domPositionsParsed: 0,
        walletBalanceDom: null,
        payloadChunkCount: 0,
        scrapeAbortedReason: reason,
      },
    };
  } finally {
    await browser.close();
  }
}
