import type { Page } from "puppeteer";

/**
 * Escaped selectors for Puppeteer `waitForSelector` only — DOM parsing does not use these
 * (avoids querySelector issues with Tailwind arbitrary classes like `grid-cols-[…]`).
 */
export const COSMIC_PORTFOLIO_ROW_GRID_SELECTOR =
  ".grid-cols-\\[1\\.5fr_1fr_1fr_1fr_1fr_1fr_1fr_auto\\]";

export const COSMIC_PORTFOLIO_ROW_GRID_SELECTOR_FALLBACK =
  '[class*="1.5fr_1fr_1fr_1fr_1fr_1fr_1fr_auto"]';

export const COSMIC_PORTFOLIO_ROW_BG_FALLBACK =
  'div.bg-table-row[class*="1.5fr_1fr_1fr_1fr_1fr_1fr_1fr_auto"]';

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
export async function extractCosmicPortfolioDom(
  page: Page,
): Promise<PortfolioDomExtract> {
  try {
    return await page.evaluate(() => {
      function parseFloatClean(raw: string): number {
        const n = Number.parseFloat(raw.replace(/[^0-9.-]/g, ""));
        return Number.isFinite(n) ? n : 0;
      }

      function rowInnerText(row: Element): string {
        return (row as HTMLElement).innerText ?? "";
      }

      try {
        let walletTotalBalance: string | null = null;
        const pnlValueEls = Array.from(
          document.querySelectorAll(".text-pnl-value"),
        );
        for (const el of pnlValueEls) {
          let scan: Element | null = el;
          for (let d = 0; d < 8 && scan; d++) {
            const scanText = (scan.textContent ?? "")
              .replace(/\s+/g, " ")
              .trim();
            if (/total\s*balance/i.test(scanText)) {
              walletTotalBalance = (el.textContent ?? "")
                .replace(/\s+/g, " ")
                .trim();
              break;
            }
            scan = scan.parentElement;
          }
          if (walletTotalBalance) break;
        }
        if (!walletTotalBalance && pnlValueEls[0]) {
          walletTotalBalance = (pnlValueEls[0].textContent ?? "")
            .replace(/\s+/g, " ")
            .trim();
        }

        const rows = Array.from(document.querySelectorAll("div.bg-table-row"));
        const positions: Record<string, unknown>[] = [];

        const instrumentSpanRe =
          /^[A-Z][A-Z0-9]{2,}(USD|USDT|PERP)$/i;

        for (const row of rows) {
          const rowText = rowInnerText(row);
          if (!rowText.includes("Size") || !rowText.includes("Avg Price")) {
            continue;
          }

          let symbol = "";
          let side = "";

          const img = row.querySelector("img[alt]");
          if (img && img.getAttribute("alt")) {
            symbol = (img.getAttribute("alt") ?? "").trim();
          } else {
            const symSpan = Array.from(row.querySelectorAll("span")).find(
              (s) => {
                const t = (s.innerText ?? "").trim().replace(/\s+/g, "");
                return instrumentSpanRe.test(t);
              },
            );
            if (symSpan) symbol = symSpan.innerText.trim().replace(/\s+/g, "");
          }

          if (rowText.includes("BUY") || rowText.includes("LONG")) side = "BUY";
          else if (rowText.includes("SELL") || rowText.includes("SHORT"))
            side = "SELL";

          let size = 0;
          let entryPrice = 0;

          const sizeSpan = Array.from(row.querySelectorAll("span")).find(
            (s) => (s.innerText ?? "").trim() === "Size",
          );
          if (sizeSpan?.previousElementSibling) {
            size = parseFloatClean(
              sizeSpan.previousElementSibling.textContent ?? "",
            );
          }

          const priceSpan = Array.from(row.querySelectorAll("span")).find(
            (s) => (s.innerText ?? "").trim() === "Avg Price",
          );
          if (priceSpan?.previousElementSibling) {
            entryPrice = parseFloatClean(
              priceSpan.previousElementSibling.textContent ?? "",
            );
          }

          let takeProfit: number | null = null;
          let stopLoss: number | null = null;
          const tpMatch = rowText.match(/TP:\s*\$?([\d.,]+)/i);
          const slMatch = rowText.match(/SL:\s*\$?([\d.,]+)/i);
          if (tpMatch) {
            const n = Number.parseFloat(tpMatch[1]!.replace(/,/g, ""));
            if (Number.isFinite(n)) takeProfit = n;
          }
          if (slMatch) {
            const n = Number.parseFloat(slMatch[1]!.replace(/,/g, ""));
            if (Number.isFinite(n)) stopLoss = n;
          }

          const pnlEl = row.querySelector(
            ".text-pnl-positive, .text-pnl-negative",
          );
          const unrealizedPnl = pnlEl
            ? (pnlEl.textContent ?? "").replace(/\s+/g, " ").trim()
            : "";

          if (symbol && side && size > 0) {
            const rowObj: Record<string, unknown> = {
              symbol,
              side,
              size: Math.abs(size),
              entryPrice:
                entryPrice > 0 ? entryPrice : 0,
              stopLoss,
              takeProfit,
              openedAt: null as string | null,
            };
            if (unrealizedPnl) rowObj.unrealizedPnl = unrealizedPnl;
            positions.push(rowObj);
          }
        }

        return {
          walletTotalBalance,
          positions,
          domRowsMatched: rows.length,
        };
      } catch (e) {
        const msg =
          e instanceof Error
            ? e.message
            : typeof e === "string"
              ? e
              : String(e);
        return {
          walletTotalBalance: null,
          positions: [],
          domRowsMatched: 0,
          extractError: msg,
        };
      }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[cosmic-portfolio-dom] page.evaluate rejected:", msg);
    return {
      walletTotalBalance: null,
      positions: [],
      domRowsMatched: 0,
      extractError: msg,
    };
  }
}
