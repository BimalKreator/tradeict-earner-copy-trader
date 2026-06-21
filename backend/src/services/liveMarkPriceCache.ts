/** Delta product symbol → latest **mark** price (USD). */
export const liveMarkPrices = new Map<string, number>();
/** Top-of-book best bid — UPL@Bid for long options/perps (L2 authoritative). */
export const liveBestBids = new Map<string, number>();
/** Top-of-book best ask (offer) — UPL@Offer for short options/perps (L2 authoritative). */
export const liveBestAsks = new Map<string, number>();
/** symbol alias → last WS/cache quote update (ms). */
const liveQuotesUpdatedAt = new Map<string, number>();

/** WS quotes younger than this skip REST L2/ticker polls. */
export const WS_QUOTE_FRESH_MS = Number(process.env.DELTA_WS_QUOTE_FRESH_MS) || 5_000;

type BtcMarkPriceListener = (price: number) => void;
type BidAskTickListener = (
  symbolKey: string,
  update: { bid?: number; ask?: number },
) => void;

let btcMarkPriceListener: BtcMarkPriceListener | null = null;
const bidAskTickListeners = new Set<BidAskTickListener>();

/** Secondary BTC tick source from mark_price WS channel (feeds breakeven). */
export function onBtcMarkPriceTick(listener: BtcMarkPriceListener): void {
  btcMarkPriceListener = listener;
}

/** Fired when L2 orderbook updates best bid and/or ask (not mark/ticker). */
export function onLiveBidAskTick(listener: BidAskTickListener): () => void {
  bidAskTickListeners.add(listener);
  return () => bidAskTickListeners.delete(listener);
}

function notifyBidAskTick(
  symbolKey: string,
  update: { bid?: number; ask?: number },
): void {
  for (const fn of bidAskTickListeners) {
    try {
      fn(symbolKey, update);
    } catch {
      /* ignore listener errors */
    }
  }
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

function touchQuoteFreshness(productSymbol: string): void {
  const at = Date.now();
  for (const k of symbolAliasKeys(productSymbol)) {
    liveQuotesUpdatedAt.set(k, at);
  }
}

function cacheNumericUnderAliases(
  map: Map<string, number>,
  productSymbol: string,
  price: number,
): boolean {
  if (!Number.isFinite(price) || price <= 0) return false;
  let changed = false;
  for (const k of symbolAliasKeys(productSymbol)) {
    const prev = map.get(k);
    if (prev !== price) changed = true;
    map.set(k, price);
  }
  if (changed) touchQuoteFreshness(productSymbol);
  return changed;
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

/** Cache L2 best bid / best ask from orderbook WS (authoritative for UPNL). */
export function cacheLiveBestBid(productSymbol: string, bid: number): boolean {
  return cacheNumericUnderAliases(liveBestBids, productSymbol, bid);
}

export function cacheLiveBestAsk(productSymbol: string, ask: number): boolean {
  return cacheNumericUnderAliases(liveBestAsks, productSymbol, ask);
}

export function cacheLiveQuotes(
  productSymbol: string,
  quotes: { bid?: number | null; ask?: number | null; mark?: number | null },
): void {
  if (quotes.mark != null && Number.isFinite(quotes.mark) && quotes.mark > 0) {
    cacheLiveMarkPrice(productSymbol, quotes.mark);
  }
  const bidChanged =
    quotes.bid != null && Number.isFinite(quotes.bid) && quotes.bid > 0
      ? cacheLiveBestBid(productSymbol, quotes.bid)
      : false;
  const askChanged =
    quotes.ask != null && Number.isFinite(quotes.ask) && quotes.ask > 0
      ? cacheLiveBestAsk(productSymbol, quotes.ask)
      : false;
  if (bidChanged || askChanged) {
    const tick: { bid?: number; ask?: number } = {};
    if (bidChanged && quotes.bid != null && quotes.bid > 0) tick.bid = quotes.bid;
    if (askChanged && quotes.ask != null && quotes.ask > 0) tick.ask = quotes.ask;
    notifyBidAskTick(productSymbol, tick);
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

/**
 * Option UPL quotes — WS cache only (may be stale while subscription warms up).
 * Never triggers REST; callers should subscribe via livePriceTracker separately.
 */
export function resolveOptionQuotesWsOnly(symbolKey: string): {
  bestBid: number | null;
  bestAsk: number | null;
  markPrice: number | null;
} {
  const q = resolveLiveQuotes(symbolKey);
  return {
    bestBid: q.bestBid != null && q.bestBid > 0 ? q.bestBid : null,
    bestAsk: q.bestAsk != null && q.bestAsk > 0 ? q.bestAsk : null,
    markPrice: q.markPrice != null && q.markPrice > 0 ? q.markPrice : null,
  };
}

function resolveQuoteUpdatedAt(symbolKey: string): number | null {
  let latest = 0;
  for (const k of symbolAliasKeys(symbolKey)) {
    const at = liveQuotesUpdatedAt.get(k);
    if (at != null && at > latest) latest = at;
  }
  return latest > 0 ? latest : null;
}

/** True when WS (or a recent REST seed) populated quotes within maxAgeMs. */
export function isLiveQuotesFresh(
  symbolKey: string,
  maxAgeMs: number = WS_QUOTE_FRESH_MS,
): boolean {
  const at = resolveQuoteUpdatedAt(symbolKey);
  if (at == null) return false;
  return Date.now() - at < maxAgeMs;
}

/** True when bid/ask/mark are present and still within WS freshness window. */
export function hasFreshTerminalQuotes(
  symbolKey: string,
  side?: "BUY" | "SELL",
): boolean {
  if (!isLiveQuotesFresh(symbolKey)) return false;
  const q = resolveLiveQuotes(symbolKey);
  if (side === "BUY") {
    return q.bestBid != null && q.bestBid > 0;
  }
  if (side === "SELL") {
    return q.bestAsk != null && q.bestAsk > 0;
  }
  return (
    (q.bestBid != null && q.bestBid > 0) ||
    (q.bestAsk != null && q.bestAsk > 0) ||
    (q.markPrice != null && q.markPrice > 0)
  );
}

export function deltaContractSizeFallback(symbol: string): number {
  const u = symbol.toUpperCase();
  if (u.includes("BTC")) return 0.001;
  if (u.includes("ETH")) return 0.01;
  return 1;
}

function ingestTickerRow(row: unknown): void {
  const r = asRecord(row);
  if (!r) return;
  const sym = String(
    r.s ?? r.symbol ?? r.product_symbol ?? r.sy ?? "",
  ).trim();
  if (!sym) return;

  // Ticker/mark feeds display mark only — bid/ask come from L2 orderbook + REST seed.
  const mark = extractStrictMarkPrice(r);
  if (mark != null && mark > 0) cacheLiveMarkPrice(sym, mark);
}

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
 * Ingest Delta India public WS — L2 bid/ask first-class; mark from mark/ticker only.
 */
export function ingestLivePriceWsMessage(raw: unknown): void {
  if (!raw || typeof raw !== "object") return;
  const msg = raw as Record<string, unknown>;
  const type = String(msg.type ?? "");

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

  if (type === "mark_price") {
    ingestMarkPriceChannelMessage(msg);
    return;
  }

  if (type === "v2/ticker" || type === "ticker") {
    ingestTickerMessage(msg);
  }
}
