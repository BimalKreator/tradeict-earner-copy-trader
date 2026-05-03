/** Tailwind arbitrary grid template — Cosmic portfolio position rows. */
export const COSMIC_PORTFOLIO_ROW_GRID_SELECTOR = ".grid-cols-\\[1\\.5fr_1fr_1fr_1fr_1fr_1fr_1fr_auto\\]";
/** Fallback when compiled class string differs slightly in DOM. */
export const COSMIC_PORTFOLIO_ROW_GRID_SELECTOR_FALLBACK = '[class*="1.5fr_1fr_1fr_1fr_1fr_1fr_1fr_auto"]';
/**
 * Parses Cosmic `/portfolio` DOM using the canonical grid row class and label/value rules.
 * Caller should navigate to portfolio and `waitForSelector` the grid before invoking.
 */
export async function extractCosmicPortfolioDom(page) {
    return page.evaluate((primarySel, fallbackSel) => {
        function parseNum(s) {
            const cleaned = s.replace(/,/g, "").replace(/[^\d.-]/g, "");
            if (!cleaned)
                return null;
            const n = Number.parseFloat(cleaned);
            return Number.isFinite(n) ? n : null;
        }
        function text(el) {
            return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
        }
        let walletTotalBalance = null;
        const pnlValueEls = Array.from(document.querySelectorAll(".text-pnl-value"));
        for (const el of pnlValueEls) {
            let scan = el;
            for (let d = 0; d < 8 && scan; d++) {
                if (/total\s*balance/i.test(text(scan))) {
                    walletTotalBalance = text(el);
                    break;
                }
                scan = scan.parentElement;
            }
            if (walletTotalBalance)
                break;
        }
        if (!walletTotalBalance && pnlValueEls[0]) {
            walletTotalBalance = text(pnlValueEls[0]);
        }
        let rowEls = Array.from(document.querySelectorAll(primarySel));
        if (rowEls.length === 0) {
            rowEls = Array.from(document.querySelectorAll(fallbackSel));
        }
        const instrumentRe = /^[A-Z][A-Z0-9]{1,}(USD|USDT|PERP|-USD|_PERP)$/i;
        function mutedValueAfterLabel(row, label) {
            const spans = Array.from(row.querySelectorAll("span"));
            for (let i = 0; i < spans.length; i++) {
                const sp = spans[i];
                if (!sp || text(sp) !== label)
                    continue;
                for (let j = i + 1; j < spans.length; j++) {
                    const cand = spans[j];
                    if (!cand)
                        continue;
                    const cls = cand.getAttribute("class") ?? "";
                    if (cand.classList.contains("text-pnl-value-muted") ||
                        cls.includes("text-pnl-value-muted")) {
                        return parseNum(text(cand));
                    }
                }
            }
            return null;
        }
        function tpSlFromColorDivs(row) {
            let takeProfit = null;
            let stopLoss = null;
            const divs = row.querySelectorAll("div");
            for (const d of divs) {
                const c = typeof d.className === "string"
                    ? d.className
                    : String(d.className ?? "");
                const isBuy = c.includes("text-(--color-buy)") ||
                    (c.includes("--color-buy") && /\btext-/i.test(c));
                const isSell = c.includes("text-(--color-sell)") ||
                    (c.includes("--color-sell") && /\btext-/i.test(c));
                if (isBuy && takeProfit === null) {
                    const n = parseNum(text(d));
                    if (n !== null)
                        takeProfit = n;
                }
                if (isSell && stopLoss === null) {
                    const n = parseNum(text(d));
                    if (n !== null)
                        stopLoss = n;
                }
            }
            return { takeProfit, stopLoss };
        }
        const seenRows = new WeakSet();
        const positions = [];
        for (const row of rowEls) {
            if (!(row instanceof HTMLElement))
                continue;
            if (seenRows.has(row))
                continue;
            seenRows.add(row);
            let symbol = "";
            for (const sp of row.querySelectorAll("span")) {
                const t = text(sp);
                if (instrumentRe.test(t)) {
                    symbol = t;
                    break;
                }
            }
            if (!symbol)
                continue;
            let sideRaw = "";
            for (const sp of row.querySelectorAll("span")) {
                const t = text(sp);
                if (t === "BUY" || t === "SELL") {
                    sideRaw = t;
                    break;
                }
            }
            const size = mutedValueAfterLabel(row, "Size");
            const avgPrice = mutedValueAfterLabel(row, "Avg Price");
            const { takeProfit, stopLoss } = tpSlFromColorDivs(row);
            const pnlEl = row.querySelector(".text-pnl-positive, .text-pnl-negative");
            const unrealizedPnl = text(pnlEl);
            if (!sideRaw || size === null)
                continue;
            const entryPrice = avgPrice !== null && Number.isFinite(avgPrice) ? avgPrice : 0;
            positions.push({
                symbol,
                side: sideRaw,
                entryPrice,
                size: Math.abs(size),
                stopLoss,
                takeProfit,
                unrealizedPnl: unrealizedPnl || undefined,
                openedAt: null,
            });
        }
        return { walletTotalBalance, positions };
    }, COSMIC_PORTFOLIO_ROW_GRID_SELECTOR, COSMIC_PORTFOLIO_ROW_GRID_SELECTOR_FALLBACK);
}
//# sourceMappingURL=cosmicPortfolioDomExtract.js.map