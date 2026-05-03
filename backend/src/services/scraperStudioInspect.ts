import type { Page } from "puppeteer";
import {
  launchCosmicStealthBrowser,
  submitCosmicLoginFormIfPresent,
} from "./cosmicBrowserScraper.js";

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

const MAX_ELEMENTS = 12_000;
const MAX_TEXT_LEN = 500;

function isAllowedHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

async function settlePage(page: Page): Promise<void> {
  await page.evaluate(() => {
    const h = Math.max(
      document.body?.scrollHeight ?? 0,
      document.documentElement?.scrollHeight ?? 0,
    );
    window.scrollTo(0, h);
  });
  await new Promise((r) => setTimeout(r, 1200));
  await page.evaluate(() => window.scrollTo(0, 0));
  await new Promise((r) => setTimeout(r, 600));
}

/**
 * Admin Visual Scraper Studio: navigate (optional Cosmic-style login), collect visible
 * div/span/button geometry + CSS path + full-page PNG.
 */
export async function runScraperStudioInspect(args: {
  url: string;
  email: string;
  password: string;
}): Promise<ScraperStudioInspectResult> {
  const url = args.url.trim();
  if (!isAllowedHttpUrl(url)) {
    throw new Error("url must be a valid http(s) URL");
  }

  const browser = await launchCosmicStealthBrowser();

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 120_000,
    });

    const hasCreds = args.email.trim().length > 0 && args.password.trim().length > 0;
    if (hasCreds) {
      await submitCosmicLoginFormIfPresent(
        page,
        args.email,
        args.password,
      );
    }

    await settlePage(page);

    const captureSize = await page.evaluate(() => ({
      width: Math.max(
        document.documentElement.scrollWidth,
        document.body?.scrollWidth ?? 0,
      ),
      height: Math.max(
        document.documentElement.scrollHeight,
        document.body?.scrollHeight ?? 0,
      ),
    }));

    const elements = await page.evaluate(
      (maxEls: number, maxText: number) => {
        function esc(s: string): string {
          return typeof CSS !== "undefined" && typeof CSS.escape === "function"
            ? CSS.escape(s)
            : s.replace(/([^\w-])/g, "\\$1");
        }

        /** Unique-ish path: `#id` or `tag:nth-of-type(n)` chain from root. */
        function cssPath(el: Element): string {
          const segments: string[] = [];
          let node: Element | null = el;
          const root = document.documentElement;
          while (node && node !== root && node.nodeType === Node.ELEMENT_NODE) {
            const htmlEl = node as HTMLElement;
            const tag = htmlEl.tagName.toLowerCase();
            if (htmlEl.id) {
              segments.unshift(`#${esc(htmlEl.id)}`);
              break;
            }
            const parent = htmlEl.parentElement;
            if (!parent) {
              segments.unshift(tag);
              break;
            }
            const same = [...parent.children].filter(
              (c) => c.tagName === htmlEl.tagName,
            );
            const idx = same.indexOf(htmlEl) + 1;
            segments.unshift(`${tag}:nth-of-type(${idx})`);
            node = parent;
          }
          return segments.join(" > ");
        }

        function visible(el: Element): boolean {
          const htmlEl = el as HTMLElement;
          const rect = htmlEl.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return false;
          const st = window.getComputedStyle(htmlEl);
          if (
            st.display === "none" ||
            st.visibility === "hidden" ||
            Number(st.opacity) === 0
          ) {
            return false;
          }
          return true;
        }

        const out: {
          x: number;
          y: number;
          width: number;
          height: number;
          text: string;
          selector: string;
        }[] = [];

        const nodes = document.querySelectorAll("div, span, button");
        const sx = window.scrollX ?? window.pageXOffset;
        const sy = window.scrollY ?? window.pageYOffset;

        for (let i = 0; i < nodes.length && out.length < maxEls; i++) {
          const el = nodes[i]!;
          if (!visible(el)) continue;
          const rect = el.getBoundingClientRect();
          let text = (el as HTMLElement).innerText ?? "";
          text = text.replace(/\s+/g, " ").trim();
          if (text.length > maxText) {
            text = text.slice(0, maxText) + "…";
          }

          out.push({
            x: rect.left + sx,
            y: rect.top + sy,
            width: rect.width,
            height: rect.height,
            text,
            selector: cssPath(el),
          });
        }

        return out;
      },
      MAX_ELEMENTS,
      MAX_TEXT_LEN,
    );

    const screenshotBase64 = await page.screenshot({
      type: "png",
      fullPage: true,
      encoding: "base64",
    });

    if (typeof screenshotBase64 !== "string" || screenshotBase64.length === 0) {
      throw new Error("screenshot produced empty buffer");
    }

    return {
      screenshotBase64,
      elements,
      captureWidth: Math.max(1, Math.round(captureSize.width)),
      captureHeight: Math.max(1, Math.round(captureSize.height)),
    };
  } finally {
    await browser.close();
  }
}
