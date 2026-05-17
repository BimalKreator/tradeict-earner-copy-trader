import type { TradeSide } from "./exchangeService.js";

/** Delta product symbol → latest **mark** price (USD). Never stores LTP / bid / ask. */
export const liveMarkPrices = new Map<string, number>();

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

/**
 * Extract mark price only — matches Delta Terminal (ignores last, close, bid, ask).
 * Delta WS ticker uses `mark_price` / `m`; mark_price channel uses `p` / `mark_price`.
 */
export function extractStrictMarkPrice(row: Record<string, unknown>): number | null {
  return num(
    row.mark_price ??
      row.markPrice ??
      row.m ??
      null,
  );
}

/** Store under product symbol and common perp aliases (ETHUSDT ↔ ETHUSD). */
export function cacheLiveMarkPrice(productSymbol: string, price: number): void {
  if (!Number.isFinite(price) || price <= 0) return;
  const raw = productSymbol.trim();
  if (!raw) return;

  const keys = new Set<string>();
  keys.add(raw);
  keys.add(raw.toUpperCase());

  const base = raw.startsWith("MARK:") ? raw.slice(5) : raw;
  keys.add(base);
  keys.add(base.toUpperCase());

  const upper = base.toUpperCase();
  if (upper.endsWith("USDT")) keys.add(upper.slice(0, -4) + "USD");
  if (upper.endsWith("USD") && !upper.endsWith("USDT")) {
    keys.add(upper.slice(0, -3) + "USDT");
  }

  for (const k of keys) {
    liveMarkPrices.set(k, price);
  }
}

export function resolveLiveMarkPrice(symbolKey: string): number | null {
  const s = symbolKey.trim();
  if (!s) return null;

  const candidates = [s, s.toUpperCase()];
  const upper = s.toUpperCase();
  if (upper.endsWith("USDT")) candidates.push(upper.slice(0, -4) + "USD");
  if (upper.endsWith("USD") && !upper.endsWith("USDT")) {
    candidates.push(upper.slice(0, -3) + "USDT");
  }

  for (const k of candidates) {
    const p = liveMarkPrices.get(k);
    if (p != null && Number.isFinite(p) && p > 0) return p;
  }
  return null;
}

export function deltaContractSizeFallback(symbol: string): number {
  const u = symbol.toUpperCase();
  if (u.includes("BTC")) return 0.001;
  if (u.includes("ETH")) return 0.01;
  return 1;
}

/**
 * Unrealized PnL from mark price (Delta formula):
 * BUY:  (mark - entry) × |contracts| × contractSize
 * SELL: (entry - mark) × |contracts| × contractSize
 */
export function estimateLivePnlUsd(args: {
  symbolKey: string;
  side: TradeSide;
  entryPrice: number;
  contracts: number;
  markPrice: number;
  contractSize?: number;
}): number {
  const cs =
    args.contractSize != null && Number.isFinite(args.contractSize) && args.contractSize > 0
      ? args.contractSize
      : deltaContractSizeFallback(args.symbolKey);
  const realBaseSize = Math.abs(args.contracts) * cs;
  const sign = args.side === "BUY" ? 1 : -1;
  return (args.markPrice - args.entryPrice) * realBaseSize * sign;
}

function ingestTickerRow(row: unknown): void {
  const r = asRecord(row);
  if (!r) return;
  const sym = String(
    r.s ?? r.symbol ?? r.product_symbol ?? r.sy ?? "",
  ).trim();
  const p = extractStrictMarkPrice(r);
  if (sym && p != null && p > 0) cacheLiveMarkPrice(sym, p);
}

/** `ticker` / `v2/ticker` — mark_price field only (no LTP). */
function ingestTickerMessage(msg: Record<string, unknown>): void {
  const layers: unknown[] = [msg.d, msg.data];
  const payload = asRecord(msg.payload);
  if (payload) {
    layers.push(payload.d, payload.data, payload);
  }

  for (const layer of layers) {
    if (Array.isArray(layer)) {
      for (const row of layer) ingestTickerRow(row);
    } else {
      ingestTickerRow(layer);
    }
  }
}

function ingestMarkPriceChannelMessage(msg: Record<string, unknown>): void {
  const sy = String(msg.sy ?? msg.symbol ?? "");
  const p = num(msg.p ?? msg.mark_price);
  if (p == null || p <= 0) return;
  const product = sy.startsWith("MARK:") ? sy.slice(5) : sy;
  if (product.trim()) cacheLiveMarkPrice(product, p);
}

/**
 * Ingest Delta India public WS — **mark price only** (aligns with Delta Terminal PnL).
 */
export function ingestLivePriceWsMessage(raw: unknown): void {
  if (!raw || typeof raw !== "object") return;
  const msg = raw as Record<string, unknown>;
  const type = String(msg.type ?? "");

  if (type === "mark_price") {
    ingestMarkPriceChannelMessage(msg);
    return;
  }

  if (type === "v2/ticker" || type === "ticker") {
    ingestTickerMessage(msg);
  }
}
