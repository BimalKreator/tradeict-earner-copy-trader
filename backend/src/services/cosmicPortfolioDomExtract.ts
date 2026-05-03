import type { Page } from "puppeteer";

/** Tailwind arbitrary grid template — Cosmic portfolio position rows. */
export const COSMIC_PORTFOLIO_ROW_GRID_SELECTOR =
  ".grid-cols-\\[1\\.5fr_1fr_1fr_1fr_1fr_1fr_1fr_auto\\]";

/** Fallback when compiled class string differs slightly in DOM. */
export const COSMIC_PORTFOLIO_ROW_GRID_SELECTOR_FALLBACK =
  '[class*="1.5fr_1fr_1fr_1fr_1fr_1fr_1fr_auto"]';

/** Cosmic wraps each position row with `bg-table-row` + arbitrary grid template columns. */
export const COSMIC_PORTFOLIO_ROW_BG_FALLBACK =
  'div.bg-table-row[class*="1.5fr_1fr_1fr_1fr_1fr_1fr_1fr_auto"]';

export type PortfolioDomExtract = {
  walletTotalBalance: string | null;
  positions: Record<string, unknown>[];
  /** Rows matched by selectors before per-field validation (admin diagnostics). */
  domRowsMatched: number;
};

/**
 * Parses Cosmic `/portfolio` DOM using the canonical grid row class and label/value rules.
 * Caller should navigate to portfolio and `waitForSelector` the grid before invoking.
 */
