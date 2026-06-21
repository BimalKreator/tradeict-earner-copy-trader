/** Delta product symbol → latest **mark** price (USD). */
export const liveMarkPrices = new Map<string, number>();
/** Top-of-book best bid — UPL@Bid for long options/perps. */
export const liveBestBids = new Map<string, number>();
/** Top-of-book best ask (offer) — UPL@Offer for short options/perps. */
export const liveBestAsks = new Map<string, number>();

type BtcMarkPriceListener = (price: number) => void;
let btcMarkPriceListener: BtcMarkPriceListener | null = null;

/** Secondary BTC tick source from mark_price WS channel (feeds breakeven). */
export function onBtcMarkPriceTick(listener: BtcMarkPriceListener): void {
  btcMarkPriceListener = listener;
}

function isBtcProductSymbol(raw: string): boolean {
  const s = raw.trim().toUpperCase();
  if (!s) return false;
  const compact = s.startsWith("MARK:") ? s.slice(5) : s;
  return (
    compact === "BTCUSDT" ||
    compact === "BTCUSD" ||
    compact === "BTC/USDT" ||
    compact === "BTC/USD:USD"
  );
}

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

function symbolAliasKeys(productSymbol: string): string[] {
  const raw = productSymbol.trim();
  if (!raw) return [];

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

  return [...keys];
}

function cacheNumericUnderAliases(
  map: Map<string, number>,
  productSymbol: string,
  price: number,
): void {
  if (!Number.isFinite(price) || price <= 0) return;
  for (const k of symbolAliasKeys(productSymbol)) {
    map.set(k, price);
  }
}

/** Store under product symbol and common perp aliases (ETHUSDT ↔ ETHUSD). */
export function cacheLiveMarkPrice(productSymbol: string, price: number): void {
  const raw = productSymbol.trim();
  if (!raw) return;

  cacheNumericUnderAliases(liveMarkPrices, raw, price);

  const base = raw.startsWith("MARK:") ? raw.slice(5) : raw;
  if (isBtcProductSymbol(raw) || isBtcProductSymbol(base)) {
    btcMarkPriceListener?.(price);
  }
}

/** Cache L2 best bid / best ask from ticker or orderbook WS. */
export function cacheLiveBestBid(productSymbol: string, bid: number): void {
  cacheNumericUnderAliases(liveBestBids, productSymbol, bid);
}

export function cacheLiveBestAsk(productSymbol: string, ask: number): void {
  cacheNumericUnderAliases(liveBestAsks, productSymbol, ask);
}

export function cacheLiveQuotes(
  productSymbol: string,
  quotes: { bid?: number | null; ask?: number | null; mark?: number | null },
): void {
  if (quotes.mark != null && Number.isFinite(quotes.mark) && quotes.mark > 0) {
    cacheLiveMarkPrice(productSymbol, quotes.mark);
  }
  if (quotes.bid != null && Number.isFinite(quotes.bid) && quotes.bid > 0) {
    cacheLiveBestBid(productSymbol, quotes.bid);
  }
  if (quotes.ask != null && Number.isFinite(quotes.ask) && quotes.ask > 0) {
    cacheLiveBestAsk(productSymbol, quotes.ask);
  }
}

function resolveFromAliasMap(
  map: Map<string, number>,
  symbolKey: string,
): number | null {
  for (const k of symbolAliasKeys(symbolKey)) {
    const p = map.get(k);
    if (p != null && Number.isFinite(p) && p > 0) return p;
  }
  return null;
}

export function resolveLiveMarkPrice(symbolKey: string): number | null {
  return resolveFromAliasMap(liveMarkPrices, symbolKey);
}

export function resolveLiveBestBid(symbolKey: string): number | null {
  return resolveFromAliasMap(liveBestBids, symbolKey);
}

export function resolveLiveBestAsk(symbolKey: string): number | null {
  return resolveFromAliasMap(liveBestAsks, symbolKey);
}

export function resolveLiveQuotes(symbolKey: string): {
  bestBid: number | null;
  bestAsk: number | null;
  markPrice: number | null;
} {
  return {
    bestBid: resolveLiveBestBid(symbolKey),
    bestAsk: resolveLiveBestAsk(symbolKey),
    markPrice: resolveLiveMarkPrice(symbolKey),
  };
}

export function deltaContractSizeFallback(symbol: string): number {
  const u = symbol.toUpperCase();
  if (u.includes("BTC")) return 0.001;
  if (u.includes("ETH")) return 0.01;
  return 1;
}

/** Delta v2/ticker nests top-of-book under `quotes.best_bid` / `quotes.best_ask`. */
function extractTickerBestBidAsk(row: Record<string, unknown>): {
  bid: number | null;
  ask: number | null;
} {
  const quotes =
    row.quotes != null && typeof row.quotes === "object"
      ? (row.quotes as Record<string, unknown>)
      : null;

  const bid =
    num(row.best_bid) ??
    num(row.bid_price) ??
    num(row.bid) ??
    (quotes ? num(quotes.best_bid) ?? num(quotes.bid) : null);

  const ask =
    num(row.best_ask) ??
    num(row.best_offer) ??
    num(row.offer_price) ??
    num(row.ask_price) ??
    num(row.ask) ??
    (quotes
      ? num(quotes.best_ask) ?? num(quotes.ask) ?? num(quotes.offer)
      : null);

  return { bid, ask };
}

function ingestTickerRow(row: unknown): void {
  const r = asRecord(row);
  if (!r) return;
  const sym = String(
    r.s ?? r.symbol ?? r.product_symbol ?? r.sy ?? "",
  ).trim();
  if (!sym) return;

  const mark = extractStrictMarkPrice(r);
  const { bid, ask } = extractTickerBestBidAsk(r);
  cacheLiveQuotes(sym, { mark, bid, ask });
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

function ingestL2OrderbookMessage(msg: Record<string, unknown>): void {
  const sym = String(
    msg.symbol ?? msg.product_symbol ?? msg.sy ?? msg.s ?? "",
  ).trim();
  if (!sym) return;

  const buy = msg.buy ?? msg.bids;
  const sell = msg.sell ?? msg.asks;
  let bid: number | null = null;
  let ask: number | null = null;

  if (Array.isArray(buy) && buy.length > 0) {
    const top = asRecord(buy[0]);
    bid = top ? num(top.price) : null;
  }
  if (Array.isArray(sell) && sell.length > 0) {
    const top = asRecord(sell[0]);
    ask = top ? num(top.price) : null;
  }

  cacheLiveQuotes(sym, { bid, ask });
}

/**
 * Ingest Delta India public WS — mark + L2 best bid/ask (UPL@Bid / UPL@Offer).
 */
export function ingestLivePriceWsMessage(raw: unknown): void {
  if (!raw || typeof raw !== "object") return;
  const msg = raw as Record<string, unknown>;
  const type = String(msg.type ?? "");

  if (type === "mark_price") {
    ingestMarkPriceChannelMessage(msg);
    return;
  }

  if (type === "l2_orderbook" || type === "l2orderbook") {
    const layers: unknown[] = [msg.d, msg.data, msg];
    const payload = asRecord(msg.payload);
    if (payload) layers.push(payload.d, payload.data, payload);
    for (const layer of layers) {
      if (Array.isArray(layer)) {
        for (const row of layer) {
          const r = asRecord(row);
          if (r) ingestL2OrderbookMessage(r);
        }
      } else {
        const r = asRecord(layer);
        if (r) ingestL2OrderbookMessage(r);
      }
    }
    return;
  }

  if (type === "v2/ticker" || type === "ticker") {
    ingestTickerMessage(msg);
  }
}
