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

import type { HTTPResponse, Page } from "puppeteer";
import vanillaPuppeteer from "puppeteer";
import { addExtra } from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

/** Puppeteer ≥24 typings omit legacy APIs expected by puppeteer-extra's VanillaPuppeteer shim. */
const puppeteer = addExtra(
  vanillaPuppeteer as unknown as Parameters<typeof addExtra>[0],
);
puppeteer.use(StealthPlugin());

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

/**
 * Returns JSON blobs captured during navigation / optional in-page fetch.
 * Caller merges with {@link parseCosmicPositionsPayload}.
 */
export async function scrapeCosmicPositionsData(
  cosmicEmail: string,
  cosmicPassword: string,
): Promise<unknown[]> {
  const email = cosmicEmail.trim();
  const password = cosmicPassword.trim();
  const loginUrl = process.env.COSMIC_SCRAPER_LOGIN_URL?.trim();

  if (!loginUrl) {
    console.warn(
      "[cosmic-scraper] COSMIC_SCRAPER_LOGIN_URL is not set — cannot scrape Cosmic positions.",
    );
    return [];
  }
  if (!email || !password) {
    console.warn(
      "[cosmic-scraper] Strategy is missing cosmicEmail or cosmicPassword — skip scrape.",
    );
    return [];
  }

  const capturedJson: unknown[] = [];
  const filter =
    process.env.COSMIC_SCRAPER_RESPONSE_FILTER?.trim().toLowerCase() ||
    "position";

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1365, height: 900 });

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
      'input[type="email"],input[name="email"],input[name="username"],input[name="Email"],#email';
    const passwordSelectors =
      process.env.COSMIC_SCRAPER_PASSWORD_SELECTOR?.trim() ??
      'input[type="password"],input[name="password"],#password';
    const submitSelectors =
      process.env.COSMIC_SCRAPER_SUBMIT_SELECTOR?.trim() ??
      'button[type="submit"],input[type="submit"],button.login,[data-testid="login-button"]';

    const filledEmail = await tryFillInput(page, emailSelectors, email);
    const filledPass = await tryFillInput(page, passwordSelectors, password);
    if (!filledEmail || !filledPass) {
      console.warn(
        "[cosmic-scraper] Could not locate email/password inputs — check COSMIC_SCRAPER_*_SELECTOR env vars.",
      );
      return [];
    }

    await Promise.all([
      page
        .waitForNavigation({
          waitUntil: "networkidle2",
          timeout: 120_000,
        })
        .catch(() => {}),
      tryClick(page, submitSelectors),
    ]);

    await new Promise((r) => setTimeout(r, 1500));

    const postLogin = process.env.COSMIC_SCRAPER_POST_LOGIN_URL?.trim();
    if (postLogin) {
      await page.goto(postLogin, {
        waitUntil: "networkidle2",
        timeout: 120_000,
      });
      await new Promise((r) => setTimeout(r, 2000));
    }

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

    return capturedJson;
  } catch (err) {
    console.error(
      "[cosmic-scraper] Browser scrape failed:",
      err instanceof Error ? err.message : err,
    );
    return [];
  } finally {
    await browser.close();
  }
}
