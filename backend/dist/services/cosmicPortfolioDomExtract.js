/**
 * Escaped selectors for Puppeteer `waitForSelector` only — parsing uses plain
 * `div.bg-table-row` + innerText line scans (no Tailwind arbitrary-class selectors).
 */
export const COSMIC_PORTFOLIO_ROW_GRID_SELECTOR = ".grid-cols-\\[1\\.5fr_1fr_1fr_1fr_1fr_1fr_1fr_auto\\]";
export const COSMIC_PORTFOLIO_ROW_GRID_SELECTOR_FALLBACK = '[class*="1.5fr_1fr_1fr_1fr_1fr_1fr_1fr_auto"]';
export const COSMIC_PORTFOLIO_ROW_BG_FALLBACK = 'div.bg-table-row[class*="1.5fr_1fr_1fr_1fr_1fr_1fr_1fr_auto"]';
/** Normalize Prisma JSON / API payloads into string selectors for `page.evaluate`. */
export function coerceScraperMappings(raw) {
    if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
        return undefined;
    }
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
        if (typeof k !== "string" || typeof v !== "string")
            continue;
        const kt = k.trim();
        const vt = v.trim();
        if (!kt || !vt)
            continue;
        out[kt] = vt;
    }
    return Object.keys(out).length > 0 ? out : undefined;
}
function buildSerializableMappings(scraperMappings) {
    if (scraperMappings == null)
        return {};
    const out = {};
    for (const [k, v] of Object.entries(scraperMappings)) {
        const kt = k.trim();
        const vt = v.trim();
        if (!kt || !vt)
            continue;
        out[kt] = vt;
    }
    return out;
}
/**
 * Resilient Cosmic `/portfolio` parse: optional per-strategy CSS mappings from Scraper Studio,
 * then `bg-table-row` + innerText lines + regex fallbacks.
 * Delta mapping (`ETHUSD` → `ETHUSDT`) runs later in `parseCosmicPositionsPayload`.
 */
