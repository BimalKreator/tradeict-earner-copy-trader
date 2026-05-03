import type { Page } from "puppeteer";

/**
 * Escaped selectors for Puppeteer `waitForSelector` only — parsing uses plain
 * `div.bg-table-row` + innerText line scans (no Tailwind arbitrary-class selectors).
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
 * Resilient Cosmic `/portfolio` parse: `bg-table-row` + innerText lines + regex.
 * Delta mapping (`ETHUSD` → `ETHUSDT`) runs later in `parseCosmicPositionsPayload`.
 */
export async function extractCosmicPortfolioDom(
  page: Page,
): Promise<PortfolioDomExtract> {
  try {
    return await page.evaluate(() => {
      try {
        function parseNum(raw: string): number {
          const n = Number.parseFloat(raw.replace(/[^0-9.-]/g, ""));
          return Number.isFinite(n) ? n : 0;
        }

        /** Wallet: label row then value (Cosmic wallet card). */
        let walletTotalBalance: string | null = null;
        const balanceDiv = Array.from(
          document.querySelectorAll("div.text-xs"),
        ).find((d) =>
          ((d as HTMLElement).innerText ?? "").includes("Total Balance"),
        );
        if (balanceDiv?.nextElementSibling) {
          walletTotalBalance = (
            balanceDiv.nextElementSibling.textContent ?? ""
          )
            .replace(/\s+/g, " ")
            .trim();
        }
        if (!walletTotalBalance) {
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
        }

        const rows = Array.from(document.querySelectorAll("div.bg-table-row"));
        const positions: Record<string, unknown>[] = [];

        const skipSymbols = new Set([
          "BUY",
          "SELL",
          "LONG",
          "SHORT",
          "SIZE",
          "PNL",
          "CLOSE",
          "REVERSE",
          "UNKNOWN",
        ]);

        for (const row of rows) {
          const text = (row as HTMLElement).innerText ?? "";
          if (!text.includes("Size") || !text.includes("Avg Price")) continue;

          let symbol = "UNKNOWN";
          const img = row.querySelector("img[alt]");
          if (img?.getAttribute("alt")?.trim()) {
            symbol = img.getAttribute("alt")!.trim();
          } else {
            const ins = text.match(
              /\b([A-Z][A-Z0-9]{2,}(?:USD|USDT|PERP))\b/,
            );
            if (ins) {
              symbol = ins[1]!;
            } else {
              const loose = text.match(/\b([A-Z]{3,12})\b/g);
              if (loose) {
                for (const cand of loose) {
                  if (!skipSymbols.has(cand)) {
                    symbol = cand;
                    break;
                  }
                }
              }
            }
          }

          const side =
            text.includes("BUY") || text.includes("LONG") ? "BUY" : "SELL";

          let size = 0;
          let entryPrice = 0;
          let unrealizedPnlNum = 0;

          const lines = text
            .split(/\n/)
            .map((l) => l.trim())
            .filter((l) => l.length > 0);

          for (let i = 0; i < lines.length; i++) {
            if (lines[i] === "Size" && i > 0) {
              size = parseNum(lines[i - 1]!);
            }
            if (lines[i] === "Avg Price" && i > 0) {
              entryPrice = parseNum(lines[i - 1]!);
            }
            if (lines[i] === "PNL" && i > 0) {
              unrealizedPnlNum = parseNum(lines[i - 1]!);
            }
          }

          let takeProfit: number | null = null;
          let stopLoss: number | null = null;
          const tpMatch = text.match(/TP:\s*\$?([\d.,]+)/i);
          const slMatch = text.match(/SL:\s*\$?([\d.,]+)/i);
          if (tpMatch) {
            const n = Number.parseFloat(tpMatch[1]!.replace(/,/g, ""));
            if (Number.isFinite(n)) takeProfit = n;
          }
          if (slMatch) {
            const n = Number.parseFloat(slMatch[1]!.replace(/,/g, ""));
            if (Number.isFinite(n)) stopLoss = n;
          }

          if (symbol !== "UNKNOWN" && size > 0) {
            const rowObj: Record<string, unknown> = {
              symbol,
              side,
              size: Math.abs(size),
              entryPrice: entryPrice > 0 ? entryPrice : 0,
              stopLoss,
              takeProfit,
              openedAt: null as string | null,
            };
            if (unrealizedPnlNum !== 0) {
              rowObj.unrealizedPnl = unrealizedPnlNum;
            }
            positions.push(rowObj);
          }
        }

        return {
          walletTotalBalance,
          positions,
          domRowsMatched: rows.length,
        };
      } catch (error) {
        return {
          walletTotalBalance: null,
          positions: [],
          domRowsMatched: 0,
          extractError:
            error instanceof Error ? error.message : String(error),
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
