/**
 * Parses Cosmic portfolio DOM (wallet + open positions grid).
 * Selectors align with Cosmic UI: text-pnl-value, font-text pairs, grid rows, TP/SL color tokens.
 */
export async function extractCosmicPortfolioDom(page) {
    const parsed = Number(process.env.COSMIC_SCRAPER_DOM_WAIT_MS?.trim());
    const waitMs = Number.isFinite(parsed) && parsed >= 3000 ? parsed : 60_000;
    await page.waitForSelector(".text-pnl-value", { timeout: waitMs }).catch(() => { });
    await page
        .waitForSelector('span.font-text, span[class*="font-text"]', {
        timeout: waitMs,
    })
        .catch(() => { });
    return page.evaluate(() => {
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
        /** Total Balance near label */
        let walletTotalBalance = null;
        const pnlValueEls = Array.from(document.querySelectorAll(".text-pnl-value"));
        for (const el of pnlValueEls) {
            let scan = el;
            for (let d = 0; d < 6 && scan; d++) {
                const blockText = text(scan);
                if (/total\s*balance/i.test(blockText)) {
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
        const instrumentRe = /^[A-Z][A-Z0-9]{1,}(USD|USDT|PERP|-USD|_PERP)$/i;
        const tokenSpans = Array.from(document.querySelectorAll("span.font-text, span[class*='font-text']")).filter((s) => instrumentRe.test(text(s)));
        const seenRows = new WeakSet();
        const positions = [];
        for (const tokSpan of tokenSpans) {
            const symbol = text(tokSpan);
            if (!symbol)
                continue;
            const row = tokSpan.closest('[class*="grid"]') ??
                tokSpan.closest("div[class*='grid']") ??
                tokSpan.closest('[class*="Grid"]') ??
                tokSpan.parentElement?.parentElement ??
                tokSpan.parentElement;
            if (!row || seenRows.has(row))
                continue;
            seenRows.add(row);
            let sideRaw = "";
            if (row.querySelector("span.text-green-500"))
                sideRaw = "BUY";
            else if (row.querySelector("span.text-red-500"))
                sideRaw = "SELL";
            let size = null;
            let entry = null;
            const spans = Array.from(row.querySelectorAll("span"));
            for (let i = 0; i < spans.length; i++) {
                const sp = spans[i];
                if (!sp)
                    continue;
                const lab = text(sp);
                if (lab === "Size") {
                    const fromNext = text(spans[i + 1]);
                    const fromSibling = text(sp.nextElementSibling);
                    size =
                        parseNum(fromNext) ??
                            parseNum(fromSibling) ??
                            parseNum(text(sp.parentElement));
                    break;
                }
            }
            for (let i = 0; i < spans.length; i++) {
                const sp = spans[i];
                if (!sp)
                    continue;
                const lab = text(sp);
                if (/^(entry|avg\.?\s*entry|average\s*entry)$/i.test(lab)) {
                    entry = parseNum(text(spans[i + 1]));
                    break;
                }
            }
            if (entry === null) {
                const rowText = text(row);
                const m = rowText.match(/(?:entry|avg\.?\s*entry)\s*[:\s]*([\d,.]+)/i);
                if (m)
                    entry = parseNum(m[1] ?? "");
            }
            const pnlEl = row.querySelector(".text-pnl-positive, .text-pnl-negative");
            const unrealizedPnl = text(pnlEl);
            let takeProfit = null;
            let stopLoss = null;
            const allDivs = row.querySelectorAll("div");
            for (const d of allDivs) {
                const c = typeof d.className === "string" ? d.className : "";
                const hasBuy = c.includes("color-buy") ||
                    c.includes("--color-buy") ||
                    /\(.*color-buy.*\)/i.test(c);
                const hasSell = c.includes("color-sell") ||
                    c.includes("--color-sell") ||
                    /\(.*color-sell.*\)/i.test(c);
                if (hasBuy && takeProfit === null) {
                    const n = parseNum(text(d));
                    if (n !== null)
                        takeProfit = n;
                }
                if (hasSell && stopLoss === null) {
                    const n = parseNum(text(d));
                    if (n !== null)
                        stopLoss = n;
                }
            }
            if (!sideRaw || size === null)
                continue;
            const entryPrice = entry !== null && entry !== 0 ? entry : 0;
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
    });
}
//# sourceMappingURL=cosmicPortfolioDomExtract.js.map