export async function extractCosmicPortfolioDom(page, scraperMappings) {
    const mapsPayload = buildSerializableMappings(scraperMappings);
    try {
        return await page.evaluate((maps) => {
            try {
                function lookupSel(...aliases) {
                    const want = new Set(aliases.map((a) => a.toLowerCase()));
                    for (const [k, v] of Object.entries(maps)) {
                        const kl = k.trim().toLowerCase();
                        if (want.has(kl) && v.trim())
                            return v.trim();
                    }
                    return undefined;
                }
                function safeQuery(scope, sel) {
                    try {
                        return scope.querySelector(sel);
                    }
                    catch {
                        return null;
                    }
                }
                function textFromEl(el) {
                    if (!el)
                        return "";
                    const tag = el.tagName?.toUpperCase?.() ?? "";
                    if (tag === "IMG") {
                        return (el.alt ?? "").trim();
                    }
                    return (el.innerText ?? el.textContent ?? "")
                        .replace(/\s+/g, " ")
                        .trim();
                }
                function parseNum(raw) {
                    const n = Number.parseFloat(raw.replace(/[^0-9.-]/g, ""));
                    return Number.isFinite(n) ? n : 0;
                }
                function normalizeSideFromText(t) {
                    const u = t.toUpperCase();
                    if (u.includes("BUY") || u.includes("LONG"))
                        return "BUY";
                    return "SELL";
                }
                /** Wallet: mapped selector, then label row (Cosmic wallet card). */
                let walletTotalBalance = null;
                const wbSel = lookupSel("wallet_balance", "walletbalance");
                if (wbSel) {
                    const el = safeQuery(document, wbSel);
                    const t = textFromEl(el);
                    if (t)
                        walletTotalBalance = t;
                }
                if (!walletTotalBalance) {
                    const balanceDiv = Array.from(document.querySelectorAll("div.text-xs")).find((d) => (d.innerText ?? "").includes("Total Balance"));
                    if (balanceDiv?.nextElementSibling) {
                        walletTotalBalance = (balanceDiv.nextElementSibling.textContent ?? "")
                            .replace(/\s+/g, " ")
                            .trim();
                    }
                }
                if (!walletTotalBalance) {
                    const pnlValueEls = Array.from(document.querySelectorAll(".text-pnl-value"));
                    for (const el of pnlValueEls) {
                        let scan = el;
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
                        if (walletTotalBalance)
                            break;
                    }
                    if (!walletTotalBalance && pnlValueEls[0]) {
                        walletTotalBalance = (pnlValueEls[0].textContent ?? "")
                            .replace(/\s+/g, " ")
                            .trim();
                    }
                }
                const rowSel = lookupSel("position_row", "positionrow");
                let rows;
                if (rowSel) {
                    try {
                        rows = Array.from(document.querySelectorAll(rowSel));
                    }
                    catch {
                        rows = [];
                    }
                }
                else {
                    rows = Array.from(document.querySelectorAll("div.bg-table-row"));
                }
                const mappingMode = Boolean(rowSel) ||
                    Boolean(lookupSel("symbol")) ||
                    Boolean(lookupSel("size")) ||
                    Boolean(lookupSel("avg_price", "avgprice", "entry_price"));
                const positions = [];
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
                    const text = row.innerText ?? "";
                    if (!mappingMode) {
                        if (!text.includes("Size") || !text.includes("Avg Price"))
                            continue;
                    }
                    const symSel = lookupSel("symbol");
                    let symbol = "UNKNOWN";
                    if (symSel) {
                        const el = safeQuery(row, symSel);
                        if (el) {
                            const t = textFromEl(el);
                            if (t)
                                symbol = t;
                        }
                    }
                    if (symbol === "UNKNOWN") {
                        const img = row.querySelector("img[alt]");
                        if (img?.getAttribute("alt")?.trim()) {
                            symbol = img.getAttribute("alt").trim();
                        }
                        else {
                            const ins = text.match(/\b([A-Z][A-Z0-9]{2,}(?:USD|USDT|PERP))\b/);
                            if (ins) {
                                symbol = ins[1];
                            }
                            else {
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
                    }
                    const sideSel = lookupSel("side");
                    let side;
                    if (sideSel) {
                        const el = safeQuery(row, sideSel);
                        const st = textFromEl(el);
                        side = st ? normalizeSideFromText(st) : normalizeSideFromText(text);
                    }
                    else {
                        side = normalizeSideFromText(text);
                    }
                    let size = 0;
                    let entryPrice = 0;
                    let unrealizedPnlNum = 0;
                    const sizeSel = lookupSel("size");
                    if (sizeSel) {
                        const el = safeQuery(row, sizeSel);
                        if (el) {
                            const raw = textFromEl(el);
                            if (raw)
                                size = parseNum(raw);
                        }
                    }
                    const avgSel = lookupSel("avg_price", "avgprice", "entry_price");
                    if (avgSel) {
                        const el = safeQuery(row, avgSel);
                        if (el) {
                            const raw = textFromEl(el);
                            if (raw)
                                entryPrice = parseNum(raw);
                        }
                    }
                    const pnlSel = lookupSel("unrealized_pnl", "pnl", "unrealizedpnl");
                    let pnlMapped = false;
                    if (pnlSel) {
                        const el = safeQuery(row, pnlSel);
                        if (el) {
                            const raw = textFromEl(el);
                            if (raw) {
                                unrealizedPnlNum = parseNum(raw);
                                pnlMapped = true;
                            }
                        }
                    }
                    const lines = text
                        .split(/\n/)
                        .map((l) => l.trim())
                        .filter((l) => l.length > 0);
                    if (size === 0) {
                        for (let i = 0; i < lines.length; i++) {
                            if (lines[i] === "Size" && i > 0) {
                                size = parseNum(lines[i - 1]);
                            }
                        }
                    }
                    if (entryPrice === 0) {
                        for (let i = 0; i < lines.length; i++) {
                            if (lines[i] === "Avg Price" && i > 0) {
                                entryPrice = parseNum(lines[i - 1]);
                            }
                        }
                    }
                    if (!pnlMapped) {
                        for (let i = 0; i < lines.length; i++) {
                            if (lines[i] === "PNL" && i > 0) {
                                unrealizedPnlNum = parseNum(lines[i - 1]);
                            }
                        }
                    }
                    let takeProfit = null;
                    let stopLoss = null;
                    const tpSel = lookupSel("take_profit", "takeprofit", "tp");
                    if (tpSel) {
                        const el = safeQuery(row, tpSel);
                        if (el) {
                            const raw = textFromEl(el);
                            if (raw) {
                                const n = Number.parseFloat(raw.replace(/,/g, ""));
                                if (Number.isFinite(n))
                                    takeProfit = n;
                            }
                        }
                    }
                    const slSel = lookupSel("stop_loss", "stoploss", "sl");
                    if (slSel) {
                        const el = safeQuery(row, slSel);
                        if (el) {
                            const raw = textFromEl(el);
                            if (raw) {
                                const n = Number.parseFloat(raw.replace(/,/g, ""));
                                if (Number.isFinite(n))
                                    stopLoss = n;
                            }
                        }
                    }
                    if (takeProfit === null) {
                        const tpMatch = text.match(/TP:\s*\$?([\d.,]+)/i);
                        if (tpMatch) {
                            const n = Number.parseFloat(tpMatch[1].replace(/,/g, ""));
                            if (Number.isFinite(n))
                                takeProfit = n;
                        }
                    }
                    if (stopLoss === null) {
                        const slMatch = text.match(/SL:\s*\$?([\d.,]+)/i);
                        if (slMatch) {
                            const n = Number.parseFloat(slMatch[1].replace(/,/g, ""));
                            if (Number.isFinite(n))
                                stopLoss = n;
                        }
                    }
                    if (symbol !== "UNKNOWN" && size > 0) {
                        const rowObj = {
                            symbol,
                            side,
                            size: Math.abs(size),
                            entryPrice: entryPrice > 0 ? entryPrice : 0,
                            stopLoss,
                            takeProfit,
                            openedAt: null,
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
            }
            catch (error) {
                return {
                    walletTotalBalance: null,
                    positions: [],
                    domRowsMatched: 0,
                    extractError: error instanceof Error ? error.message : String(error),
                };
            }
        }, mapsPayload);
    }
    catch (err) {
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
//# sourceMappingURL=cosmicPortfolioDomExtract.js.map