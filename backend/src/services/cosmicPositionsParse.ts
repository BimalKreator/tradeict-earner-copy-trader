import type { TradeSide } from "./exchangeService.js";
import {
  COSMIC_TO_DELTA_SYMBOL,
  mapCosmicSymbolToDelta,
  normalizeCosmicSymbolKey,
} from "./cosmicSymbolMap.js";

export interface CosmicLedTrade {
  id: string;
  cosmicSymbol: string;
  deltaSymbol: string;
  side: TradeSide;
  size: number;
  entryPrice: number;
  stopLoss?: number | null;
  takeProfit?: number | null;
  openedAt?: string | null;
}

export function buildCosmicTradeId(parts: {
  cosmicSymbol: string;
  side: string;
  entryPrice: number;
  size: number;
}): string {
  const sym = normalizeCosmicSymbolKey(parts.cosmicSymbol);
  return `${sym}|${parts.side}|${parts.entryPrice}|${parts.size}`;
}

function normalizeSide(raw: string): TradeSide | null {
  const t = raw.trim();
  if (!t) return null;
  /** Word-aware so "ETHUSD (BUY)" works but "OVERSOLD" does not match SELL. */
  if (/\b(BUY|LONG)\b/i.test(t)) return "BUY";
  if (/\b(SELL|SHORT)\b/i.test(t)) return "SELL";
  return null;
}

/**
 * Scraper Studio cells often include side text: "ETHUSD (BUY)" — naive normalization
 * becomes `ETHUSD(BUY)` and Delta mapping fails.
 */
function sanitizeInstrumentLabel(raw: string): string {
  const t = raw.trim();
  if (!t) return "";
  const pair = t.match(/\b([A-Z][A-Z0-9]{2,}(?:USD|USDT|PERP))\b/i);
  if (pair) return pair[1]!.toUpperCase();
  const head =
    (t.split(/\(/)[0] ?? t).trim().split(/\s+/)[0] ?? "";
  return normalizeCosmicSymbolKey(head);
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number.parseFloat(v.replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function readStringField(
  row: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function extractPositionRows(data: unknown): {
  symbol: string;
  side: string;
  entry: number;
  size: number;
  stopLoss: number | null;
  takeProfit: number | null;
  openedAt: string | null;
}[] {
  const out: {
    symbol: string;
    side: string;
    entry: number;
    size: number;
    stopLoss: number | null;
    takeProfit: number | null;
    openedAt: string | null;
  }[] = [];

  let list: unknown[] = [];
  if (Array.isArray(data)) {
    list = data;
  } else if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    if (Array.isArray(o.positions)) list = o.positions;
    else if (Array.isArray(o.data)) list = o.data;
    else if (
      o.data &&
      typeof o.data === "object" &&
      Array.isArray((o.data as { positions?: unknown }).positions)
    ) {
      list = (o.data as { positions: unknown[] }).positions;
    } else if (Array.isArray(o.openPositions)) list = o.openPositions;
  }

  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const symbol = sanitizeInstrumentLabel(
      readStringField(row, [
        "symbol",
        "Symbol",
        "instrument",
        "pair",
        "market",
      ]) ?? "",
    );
    const sideRaw =
      readStringField(row, ["side", "Side", "direction", "positionSide"]) ??
      "";
    const entry =
      asNumber(row.entryPrice) ??
      asNumber(row.entry) ??
      asNumber(row.avgEntryPrice) ??
      asNumber(row.price) ??
      asNumber(row.averageEntryPrice);
    const size =
      asNumber(row.size) ??
      asNumber(row.quantity) ??
      asNumber(row.amount) ??
      asNumber(row.contracts) ??
      asNumber(row.qty);

    const stopLoss =
      asNumber(row.stopLoss) ??
      asNumber(row.stop_loss) ??
      asNumber(row.sl) ??
      asNumber(row.stopPrice);
    const takeProfit =
      asNumber(row.takeProfit) ??
      asNumber(row.take_profit) ??
      asNumber(row.target) ??
      asNumber(row.tp) ??
      asNumber(row.takeProfitPrice);

    let openedAt: string | null = readStringField(row, [
      "openedAt",
      "opened_at",
      "entryTime",
      "entry_time",
      "createdAt",
      "opened",
    ]);
    const ts =
      asNumber(row.timestamp) ??
      asNumber(row.openedAtMs) ??
      asNumber(row.created_at_ms);
    if (!openedAt && ts !== null && ts > 1_000_000_000_000) {
      openedAt = new Date(ts).toISOString();
    } else if (!openedAt && ts !== null && ts > 1_000_000_000) {
      openedAt = new Date(ts * 1000).toISOString();
    }

    if (!symbol || !sideRaw || entry === null || size === null) continue;
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

function toLedTrades(
  rows: {
    symbol: string;
    side: string;
    entry: number;
    size: number;
    stopLoss: number | null;
    takeProfit: number | null;
    openedAt: string | null;
  }[],
): CosmicLedTrade[] {
  const trades: CosmicLedTrade[] = [];
  for (const row of rows) {
    const side = normalizeSide(row.side);
    if (!side) continue;
    const deltaSymbol = mapCosmicSymbolToDelta(row.symbol);
    if (!deltaSymbol) {
      console.warn(
        `[cosmic] No Delta mapping for Cosmic symbol "${row.symbol}" — supported: ${Object.keys(COSMIC_TO_DELTA_SYMBOL).join(", ")}`,
      );
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

export function parseCosmicPositionsPayload(data: unknown): CosmicLedTrade[] {
  const rows = extractPositionRows(data);
  return toLedTrades(rows);
}