export async function extractCosmicPortfolioDom(
  page: Page,
): Promise<PortfolioDomExtract> {
  return page.evaluate(
    (primarySel: string, fallbackSel: string, bgRowSel: string) => {
      function parseNum(s: string): number | null {
        const cleaned = s.replace(/,/g, "").replace(/[^\d.-]/g, "");
        if (!cleaned) return null;
        const n = Number.parseFloat(cleaned);
        return Number.isFinite(n) ? n : null;
      }

      function text(el: Element | null | undefined): string {
        return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
      }

      let walletTotalBalance: string | null = null;
      const pnlValueEls = Array.from(
        document.querySelectorAll(".text-pnl-value"),
      );
      for (const el of pnlValueEls) {
        let scan: Element | null = el;
        for (let d = 0; d < 8 && scan; d++) {
          if (/total\s*balance/i.test(text(scan))) {
            walletTotalBalance = text(el);
            break;
          }
          scan = scan.parentElement;
        }
        if (walletTotalBalance) break;
      }
      if (!walletTotalBalance && pnlValueEls[0]) {
        walletTotalBalance = text(pnlValueEls[0]);
      }

      let rowEls = Array.from(document.querySelectorAll(primarySel));
      if (rowEls.length === 0) {
        rowEls = Array.from(document.querySelectorAll(fallbackSel));
      }
      if (rowEls.length === 0) {
        rowEls = Array.from(document.querySelectorAll(bgRowSel));
      }
      if (rowEls.length === 0) {
        const broadRows = (requireCursorPointer: boolean): Element[] =>
          Array.from(document.querySelectorAll("div.bg-table-row")).filter(
            (el) => {
              const c =
                typeof el.className === "string"
                  ? el.className
                  : String(el.className ?? "");
              return (
                c.includes("grid-cols") &&
                c.includes("1.5fr") &&
                (!requireCursorPointer || c.includes("cursor-pointer"))
              );
            },
          );
        rowEls = broadRows(true);
        if (rowEls.length === 0) rowEls = broadRows(false);
      }

      const domRowsMatched = rowEls.length;

      const instrumentRe =
        /^[A-Z][A-Z0-9]{1,}(USD|USDT|PERP|-USD|_PERP)$/i;

      function normalizeKey(raw: string): string {
        return raw.replace(/[/\s_-]/g, "").toUpperCase();
      }

      function spanIsMuted(cand: Element): boolean {
        const cls = cand.getAttribute("class") ?? "";
        return (
          cand.classList.contains("text-pnl-value-muted") ||
          cls.includes("text-pnl-value-muted")
        );
      }

      /** Numbers from muted value spans in DOM order (Cosmic Size / Avg Price columns). */
      function mutedNumbersInRow(row: Element): number[] {
        const nums: number[] = [];
        for (const el of row.querySelectorAll("span")) {
          if (!spanIsMuted(el)) continue;
          const n = parseNum(text(el));
          if (n !== null) nums.push(n);
        }
        return nums;
      }

      function labelMatches(spanPlain: string, label: string): boolean {
        const a = spanPlain.replace(/\s+/g, " ").trim().toLowerCase();
        const b = label.replace(/\s+/g, " ").trim().toLowerCase();
        if (a === b) return true;
        if (b === "size" && /^size\b/i.test(a)) return true;
        if (
          (b === "avg price" || b.includes("avg")) &&
          /\bavg\b/i.test(a) &&
          /\bprice\b/i.test(a)
        )
          return true;
        return false;
      }

      /**
       * Cosmic portfolio columns use value-first layout:
       * `<span class="text-pnl-value-muted">0.01</span><span>Size</span>` — read muted span *before* label.
       */
      function mutedImmediatelyAboveLabel(labelSpan: Element): number | null {
        let el: Element | null = labelSpan.previousElementSibling;
        while (el) {
          if (el instanceof HTMLElement) {
            if (el.tagName === "SPAN" && spanIsMuted(el))
              return parseNum(text(el));
            const direct = el.querySelector(
              ":scope > span.text-pnl-value-muted, :scope > span[class*='text-pnl-value-muted']",
            );
            if (direct && spanIsMuted(direct))
              return parseNum(text(direct));
          }
          el = el.previousElementSibling;
        }
        return null;
      }

      function mutedForLabel(row: Element, label: string): number | null {
        const spans = Array.from(row.querySelectorAll("span"));
        for (let i = 0; i < spans.length; i++) {
          const sp = spans[i];
          if (!sp || !labelMatches(text(sp), label)) continue;
          const above = mutedImmediatelyAboveLabel(sp);
          if (above !== null) return above;
          for (let j = i + 1; j < spans.length; j++) {
            const cand = spans[j];
            if (!cand) continue;
            if (spanIsMuted(cand)) return parseNum(text(cand));
          }
        }
        return null;
      }

      function symbolFromRowSpans(row: Element): string {
        for (const img of row.querySelectorAll("img[alt]")) {
          const a = (img as HTMLImageElement).alt.trim();
          if (a && instrumentRe.test(a)) return a;
          const norm = normalizeKey(a);
          if (
            norm.length >= 5 &&
            /^[A-Z0-9]+$/.test(norm) &&
            (/USD|USDT|PERP$/i.test(norm) || norm.includes("USD"))
          ) {
            return norm;
          }
        }
        for (const sp of row.querySelectorAll("span")) {
          const t = text(sp);
          if (instrumentRe.test(t)) return t;
        }
        for (const sp of row.querySelectorAll("span")) {
          const t = text(sp);
          const norm = normalizeKey(t);
          if (norm.length < 5 || norm.length > 24) continue;
          if (!/^[A-Z0-9]+$/.test(norm)) continue;
          const noise = new Set([
            "BUY",
            "SELL",
            "LONG",
            "SHORT",
            "MARKET",
            "LIMIT",
            "TOTAL",
            "BALANCE",
          ]);
          if (noise.has(norm)) continue;
          if (
            /USD$|USDT$|PERP$/i.test(norm) ||
            (norm.includes("USD") && norm.length >= 6)
          ) {
            return norm;
          }
        }
        return "";
      }

      function tpSlFromColorDivs(row: Element): {
        takeProfit: number | null;
        stopLoss: number | null;
      } {
        let takeProfit: number | null = null;
        let stopLoss: number | null = null;
        const divs = row.querySelectorAll("div");
        for (const d of divs) {
          const c =
            typeof d.className === "string"
              ? d.className
              : String(d.className ?? "");
          const isBuy =
            c.includes("text-(--color-buy)") ||
            (c.includes("--color-buy") && /\btext-/i.test(c));
          const isSell =
            c.includes("text-(--color-sell)") ||
            (c.includes("--color-sell") && /\btext-/i.test(c));
          if (isBuy && takeProfit === null) {
            const n = parseNum(text(d));
            if (n !== null) takeProfit = n;
          }
          if (isSell && stopLoss === null) {
            const n = parseNum(text(d));
            if (n !== null) stopLoss = n;
          }
        }
        return { takeProfit, stopLoss };
      }

      const seenRows = new WeakSet<Element>();
      const positions: Record<string, unknown>[] = [];

      for (const row of rowEls) {
        if (!(row instanceof HTMLElement)) continue;
        if (seenRows.has(row)) continue;
        seenRows.add(row);

        const symbol = symbolFromRowSpans(row);
        if (!symbol) continue;

        let sideRaw = "";
        for (const sp of row.querySelectorAll("span")) {
          const t = text(sp);
          if (t === "BUY" || t === "LONG") {
            sideRaw = "BUY";
            break;
          }
          if (t === "SELL" || t === "SHORT") {
            sideRaw = "SELL";
            break;
          }
        }

        const mutedNums = mutedNumbersInRow(row);
        let size = mutedForLabel(row, "Size");
        let avgPrice = mutedForLabel(row, "Avg Price");
        if (size === null && mutedNums.length > 0) size = mutedNums[0]!;
        if (avgPrice === null && mutedNums.length > 1) avgPrice = mutedNums[1]!;

        const { takeProfit, stopLoss } = tpSlFromColorDivs(row);

        const pnlEl = row.querySelector(
          ".text-pnl-positive, .text-pnl-negative",
        );
        const unrealizedPnl = text(pnlEl);

        if (!sideRaw || size === null) continue;

        const entryPrice =
          avgPrice !== null && Number.isFinite(avgPrice) ? avgPrice : 0;

        positions.push({
          symbol,
          side: sideRaw,
          entryPrice,
          size: Math.abs(size),
          stopLoss,
          takeProfit,
          unrealizedPnl: unrealizedPnl || undefined,
          openedAt: null as string | null,
        });
      }

      return { walletTotalBalance, positions, domRowsMatched };
    },
    COSMIC_PORTFOLIO_ROW_GRID_SELECTOR,
    COSMIC_PORTFOLIO_ROW_GRID_SELECTOR_FALLBACK,
    COSMIC_PORTFOLIO_ROW_BG_FALLBACK,
  );
}
