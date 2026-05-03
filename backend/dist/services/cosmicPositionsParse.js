import { COSMIC_TO_DELTA_SYMBOL, mapCosmicSymbolToDelta, normalizeCosmicSymbolKey, } from "./cosmicSymbolMap.js";
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
        else if (o.data &&
            typeof o.data === "object" &&
            Array.isArray(o.data.positions)) {
            list = o.data.positions;
        }
        else if (Array.isArray(o.openPositions))
            list = o.openPositions;
    }
    for (const item of list) {
        if (!item || typeof item !== "object")
            continue;
        const row = item;
        const symbol = readStringField(row, [
            "symbol",
            "Symbol",
            "instrument",
            "pair",
            "market",
        ]) ?? "";
        const sideRaw = readStringField(row, ["side", "Side", "direction", "positionSide"]) ??
            "";
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
        const stopLoss = asNumber(row.stopLoss) ??
            asNumber(row.stop_loss) ??
            asNumber(row.sl) ??
            asNumber(row.stopPrice);
        const takeProfit = asNumber(row.takeProfit) ??
            asNumber(row.take_profit) ??
            asNumber(row.target) ??
            asNumber(row.tp) ??
            asNumber(row.takeProfitPrice);
        let openedAt = readStringField(row, [
            "openedAt",
            "opened_at",
            "entryTime",
            "entry_time",
            "createdAt",
            "opened",
        ]);
        const ts = asNumber(row.timestamp) ??
            asNumber(row.openedAtMs) ??
            asNumber(row.created_at_ms);
        if (!openedAt && ts !== null && ts > 1_000_000_000_000) {
            openedAt = new Date(ts).toISOString();
        }
        else if (!openedAt && ts !== null && ts > 1_000_000_000) {
            openedAt = new Date(ts * 1000).toISOString();
        }
        if (!symbol || !sideRaw || entry === null || size === null)
            continue;
        out.push({
            symbol,
            side: sideRaw,
            entry,
            size: Math.abs(size),
            stopLoss,
            takeProfit,
            openedAt,
        });
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
            stopLoss: row.stopLoss,
            takeProfit: row.takeProfit,
            openedAt: row.openedAt,
        });
    }
    return trades;
}
export function parseCosmicPositionsPayload(data) {
    const rows = extractPositionRows(data);
    return toLedTrades(rows);
}
//# sourceMappingURL=cosmicPositionsParse.js.map