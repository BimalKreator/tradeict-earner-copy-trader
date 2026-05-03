import axios from "axios";
import { COSMIC_TO_DELTA_SYMBOL, mapCosmicSymbolToDelta, normalizeCosmicSymbolKey, } from "./cosmicSymbolMap.js";
/**
 * Build a stable id for deduplication (Cosmic side, before Delta mapping).
 */
export function buildCosmicTradeId(parts) {
    const sym = normalizeCosmicSymbolKey(parts.cosmicSymbol);
    return `${sym}|${parts.side}|${parts.entryPrice}|${parts.size}`;
}
function normalizeSide(raw) {
    const u = raw.trim().toUpperCase();
    if (u === "BUY" || u === "LONG")
        return "BUY";
    if (u === "SELL" || u === "SHORT")
        return "SELL";
    return null;
}
function asNumber(v) {
    if (typeof v === "number" && Number.isFinite(v))
        return v;
    if (typeof v === "string") {
        const n = Number.parseFloat(v.replace(/,/g, ""));
        return Number.isFinite(n) ? n : null;
    }
    return null;
}
function readStringField(row, keys) {
    for (const k of keys) {
        const v = row[k];
        if (typeof v === "string" && v.trim())
            return v.trim();
    }
    return null;
}
/**
 * Flattens common API shapes into raw rows: { symbol, side, entry, size }.
 */
function extractPositionRows(data) {
    const out = [];
    let list = [];
    if (Array.isArray(data)) {
        list = data;
    }
    else if (data && typeof data === "object") {
        const o = data;
        if (Array.isArray(o.positions))
            list = o.positions;
        else if (Array.isArray(o.data))
            list = o.data;
        else if (o.data && typeof o.data === "object" && Array.isArray(o.data.positions)) {
            list = o.data.positions;
        }
        else if (Array.isArray(o.openPositions))
            list = o.openPositions;
    }
    for (const item of list) {
        if (!item || typeof item !== "object")
            continue;
        const row = item;
        const symbol = readStringField(row, ["symbol", "Symbol", "instrument", "pair", "market"]) ?? "";
        const sideRaw = readStringField(row, ["side", "Side", "direction", "positionSide"]) ?? "";
        const entry = asNumber(row.entryPrice) ??
            asNumber(row.entry) ??
            asNumber(row.avgEntryPrice) ??
            asNumber(row.price) ??
            asNumber(row.averageEntryPrice);
        const size = asNumber(row.size) ??
            asNumber(row.quantity) ??
            asNumber(row.amount) ??
            asNumber(row.contracts) ??
            asNumber(row.qty);
        if (!symbol || !sideRaw || entry === null || size === null)
            continue;
        out.push({ symbol, side: sideRaw, entry, size: Math.abs(size) });
    }
    return out;
}
function toLedTrades(rows) {
    const trades = [];
    for (const row of rows) {
        const side = normalizeSide(row.side);
        if (!side)
            continue;
        const deltaSymbol = mapCosmicSymbolToDelta(row.symbol);
        if (!deltaSymbol) {
            console.warn(`[cosmic] No Delta mapping for Cosmic symbol "${row.symbol}" — supported: ${Object.keys(COSMIC_TO_DELTA_SYMBOL).join(", ")}`);
            continue;
        }
        const id = buildCosmicTradeId({
            cosmicSymbol: row.symbol,
            side,
            entryPrice: row.entry,
            size: row.size,
        });
        trades.push({
            id,
            cosmicSymbol: normalizeCosmicSymbolKey(row.symbol) || row.symbol,
            deltaSymbol,
            side,
            size: row.size,
            entryPrice: row.entry,
        });
    }
    return trades;
}
/**
 * Optional override for how auth headers are sent to Cosmic.
 * Defaults: X-API-Key, X-API-Secret (Brevo-style names won’t apply here; many APIs use similar).
 */
function buildAuthHeaders(apiKey, apiSecret) {
    const keyName = process.env.COSMIC_API_KEY_HEADER?.trim() || "X-API-Key";
    const secName = process.env.COSMIC_API_SECRET_HEADER?.trim() || "X-API-Secret";
    return {
        [keyName]: apiKey,
        [secName]: apiSecret,
    };
}
/**
 * GET open positions for the linked Cosmic account.
 * Set `COSMIC_POSITIONS_HTTP_URL` to the full URL (e.g. https://api.cosmic.trade/v1/positions).
 * The response is parsed flexibly; adjust env or extend `extractPositionRows` if the payload differs.
 */
export async function fetchCosmicOpenPositions(apiKey, apiSecret) {
    const url = process.env.COSMIC_POSITIONS_HTTP_URL?.trim();
    if (!url) {
        console.warn("[cosmic] COSMIC_POSITIONS_HTTP_URL is not set — cannot fetch positions (set in .env).");
        return [];
    }
    if (!apiKey.trim() || !apiSecret.trim()) {
        console.warn("[cosmic] Strategy is missing cosmicApiKey or cosmicApiSecret — skip fetch.");
        return [];
    }
    try {
        const res = await axios.get(url, {
            headers: {
                Accept: "application/json",
                ...buildAuthHeaders(apiKey, apiSecret),
            },
            timeout: 25_000,
            validateStatus: (s) => s < 500,
        });
        if (res.status >= 400) {
            console.warn(`[cosmic] Positions HTTP ${res.status} for ${url}:`, typeof res.data === "string" ? res.data.slice(0, 200) : res.data);
            return [];
        }
        const rows = extractPositionRows(res.data);
        return toLedTrades(rows);
    }
    catch (err) {
        console.error("[cosmic] fetchCosmicOpenPositions failed:", err instanceof Error ? err.message : err);
        return [];
    }
}
//# sourceMappingURL=cosmicClient.js.map