import axios from "axios";
import ccxt from "ccxt";
import { createHmac } from "node:crypto";
import {
  decryptDeltaSecretOrPlain,
} from "../utils/encryption.js";

/** Delta Exchange India REST base (CCXT `delta` defaults to global `api.delta.exchange`). */
const DELTA_INDIA_API_BASE = "https://api.india.delta.exchange";

/** Delta India REST auth — METHOD + timestamp + path + query + body (see Delta API docs). */
function deltaIndiaRestSignature(
  secret: string,
  method: string,
  timestampSec: string,
  path: string,
  queryString: string,
  body: string,
): string {
  return createHmac("sha256", secret)
    .update(`${method}${timestampSec}${path}${queryString}${body}`)
    .digest("hex");
}

async function deltaIndiaSignedRequest<T>(args: {
  apiKey: string;
  secret: string;
  method: "GET" | "POST" | "DELETE";
  path: string;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
}): Promise<T> {
  const timestampSec = Math.floor(Date.now() / 1000).toString();
  const queryString = args.query
    ? `?${new URLSearchParams(args.query).toString()}`
    : "";
  const bodyStr =
    args.body && args.method !== "GET" ? JSON.stringify(args.body) : "";
  const signature = deltaIndiaRestSignature(
    args.secret,
    args.method,
    timestampSec,
    args.path,
    queryString,
    bodyStr,
  );

  const { data } = await axios.request<T & { success?: boolean; error?: unknown }>({
    method: args.method,
    url: `${DELTA_INDIA_API_BASE}${args.path}${queryString}`,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "api-key": args.apiKey,
      timestamp: timestampSec,
      signature,
    },
    data: bodyStr.length > 0 ? bodyStr : undefined,
    timeout: 25_000,
  });

  const row = data as { success?: boolean; error?: unknown };
  if (row.success === false) {
    const errMsg =
      typeof row.error === "object" && row.error !== null && "code" in row.error
        ? JSON.stringify(row.error)
        : String(row.error ?? "Delta REST request failed");
    throw new Error(errMsg);
  }

  return data;
}

async function resolveDeltaProductNumericId(
  productRef: string,
): Promise<{ symbol: string; productId: number; contractSize: number } | null> {
  const row = await fetchDeltaProductFromRestApi(productRef);
  if (!row) return null;

  const symbol = String(row.symbol ?? "").trim();
  const productId = Number(row.id);
  if (!symbol || !Number.isFinite(productId) || productId <= 0) return null;

  const contractValue = Number(row.contract_value ?? 0.001);
  const contractSize =
    Number.isFinite(contractValue) && contractValue > 0 ? contractValue : 0.001;

  return { symbol, productId, contractSize };
}

/**
 * Place a market order via Delta India REST (bypasses CCXT market catalogue).
 * Preferred for BTC options — CCXT loadMarkets often omits live option contracts.
 */
async function executeDeltaMarketOrderViaRest(
  apiKey: string,
  secret: string,
  productRef: string,
  side: TradeSide,
  size: number,
  opts?: { reduceOnly?: boolean; clientOrderId?: string },
): Promise<ExecuteTradeResult> {
  const lots = Math.max(1, Math.floor(Math.abs(size)));
  const resolved = await resolveDeltaProductNumericId(productRef);
  if (!resolved) {
    return {
      success: false,
      error: `Delta REST could not resolve product "${productRef}"`,
    };
  }

  const body: Record<string, unknown> = {
    product_id: resolved.productId,
    size: lots,
    side: side === "BUY" ? "buy" : "sell",
    order_type: "market_order",
  };
  if (opts?.reduceOnly === true) body.reduce_only = true;
  const clientOrderId = opts?.clientOrderId?.trim();
  if (clientOrderId) body.client_order_id = clientOrderId;

  try {
    const response = await deltaIndiaSignedRequest<{
      result?: Record<string, unknown>;
    }>({
      apiKey,
      secret,
      method: "POST",
      path: "/v2/orders",
      body,
    });

    const order = response.result;
    if (!order || typeof order !== "object") {
      return { success: false, error: "Delta REST order returned empty result" };
    }

    const fillPrice =
      numberOrNull(order.average_fill_price) ??
      numberOrNull(order.average_price) ??
      numberOrNull(order.price);
    const feeCost =
      numberOrNull(order.paid_commission) ??
      numberOrNull(order.commission) ??
      (fillPrice != null && fillPrice > 0
        ? lots * resolved.contractSize * fillPrice * 0.0005
        : 0);

    const orderIdRaw = order.id;
    const orderId =
      orderIdRaw != null && String(orderIdRaw).trim()
        ? String(orderIdRaw)
        : undefined;

    return {
      success: true,
      ...(orderId ? { orderId } : {}),
      ...(clientOrderId ? { clientOrderId } : {}),
      ...(fillPrice != null && fillPrice > 0 ? { fillPrice } : {}),
      feeCost: Number.isFinite(feeCost) ? Math.max(0, feeCost!) : 0,
      raw: order,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[copy-exec] Delta REST market order failed product=${resolved.symbol} lots=${lots}:`,
      message,
    );
    return { success: false, error: message };
  }
}

/** Authenticated margined positions via Delta REST — no CCXT loadMarkets required. */
async function fetchMarginedPositionsViaRest(
  apiKey: string,
  secret: string,
): Promise<unknown[]> {
  const response = await deltaIndiaSignedRequest<{ result?: unknown[] }>({
    apiKey,
    secret,
    method: "GET",
    path: "/v2/positions/margined",
  });
  return Array.isArray(response.result) ? response.result : [];
}

/**
 * Single factory for `ccxt.delta`: swap markets, rate limit, and **Delta India** REST URLs
 * (required for India API keys and tickers).
 *
 * The India URL override is passed at construction time (CCXT's `describe()` merge
 * runs once during `new ccxt.delta(...)` — overriding `urls.api` post-hoc misses
 * any handler that already snapshotted the default global endpoint, which
 * surfaces as `invalid_api_key` on signed REST calls). The post-construction
 * assignment is kept as a belt-and-braces in case a future CCXT release adds
 * another API path key.
 *
 * API key / secret are trimmed because trailing whitespace from env vars or
 * DB-stored values is the most common source of `invalid_api_key` errors.
 */
export function initializeDeltaClient(
  apiKey?: string,
  secret?: string,
): InstanceType<typeof ccxt.delta> {
  const trimmedKey = apiKey?.trim() ?? "";
  const trimmedSecret = secret?.trim() ?? "";

  const exchange = new ccxt.delta({
    enableRateLimit: true,
    options: {
      defaultType: "swap",
    },
    urls: {
      api: {
        public: DELTA_INDIA_API_BASE,
        private: DELTA_INDIA_API_BASE,
      },
    },
    ...(trimmedKey !== "" ? { apiKey: trimmedKey } : {}),
    ...(trimmedSecret !== "" ? { secret: trimmedSecret } : {}),
  });
  exchange.urls.api = {
    public: DELTA_INDIA_API_BASE,
    private: DELTA_INDIA_API_BASE,
  };
  return exchange;
}

let _publicClient: InstanceType<typeof ccxt.delta> | null = null;
let _publicMarketsLoaded = false;

async function getPublicClient(): Promise<InstanceType<typeof ccxt.delta>> {
  if (!_publicClient) _publicClient = initializeDeltaClient();
  if (!_publicMarketsLoaded) {
    await _publicClient.loadMarkets();
    _publicMarketsLoaded = true;
  }
  return _publicClient;
}

const _authClientCache = new Map<
  string,
  { client: InstanceType<typeof ccxt.delta>; marketsLoaded: boolean }
>();

async function getAuthClient(
  apiKey: string,
  secret: string,
): Promise<InstanceType<typeof ccxt.delta>> {
  // Debug: confirm the credentials CCXT actually receives match the keys
  // stored in the admin panel. `apiKey` here is post-decryption plaintext;
  // mismatched output → encryption key drift or stale cache, not a CCXT bug.
  const maskedKey =
    apiKey.length > 5 ? apiKey.substring(0, 5) + "***" : "INVALID_LENGTH";
  console.log(
    `[DEBUG_AUTH] Initializing CCXT for API Key starting with: ${maskedKey}`,
  );

  const cacheKey = `${apiKey}::${secret}`;
  let entry = _authClientCache.get(cacheKey);
  if (!entry) {
    entry = {
      client: initializeDeltaClient(apiKey, secret),
      marketsLoaded: false,
    };
    _authClientCache.set(cacheKey, entry);
  }
  if (!entry.marketsLoaded) {
    await entry.client.loadMarkets();
    entry.marketsLoaded = true;
  }
  return entry.client;
}

/** Drop cached CCXT clients after master credentials change. */
export function clearDeltaAuthClientCache(): void {
  _authClientCache.clear();
  _optionMarketCache.clear();
}

export type TradeSide = "BUY" | "SELL";

/** Delta India: positive signed size/lots = long (BUY), negative = short (SELL). */
export function tradeSideFromSignedSize(rawSize: number): TradeSide {
  if (rawSize > 0) return "BUY";
  if (rawSize < 0) return "SELL";
  return "BUY";
}

export interface ExecuteTradeResult {
  success: boolean;
  orderId?: string;
  /** Correlates exchange order ↔ {@link TradePosition.clientOrderId}. */
  clientOrderId?: string;
  /** Actual average fill from CCXT order (preferred over LTP for PnL). */
  fillPrice?: number;
  feeCost?: number;
  raw?: unknown;
  error?: string;
}

function extractFillPriceFromOrder(raw: unknown): number | null {
  if (raw == null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  return (
    numberOrNull(o.average) ??
    numberOrNull(o.price) ??
    numberOrNull(o.last) ??
    null
  );
}

function numberOrNull(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function extractDeltaMarkPrice(position: Record<string, unknown>): number | null {
  const product =
    position.product != null && typeof position.product === "object"
      ? (position.product as Record<string, unknown>)
      : null;

  return (
    numberOrNull(position.mark_price) ??
    numberOrNull(position.markPrice) ??
    numberOrNull(product?.mark_price) ??
    numberOrNull(product?.markPrice)
  );
}

/** Bid/offer from margined position or nested product (matches Delta UPNL@Bid / UPNL@Offer). */
function extractDeltaBidOffer(position: Record<string, unknown>): {
  bid: number | null;
  offer: number | null;
} {
  const product =
    position.product != null && typeof position.product === "object"
      ? (position.product as Record<string, unknown>)
      : null;

  const bid =
    numberOrNull(position.best_bid) ??
    numberOrNull(position.bid_price) ??
    numberOrNull(position.bid) ??
    numberOrNull(product?.best_bid) ??
    numberOrNull(product?.bid_price);

  const offer =
    numberOrNull(position.best_ask) ??
    numberOrNull(position.best_offer) ??
    numberOrNull(position.offer_price) ??
    numberOrNull(position.ask_price) ??
    numberOrNull(position.ask) ??
    numberOrNull(product?.best_ask) ??
    numberOrNull(product?.offer_price);

  return { bid, offer };
}

/**
 * Delta terminal options UPNL: longs mark at **bid**, shorts at **offer** (not mid mark).
 */
async function resolveOptionUpnlPrice(
  exchange: InstanceType<typeof ccxt.delta>,
  unified: string,
  position: Record<string, unknown>,
  side: TradeSide,
  displayMark: number | null,
): Promise<{ price: number | null; source: string }> {
  const { bid, offer } = extractDeltaBidOffer(position);

  if (side === "BUY" && bid != null && bid > 0) {
    return { price: bid, source: "bid" };
  }
  if (side === "SELL" && offer != null && offer > 0) {
    return { price: offer, source: "offer" };
  }

  try {
    const ticker = await exchange.fetchTicker(unified);
    if (side === "BUY") {
      const tbid = numberOrNull(ticker.bid);
      if (tbid != null && tbid > 0) return { price: tbid, source: "ticker_bid" };
    } else {
      const task = numberOrNull(ticker.ask);
      if (task != null && task > 0) return { price: task, source: "ticker_ask" };
    }
  } catch {
    /* use display mark */
  }

  return { price: displayMark, source: "mark_fallback" };
}

/**
 * Options UPNL price without CCXT ticker — bid (long) / offer (short) from margined REST.
 * Matches {@link resolveOptionUpnlPrice} when payload includes bid/offer; falls back to mark.
 */
function resolveOptionUpnlPriceSync(
  position: Record<string, unknown>,
  side: TradeSide,
  displayMark: number | null,
): number | null {
  const { bid, offer } = extractDeltaBidOffer(position);
  if (side === "BUY" && bid != null && bid > 0) return bid;
  if (side === "SELL" && offer != null && offer > 0) return offer;
  return displayMark;
}

type OptionTickerQuote = { bid: number | null; ask: number | null };

/** Prefetch bid/ask for open options — Delta terminal UPNL uses bid (long) / offer (short), not mark. */
async function prefetchOptionTickerQuotes(
  productSymbols: string[],
): Promise<Map<string, OptionTickerQuote>> {
  const cache = new Map<string, OptionTickerQuote>();
  const unique = [...new Set(productSymbols.map((s) => s.trim()).filter(Boolean))];
  if (unique.length === 0) return cache;

  const exchange = await getPublicClient();
  await Promise.all(
    unique.map(async (sym) => {
      try {
        const ccxtSymbol = resolveCcxtSymbol(exchange, sym);
        const ticker = await exchange.fetchTicker(ccxtSymbol);
        cache.set(sym, {
          bid: numberOrNull(ticker.bid),
          ask: numberOrNull(ticker.ask),
        });
      } catch {
        cache.set(sym, { bid: null, ask: null });
      }
    }),
  );
  return cache;
}

function collectOpenOptionProductSymbols(rawList: unknown[]): string[] {
  const out: string[] = [];
  for (const row of rawList) {
    if (!row || typeof row !== "object") continue;
    const position = row as Record<string, unknown>;
    const info =
      position.info != null && typeof position.info === "object"
        ? (position.info as Record<string, unknown>)
        : null;
    const rawSize =
      numberOrNull(position.size) ??
      numberOrNull(info?.size) ??
      numberOrNull(position.contracts);
    if (rawSize === null || Math.abs(rawSize) < 1e-12) continue;
    const productSymbol = String(
      position.product_symbol ?? position.product_id ?? "",
    ).trim();
    if (productSymbol && isDeltaOptionProductId(productSymbol)) {
      out.push(productSymbol);
    }
  }
  return out;
}

/** Lite options UPNL — REST bid/offer first, then prefetched ticker, mark last. */
function resolveOptionUpnlPriceLite(
  position: Record<string, unknown>,
  side: TradeSide,
  displayMark: number | null,
  productSymbol: string,
  tickerCache: Map<string, OptionTickerQuote>,
): number | null {
  const fromRest = resolveOptionUpnlPriceSync(position, side, null);
  if (fromRest != null) return fromRest;

  const cached = tickerCache.get(productSymbol.trim());
  if (cached) {
    if (side === "BUY" && cached.bid != null && cached.bid > 0) return cached.bid;
    if (side === "SELL" && cached.ask != null && cached.ask > 0) return cached.ask;
  }
  return displayMark;
}

function computePositionUnrealizedPnl(args: {
  isOption: boolean;
  side: TradeSide;
  entryPrice: number | null;
  markPrice: number | null;
  realBaseSize: number;
  position: Record<string, unknown>;
  lite: boolean;
}): number | null {
  const { isOption, side, entryPrice, markPrice, realBaseSize, position, lite } =
    args;

  if (entryPrice === null) return null;

  let upnlPrice: number | null = markPrice;
  if (isOption) {
    upnlPrice = resolveOptionUpnlPriceSync(position, side, markPrice);
  }

  if (upnlPrice === null) {
    if (!isOption && lite) {
      return parseApiUnrealizedPnl(position);
    }
    return null;
  }

  const sign = side === "SELL" ? -1 : 1;
  let unrealizedPnl = realBaseSize * (upnlPrice - entryPrice) * sign;

  const funding = parseFloat(String(position.unrealized_funding_pnl ?? "0"));
  if (!Number.isNaN(funding)) unrealizedPnl += funding;

  if (Number.isNaN(unrealizedPnl)) return null;
  return unrealizedPnl;
}

function deltaContractValueFromMarket(
  market: { contractSize?: unknown },
  position: Record<string, unknown>,
): number {
  const fromMarket = numberOrNull(market.contractSize);
  if (fromMarket != null && fromMarket > 0) return fromMarket;

  const product = position.product;
  if (product != null && typeof product === "object") {
    const cv = numberOrNull((product as Record<string, unknown>).contract_value);
    if (cv != null && cv > 0) return cv;
  }

  const cvDirect = numberOrNull(position.contract_value);
  if (cvDirect != null && cvDirect > 0) return cvDirect;

  return 1;
}

/**
 * Delta `size` → signed BTC (terminal shows ±0.1 BTC).
 * Integer values are contract counts × contract_value; fractional values are already BTC.
 */
function deltaSignedBtcSize(rawSize: number, contractValue: number): number {
  const abs = Math.abs(rawSize);
  if (abs < 1e-12) return 0;

  const isWholeContractCount =
    Number.isInteger(abs) && abs >= 1 && contractValue > 0 && contractValue < 1;

  if (isWholeContractCount) {
    return rawSize * contractValue;
  }

  if (!Number.isInteger(abs) && abs <= 10) {
    return rawSize;
  }

  if (contractValue !== 1) {
    return rawSize * contractValue;
  }

  return rawSize;
}

/**
 * Absolute contract/lot count for CCXT `createOrder` amount and copy-trade sizing.
 * Delta margined API `size` is usually integer lots; {@link deltaSignedBtcSize} converts to base for PnL only.
 */
function deltaContractLotCount(
  rawSize: number,
  contractSize: number,
  signedBaseSize: number,
): number {
  const absRaw = Math.abs(rawSize);
  if (absRaw < 1e-12) return 0;

  const cs = contractSize > 0 ? contractSize : 1;

  if (Number.isInteger(absRaw) && absRaw >= 1) {
    return absRaw;
  }

  const absBase = Math.abs(signedBaseSize);
  if (cs > 0 && cs < 1 && absBase > 1e-12) {
    const lots = absBase / cs;
    if (Number.isFinite(lots) && lots >= 1) {
      return Math.max(1, Math.round(lots));
    }
  }

  return absRaw;
}

function extractFeeCostFromOrder(order: unknown): number | null {
  if (order == null || typeof order !== "object") return null;
  const o = order as {
    fee?: { cost?: unknown } | null;
    fees?: Array<{ cost?: unknown } | null> | null;
  };
  const direct = numberOrNull(o.fee?.cost);
  if (direct != null) return Math.abs(direct);
  if (Array.isArray(o.fees)) {
    const sum = o.fees.reduce((acc, f) => acc + (numberOrNull(f?.cost) ?? 0), 0);
    if (Number.isFinite(sum) && sum > 0) return Math.abs(sum);
  }
  return null;
}

/** Normalized open perpetual position from Delta (for dashboards). */
export interface DeltaLivePosition {
  /** CCXT unified symbol (Delta India linear perps: e.g. ETH/USD:USD) */
  symbol: string;
  /** Compact ticker-style id aligned with copy-trade symbols (e.g. ETHUSDT). */
  symbolKey: string;
  side: TradeSide;
  /**
   * Absolute contract / lot count (`contracts` or `amount` from CCXT).
   * For notional PnL use {@link realBaseSize}.
   */
  contracts: number;
  /** `contracts × (exchange.market(symbol).contractSize || 1)` in base asset units. */
  realBaseSize: number;
  entryPrice: number | null;
  markPrice: number | null;
  unrealizedPnl: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  entryTime: string | null;
}

/** REST margined snapshot — open legs plus explicit zero-size rows for UI cache eviction. */
export type DeltaMarginedPositionSnapshot = {
  open: DeltaLivePosition[];
  /** `${symbolKey}:${side}` rows where REST returned size/contracts === 0 */
  explicitFlatLegKeys: string[];
};

/** When `lite: true`, skip per-row CCXT tickers (admin live-trades master poll). */
export type FetchMarginedSnapshotOptions = {
  lite?: boolean;
  /** Bypass 8s snapshot TTL (still shares in-flight dedupe). */
  skipCache?: boolean;
};

/** One margined snapshot per account at a time; 4s TTL avoids duplicate Delta REST under load. */
const MARGINED_SNAPSHOT_TTL_MS = 4_000;
const marginedSnapshotCache = new Map<
  string,
  { at: number; snapshot: DeltaMarginedPositionSnapshot }
>();
const marginedSnapshotInflight = new Map<
  string,
  Promise<DeltaMarginedPositionSnapshot>
>();

function marginedSnapshotCacheKey(
  apiKeyStored: string,
  apiSecretStored: string,
): string {
  const k = decryptDeltaSecretOrPlain(apiKeyStored);
  const s = decryptDeltaSecretOrPlain(apiSecretStored);
  return `${k}::${s}`;
}

/** Lightweight symbol key for flat legs — avoids CCXT `market()` on zero-size rows. */
function fastFlatLegSymbolKey(productSymbol: string): string {
  const ps = productSymbol.trim();
  if (isDeltaOptionProductId(ps)) return ps;
  return unifiedSymbolToKey(normalizeDeltaPerpSymbolForCcxt(ps));
}

function parseApiUnrealizedPnl(position: Record<string, unknown>): number | null {
  const apiUpnlRaw = position.unrealized_pnl;
  if (apiUpnlRaw === undefined || apiUpnlRaw === null) return null;
  const upnl = parseFloat(String(apiUpnlRaw));
  if (!Number.isFinite(upnl)) return null;
  const funding = parseFloat(String(position.unrealized_funding_pnl ?? "0"));
  if (!Number.isNaN(funding)) return upnl + funding;
  return upnl;
}

export function deltaLiveLegKey(symbolKey: string, side: TradeSide): string {
  return `${symbolKey}:${side}`;
}

function normalizePositionSide(raw: unknown): TradeSide | null {
  const s = String(raw ?? "").toLowerCase();
  if (s === "buy" || s === "long") return "BUY";
  if (s === "sell" || s === "short") return "SELL";
  return null;
}

/**
 * Converts compact keys (e.g. `ETHUSDT`, `ETHUSD`) or partial unified symbols into
 * CCXT swap symbols for **Delta Exchange India** (`api.india.delta.exchange`).
 * India linear perps use `BASE/USD:USD`, not `BASE/USDT:USDT` (those markets do not exist there).
 */
export function normalizeDeltaPerpSymbolForCcxt(raw: string): string {
  const s = raw.trim();
  if (!s) return s;

  if (s.includes("/")) {
    const colonIdx = s.indexOf(":");
    if (colonIdx !== -1) {
      const u = s.toUpperCase();
      if (u.endsWith("/USDT:USDT")) {
        const slash = s.indexOf("/");
        const base = s.slice(0, slash);
        return `${base.toUpperCase()}/USD:USD`;
      }
      return s;
    }

    const slash = s.indexOf("/");
    const base = s.slice(0, slash);
    const quote = s.slice(slash + 1);
    const q = quote.toUpperCase();

    if (q === "USDT" || q === "USD") return `${base.toUpperCase()}/USD:USD`;

    return s;
  }

  const upper = s.toUpperCase();
  const usdt = upper.match(/^([A-Z0-9]{2,})(USDT)$/);
  if (usdt) return `${usdt[1]}/USD:USD`;
  const usd = upper.match(/^([A-Z0-9]{2,})USD$/);
  if (usd) return `${usd[1]}/USD:USD`;

  return s;
}

/** Delta options product ids (Calls / Puts) — use market id as-is, not USDT aliases. */
export function isDeltaOptionProductId(raw: string): boolean {
  const u = raw.trim().toUpperCase();
  return u.startsWith("C-") || u.startsWith("P-");
}

/** Valid Delta option id: `C-BTC-64000-260626` (type-underlying-strike-ddmmyy). */
export function isValidDeltaOptionProductSymbol(raw: string): boolean {
  const s = raw.trim();
  if (!isDeltaOptionProductId(s)) return false;
  return /^(C|P)-[A-Z0-9]+-\d+-\d{6}$/i.test(s);
}

function marketIdMatches(a: string, b: string): boolean {
  return a.trim().toUpperCase() === b.trim().toUpperCase();
}

/**
 * Strict CCXT market lookup by Delta product id — no fuzzy `exchange.market()` matching.
 * Options must resolve to the exact strike/expiry id or null.
 */
export function findCcxtMarketByExactProductId(
  exchange: InstanceType<typeof ccxt.delta>,
  productRef: string,
): ReturnType<InstanceType<typeof ccxt.delta>["market"]> | null {
  const ref = productRef.trim();
  if (!ref) return null;

  const marketsById = exchange.markets_by_id as
    | Record<string, ReturnType<InstanceType<typeof ccxt.delta>["market"]>>
    | undefined;

  if (marketsById && typeof marketsById === "object") {
    if (marketsById[ref]) return marketsById[ref] ?? null;
    for (const [key, market] of Object.entries(marketsById)) {
      if (marketIdMatches(key, ref)) return market ?? null;
    }
  }

  const markets = exchange.markets;
  if (markets != null && typeof markets === "object") {
    for (const market of Object.values(markets)) {
      if (!market) continue;
      const id = String(market.id ?? "").trim();
      if (!id) continue;
      if (marketIdMatches(id, ref)) return market;
      const info =
        market.info != null && typeof market.info === "object"
          ? (market.info as Record<string, unknown>)
          : null;
      const infoProductId = String(
        info?.product_id ?? info?.productId ?? "",
      ).trim();
      if (infoProductId && infoProductId === ref) return market;
      const infoSymbol = String(
        info?.symbol ?? info?.product_symbol ?? "",
      ).trim();
      if (
        infoSymbol &&
        isValidDeltaOptionProductSymbol(infoSymbol) &&
        marketIdMatches(infoSymbol, ref)
      ) {
        return market;
      }
    }
  }

  return null;
}

export type ResolvedExactDeltaProduct = {
  /** Canonical Delta product id (e.g. C-BTC-64000-260626). */
  productId: string;
  /** CCXT unified symbol for createOrder. */
  ccxtSymbol: string;
};

/**
 * Resolve a WS/REST product reference to the exact Delta option product id.
 * Returns null when strike cannot be determined — never guess a nearby contract.
 */
export function resolveExactDeltaProductFromMarkets(
  exchange: InstanceType<typeof ccxt.delta>,
  raw: string,
): ResolvedExactDeltaProduct | null {
  const ref = raw.trim();
  if (!ref) return null;

  if (isValidDeltaOptionProductSymbol(ref)) {
    const market = findCcxtMarketByExactProductId(exchange, ref);
    if (!market?.symbol) {
      console.error(
        `[exchangeService] option product ${ref} not found in CCXT markets — refusing fuzzy match`,
      );
      return null;
    }
    const productId = String(market.id ?? ref).trim();
    if (!isValidDeltaOptionProductSymbol(productId)) {
      console.error(
        `[exchangeService] CCXT market id "${productId}" for ref ${ref} is not a valid option id`,
      );
      return null;
    }
    return { productId, ccxtSymbol: market.symbol };
  }

  if (/^\d+$/.test(ref)) {
    const market = findCcxtMarketByExactProductId(exchange, ref);
    if (!market?.symbol) {
      console.error(
        `[exchangeService] numeric product_id ${ref} did not resolve in CCXT markets_by_id`,
      );
      return null;
    }
    const productId = String(market.id ?? "").trim();
    if (!isValidDeltaOptionProductSymbol(productId)) {
      console.error(
        `[exchangeService] numeric product_id ${ref} mapped to non-option market id=${productId}`,
      );
      return null;
    }
    return { productId, ccxtSymbol: market.symbol };
  }

  return null;
}

/** In-memory cache — CCXT loadMarkets() omits many live BTC options on Delta India. */
const _optionMarketCache = new Map<string, CcxtOptionMarket>();

function isCryptoJsAesCiphertext(stored: string): boolean {
  return stored.trim().startsWith("U2Fsd");
}

type CcxtOptionMarket = {
  id: string;
  symbol: string;
  base: string;
  quote: string;
  settle: string;
  type: "option";
  spot: boolean;
  margin: boolean;
  swap: boolean;
  future: boolean;
  option: boolean;
  active: boolean;
  contract: boolean;
  linear: boolean;
  contractSize: number;
  strike?: number;
  expiry?: number;
  precision: { amount: number; price: number };
  limits: {
    amount: { min: number; max: number | undefined };
    price: { min: number; max: number | undefined };
  };
  info: Record<string, unknown>;
};

function tickSizeToPricePrecision(tickSize: number): number {
  if (!Number.isFinite(tickSize) || tickSize <= 0) return 1;
  if (tickSize >= 1) return 1;
  const frac = String(tickSize).split(".")[1];
  return Math.max(1, frac ? frac.length : 1);
}

function buildCcxtOptionMarketFromDeltaProduct(
  row: Record<string, unknown>,
): CcxtOptionMarket | null {
  const productId = String(row.symbol ?? "").trim();
  if (!isValidDeltaOptionProductSymbol(productId)) return null;

  const contractValue = Number(row.contract_value ?? 0.001);
  const contractSize =
    Number.isFinite(contractValue) && contractValue > 0 ? contractValue : 0.001;
  const strikeRaw = Number(row.strike_price ?? NaN);
  const strike = Number.isFinite(strikeRaw) && strikeRaw > 0 ? strikeRaw : undefined;
  const settlementTime = String(row.settlement_time ?? "");
  const expiryParsed = expiryMsFromSettlement(settlementTime);
  const expiry =
    expiryParsed != null && Number.isFinite(expiryParsed) ? expiryParsed : undefined;
  const underlying =
    row.underlying_asset != null && typeof row.underlying_asset === "object"
      ? (row.underlying_asset as Record<string, unknown>)
      : null;
  const quoting =
    row.quoting_asset != null && typeof row.quoting_asset === "object"
      ? (row.quoting_asset as Record<string, unknown>)
      : null;
  const base = String(underlying?.symbol ?? "BTC").trim() || "BTC";
  const quote = String(quoting?.symbol ?? "USD").trim() || "USD";
  const tickSize = Number(row.tick_size ?? 0.1);
  const state = String(row.state ?? "live").trim().toLowerCase();

  return {
    id: productId,
    symbol: productId,
    base,
    quote,
    settle: quote,
    type: "option",
    spot: false,
    margin: false,
    swap: false,
    future: false,
    option: true,
    active: state === "live" || state === "operational",
    contract: true,
    linear: true,
    contractSize,
    ...(strike != null ? { strike } : {}),
    ...(expiry != null ? { expiry } : {}),
    precision: {
      amount: 0,
      price: tickSizeToPricePrecision(tickSize),
    },
    limits: {
      amount: { min: 1, max: undefined },
      price: {
        min: Number.isFinite(tickSize) && tickSize > 0 ? tickSize : 0.1,
        max: undefined,
      },
    },
    info: row,
  };
}

function registerOptionMarketOnExchange(
  exchange: InstanceType<typeof ccxt.delta>,
  market: CcxtOptionMarket,
): void {
  const ex = exchange as InstanceType<typeof ccxt.delta> & {
    markets?: Record<string, CcxtOptionMarket>;
    markets_by_id?: Record<string, CcxtOptionMarket>;
  };

  if (ex.markets == null || typeof ex.markets !== "object") {
    ex.markets = {};
  }
  ex.markets[market.symbol] = market;

  if (ex.markets_by_id == null || typeof ex.markets_by_id !== "object") {
    ex.markets_by_id = {};
  }
  ex.markets_by_id[market.id] = market;
  ex.markets_by_id[market.symbol] = market;

  const numericId = String(market.info.id ?? "").trim();
  if (numericId) {
    ex.markets_by_id[numericId] = market;
  }
}

/**
 * Delta India public REST — CCXT loadMarkets() often omits live option contracts.
 * GET /v2/products/{symbol|numeric_id}
 */
async function fetchDeltaProductFromRestApi(
  productRef: string,
): Promise<Record<string, unknown> | null> {
  const ref = productRef.trim();
  if (!ref) return null;

  try {
    const { data } = await axios.get<{ success?: boolean; result?: unknown }>(
      `${DELTA_INDIA_API_BASE}/v2/products/${encodeURIComponent(ref)}`,
      { timeout: 20_000 },
    );
    if (
      data?.success === true &&
      data.result != null &&
      typeof data.result === "object" &&
      !Array.isArray(data.result)
    ) {
      return data.result as Record<string, unknown>;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[exchangeService] fetchDeltaProductFromRestApi failed ref=${ref}: ${msg}`,
    );
  }

  return null;
}

function cacheOptionMarket(productRef: string, market: CcxtOptionMarket): void {
  const keys = new Set<string>([
    productRef.trim().toUpperCase(),
    market.id.toUpperCase(),
    market.symbol.toUpperCase(),
  ]);
  const numericId = String(market.info.id ?? "").trim();
  if (numericId) keys.add(numericId);
  for (const key of keys) {
    if (key) _optionMarketCache.set(key, market);
  }
}

/**
 * Hydrate a single option contract into the CCXT exchange instance from Delta REST.
 * Required because CCXT `loadMarkets()` with defaultType=swap skips most options.
 */
export async function hydrateExactDeltaOptionOnExchange(
  exchange: InstanceType<typeof ccxt.delta>,
  productRef: string,
): Promise<ResolvedExactDeltaProduct | null> {
  const ref = productRef.trim();
  if (!ref) return null;

  const fromCcxt = resolveExactDeltaProductFromMarkets(exchange, ref);
  if (fromCcxt) return fromCcxt;

  const cacheKey = ref.toUpperCase();
  const cachedMarket = _optionMarketCache.get(cacheKey);
  if (cachedMarket) {
    registerOptionMarketOnExchange(exchange, cachedMarket);
    return {
      productId: cachedMarket.id,
      ccxtSymbol: cachedMarket.symbol,
    };
  }

  const row = await fetchDeltaProductFromRestApi(ref);
  if (!row) {
    console.error(
      `[exchangeService] option product ${ref} not found via CCXT or Delta REST`,
    );
    return null;
  }

  const market = buildCcxtOptionMarketFromDeltaProduct(row);
  if (!market) {
    console.error(
      `[exchangeService] REST product ${ref} is not a valid option symbol (symbol=${String(row.symbol ?? "")})`,
    );
    return null;
  }

  registerOptionMarketOnExchange(exchange, market);
  cacheOptionMarket(ref, market);

  const resolved: ResolvedExactDeltaProduct = {
    productId: market.id,
    ccxtSymbol: market.symbol,
  };

  console.log(
    `[exchangeService] hydrated option market from REST: ${resolved.productId} → ccxt=${resolved.ccxtSymbol}`,
  );
  return resolved;
}

/** Extract product id from Delta WS/REST payloads — options prefer `product_symbol` verbatim. */
export function extractDeltaProductSymbolFromPayload(
  o: Record<string, unknown>,
): string {
  const product =
    o.product != null && typeof o.product === "object" && !Array.isArray(o.product)
      ? (o.product as Record<string, unknown>)
      : null;

  const optionSymbolCandidates: unknown[] = [
    o.product_symbol,
    product?.product_symbol,
    product?.symbol,
    o.contract_symbol,
    o.instrument_name,
    o.derivative_symbol,
  ];

  for (const c of optionSymbolCandidates) {
    const s = String(c ?? "").trim();
    if (s && isValidDeltaOptionProductSymbol(s)) return s;
  }

  const genericSymbol = String(o.symbol ?? "").trim();
  if (genericSymbol && isValidDeltaOptionProductSymbol(genericSymbol)) {
    return genericSymbol;
  }

  for (const c of optionSymbolCandidates) {
    const s = String(c ?? "").trim();
    if (s && !/^\d+$/.test(s)) return s;
  }

  if (genericSymbol && !/^\d+$/.test(genericSymbol)) return genericSymbol;

  const productId = o.product_id ?? product?.id;
  if (productId != null) {
    const pid = String(productId).trim();
    if (pid) return pid;
  }

  return "";
}

export async function resolveCanonicalDeltaProductId(
  raw: string,
  exchange?: InstanceType<typeof ccxt.delta>,
): Promise<ResolvedExactDeltaProduct | null> {
  const ref = raw.trim();
  if (!ref) return null;

  if (isDeltaOptionProductId(ref) || /^\d+$/.test(ref)) {
    const ex = exchange ?? (await getPublicClient());
    const fromCcxt = resolveExactDeltaProductFromMarkets(ex, ref);
    if (fromCcxt) return fromCcxt;
    return hydrateExactDeltaOptionOnExchange(ex, ref);
  }

  return null;
}

/**
 * After `loadMarkets()`, map a Delta product id or trading label to CCXT unified symbol.
 * Options require an exact markets_by_id hit — no swap/perp fallback.
 */
export function resolveCcxtSymbol(
  exchange: InstanceType<typeof ccxt.delta>,
  tradingSymbol: string,
): string {
  const raw = tradingSymbol.trim();
  if (!raw) return raw;

  if (isDeltaOptionProductId(raw) || /^\d+$/.test(raw)) {
    const exact = resolveExactDeltaProductFromMarkets(exchange, raw);
    if (!exact) {
      throw new Error(
        `Cannot resolve exact Delta option product for "${raw}" — refusing to guess strike`,
      );
    }
    return exact.ccxtSymbol;
  }

  const markets = exchange.markets;
  if (markets != null && typeof markets === "object") {
    const market = Object.values(markets).find((m) => m?.id === raw);
    if (market?.symbol) return market.symbol;
  }

  const swap = resolveDeltaIndiaSwapUnifiedSymbol(exchange, raw);
  if (swap) return swap;

  return normalizeDeltaPerpSymbolForCcxt(raw);
}

/** Boot-time check: compact key used in copy-trade rows → CCXT symbol on Delta India. */
export const DELTA_INDIA_CCXT_SAMPLE_SYMBOL =
  normalizeDeltaPerpSymbolForCcxt("ETHUSDT");

/**
 * Map CCXT unified swap symbol to compact keys aligned with copy-trade symbols (…USDT).
 * Delta India returns `BASE/USD:USD`; we normalize to `BASEUSDT` for display and matching.
 */
function unifiedSymbolToKey(unifiedSymbol: string): string {
  const slash = unifiedSymbol.indexOf("/");
  if (slash === -1) return unifiedSymbol.replace(/[/:]/g, "").toUpperCase();
  const base = unifiedSymbol.slice(0, slash);
  const after = unifiedSymbol.slice(slash + 1);
  const colon = after.indexOf(":");
  const quote = colon === -1 ? after : after.slice(0, colon);
  const settle = colon === -1 ? "" : after.slice(colon + 1);
  const q = quote.toUpperCase();
  const st = settle.toUpperCase();
  if (q === "USD" && st === "USD") return `${base}USDT`.toUpperCase();
  return `${base}${quote}`.toUpperCase();
}

/** DB / WS key for a position: Delta option id, or compact perp key (ETHUSDT). */
function symbolKeyFromCcxtMarket(
  unified: string,
  market: { id?: unknown; option?: boolean },
): string {
  const productId =
    typeof market.id === "string" && market.id.trim() ? market.id.trim() : "";
  if (market.option === true && productId) return productId;
  if (isDeltaOptionProductId(unified)) return unified.trim();
  return unifiedSymbolToKey(unified);
}

type ResolvedPositionMarket = {
  market: ReturnType<InstanceType<typeof ccxt.delta>["market"]> | null;
  unified: string;
  symbolKey: string;
  isOption: boolean;
  contractSize: number;
};

/** Resolve CCXT market metadata; never drop a row solely because `product_symbol` is unknown. */
function resolvePositionMarket(
  exchange: InstanceType<typeof ccxt.delta>,
  productSymbol: string,
): ResolvedPositionMarket {
  const fallbackSize = deltaContractSizeFallback(productSymbol);

  const fromMarket = (
    market: ReturnType<typeof exchange.market>,
  ): ResolvedPositionMarket => {
    const unified = market.symbol;
    const isOption =
      market.option === true || isDeltaOptionProductId(productSymbol);
    const csRaw = Number(market.contractSize ?? fallbackSize);
    const contractSize =
      Number.isFinite(csRaw) && csRaw > 0 ? csRaw : fallbackSize;
    return {
      market,
      unified,
      symbolKey: symbolKeyFromCcxtMarket(unified, market),
      isOption,
      contractSize,
    };
  };

  if (isDeltaOptionProductId(productSymbol) || /^\d+$/.test(productSymbol.trim())) {
    const exact = resolveExactDeltaProductFromMarkets(exchange, productSymbol);
    if (!exact) {
      console.warn(
        `[exchangeService] fetchDeltaOpenPositions: exact option resolve failed product_ref=${productSymbol}`,
      );
      return {
        market: null,
        unified: productSymbol,
        symbolKey: isValidDeltaOptionProductSymbol(productSymbol)
          ? productSymbol
          : productSymbol,
        isOption: true,
        contractSize: fallbackSize,
      };
    }
    const market = findCcxtMarketByExactProductId(exchange, exact.productId);
    if (market) return fromMarket(market);
    return {
      market: null,
      unified: exact.productId,
      symbolKey: exact.productId,
      isOption: true,
      contractSize: fallbackSize,
    };
  }

  try {
    return fromMarket(exchange.market(productSymbol));
  } catch {
    /* fall through */
  }

  try {
    const unified = resolveCcxtSymbol(exchange, productSymbol);
    return fromMarket(exchange.market(unified));
  } catch {
    const isOption = isDeltaOptionProductId(productSymbol);
    console.warn(
      `[exchangeService] fetchDeltaOpenPositions: market fallback for product_symbol=${productSymbol}`,
    );
    return {
      market: null,
      unified: productSymbol,
      symbolKey: isOption ? productSymbol : unifiedSymbolToKey(productSymbol),
      isOption,
      contractSize: fallbackSize,
    };
  }
}

/** Compact trading labels (ETHUSDT, ETHUSD, …) → alias keys for {@link unifiedSymbolToKey} on CCXT markets. */
function compactSymbolAliasKeys(tradingSymbol: string): Set<string> {
  const s = tradingSymbol.trim().toUpperCase();
  const keys = new Set<string>();
  if (!s) return keys;

  if (s.includes("/")) {
    keys.add(unifiedSymbolToKey(normalizeDeltaPerpSymbolForCcxt(tradingSymbol)));
    keys.add(unifiedSymbolToKey(tradingSymbol.trim()));
    return keys;
  }

  keys.add(s);
  if (s.endsWith("USDT")) keys.add(s.slice(0, -4) + "USD");
  if (s.endsWith("USD") && !s.endsWith("USDT")) keys.add(s.slice(0, -3) + "USDT");
  return keys;
}

/**
 * After `loadMarkets()`, map a trading label to an **existing** swap unified symbol on Delta
 * India (e.g. ETHUSDT → ETH/USD:USD). Handles legacy `…/USDT:USDT` guesses via alias matching.
 */
function resolveDeltaIndiaSwapUnifiedSymbol(
  exchange: InstanceType<typeof ccxt.delta>,
  tradingSymbol: string,
): string | null {
  const markets = exchange.markets;
  if (markets == null || typeof markets !== "object") return null;

  const primary = normalizeDeltaPerpSymbolForCcxt(tradingSymbol);
  const direct = markets[primary];
  if (direct?.swap === true) return primary;

  const want = compactSymbolAliasKeys(tradingSymbol);

  for (const unified of Object.keys(markets)) {
    const m = markets[unified];
    if (m?.swap !== true) continue;
    const k = unifiedSymbolToKey(unified);
    if (want.has(k)) return unified;
  }

  return null;
}

function ccxtSideToTradeSide(raw: string | undefined): TradeSide {
  const u = (raw ?? "").toLowerCase();
  if (u === "long" || u === "buy") return "BUY";
  return "SELL";
}

/**
 * Decrypts stored Delta Exchange credentials and submits a market order.
 * For Delta India swaps, `size` is **contracts (lots)** — CCXT `createMarketOrder` amount, not base currency.
 */
export async function executeTrade(
  encryptedApiKey: string,
  encryptedApiSecret: string,
  symbol: string,
  side: TradeSide,
  size: number,
  opts?: { reduceOnly?: boolean; clientOrderId?: string },
): Promise<ExecuteTradeResult> {
  const clientOrderId = opts?.clientOrderId?.trim() || undefined;
  const inputSymbol = symbol.trim();
  try {
    const apiKey = decryptDeltaSecretOrPlain(encryptedApiKey);
    const secret = decryptDeltaSecretOrPlain(encryptedApiSecret);
    if (!apiKey || !secret) {
      return {
        success: false,
        error: "Invalid or undecryptable Delta API credentials",
      };
    }

    const isOptionOrder =
      isDeltaOptionProductId(inputSymbol) || /^\d+$/.test(inputSymbol);

    // Options: Delta REST first (CCXT loadMarkets omits most live contracts).
    if (isOptionOrder) {
      const restResult = await executeDeltaMarketOrderViaRest(
        apiKey,
        secret,
        inputSymbol,
        side,
        size,
        opts,
      );
      if (restResult.success) {
        console.log(
          `[copy-exec] REST market order ok symbol="${inputSymbol}" lots=${size} orderId=${restResult.orderId ?? "none"}`,
        );
        return restResult;
      }
      console.warn(
        `[copy-exec] REST option order failed for "${inputSymbol}" — trying CCXT fallback: ${restResult.error ?? "unknown"}`,
      );
    }

    const exchange = await getAuthClient(apiKey, secret);

    let canonicalProductId = inputSymbol;
    let ccxtSymbol: string;
    try {
      if (isOptionOrder) {
        let exact = resolveExactDeltaProductFromMarkets(exchange, inputSymbol);
        if (!exact) {
          exact = await hydrateExactDeltaOptionOnExchange(exchange, inputSymbol);
        }
        if (!exact) {
          const err = `Exact option product resolve failed for "${inputSymbol}" — order not placed`;
          console.error(`[copy-exec] ${err}`);
          return { success: false, error: err };
        }
        canonicalProductId = exact.productId;
        ccxtSymbol = exact.ccxtSymbol;
      } else {
        ccxtSymbol = resolveCcxtSymbol(exchange, inputSymbol);
      }
    } catch (resolveErr) {
      const err =
        resolveErr instanceof Error
          ? resolveErr.message
          : String(resolveErr);
      console.error(`[copy-exec] symbol resolve failed input="${inputSymbol}": ${err}`);
      return { success: false, error: err };
    }

    console.log(
      `[copy-exec] createMarketOrder side=${side} lots=${size} ` +
        `inputSymbol="${inputSymbol}" canonicalProductId="${canonicalProductId}" ` +
        `ccxtSymbol="${ccxtSymbol}" reduceOnly=${opts?.reduceOnly === true} ` +
        `clientOrderId=${clientOrderId ?? "none"}`,
    );

    const ccxtSide = side === "BUY" ? "buy" : "sell";
    const params: Record<string, unknown> = {};
    if (opts?.reduceOnly === true) {
      params.reduceOnly = true;
      params.reduce_only = true;
    }
    if (clientOrderId) {
      params.client_order_id = clientOrderId;
      params.clientOrderId = clientOrderId;
    }
    const orderParams = Object.keys(params).length > 0 ? params : undefined;

    let order: Awaited<ReturnType<typeof exchange.createOrder>>;
    try {
      order = await exchange.createOrder(
        ccxtSymbol,
        "market",
        ccxtSide,
        size,
        undefined,
        orderParams,
      );
    } catch (orderErr) {
      const message =
        orderErr instanceof Error ? orderErr.message : String(orderErr);
      console.warn(`[copy-exec] CCXT createOrder failed: ${message}`);
      return {
        success: false,
        error: message,
      };
    }

    const orderObj = order as {
      average?: unknown;
      price?: unknown;
      last?: unknown;
    };
    const explicitFee = extractFeeCostFromOrder(order);
    let feeCost = explicitFee ?? 0;
    if (!(Number.isFinite(feeCost) && feeCost > 0)) {
      let contractSize = 1;
      try {
        const m = exchange.market(ccxtSymbol);
        const cs = Number(m.contractSize ?? 1);
        contractSize =
          Number.isFinite(cs) && cs > 0
            ? cs
            : deltaContractSizeFallback(symbol);
      } catch {
        contractSize = deltaContractSizeFallback(symbol);
      }
      const executedPrice =
        numberOrNull(orderObj.average) ??
        numberOrNull(orderObj.price) ??
        numberOrNull(orderObj.last);
      if (executedPrice != null && Number.isFinite(executedPrice) && executedPrice > 0) {
        feeCost = Math.abs(size) * contractSize * executedPrice * 0.0005;
      } else {
        feeCost = 0;
      }
    }

    const fillPrice = extractFillPriceFromOrder(order);

    return {
      success: true,
      orderId: order.id ?? undefined,
      ...(clientOrderId ? { clientOrderId } : {}),
      ...(fillPrice != null ? { fillPrice } : {}),
      feeCost,
      raw: order,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: message,
    };
  }
}

export type DeltaClientOrderAck = {
  found: boolean;
  /** Delta order state: open, pending, closed (filled), cancelled, unknown */
  state: "open" | "pending" | "filled" | "cancelled" | "unknown";
  filledSize: number;
  unfilledSize: number;
  orderId?: string;
};

function parseDeltaClientOrderAckRow(
  row: Record<string, unknown>,
): DeltaClientOrderAck {
  const stateRaw = String(row.state ?? "").toLowerCase();
  const size = Math.abs(numberOrNull(row.size) ?? 0);
  const unfilled = Math.abs(numberOrNull(row.unfilled_size) ?? 0);
  const filledSize = Math.max(0, size - unfilled);

  let state: DeltaClientOrderAck["state"] = "unknown";
  if (stateRaw === "open") state = "open";
  else if (stateRaw === "pending") state = "pending";
  else if (stateRaw === "closed" || stateRaw === "filled") state = "filled";
  else if (stateRaw === "cancelled" || stateRaw === "canceled") {
    state = "cancelled";
  }

  const orderIdRaw = row.id;
  const orderId =
    orderIdRaw != null && String(orderIdRaw).trim().length > 0
      ? String(orderIdRaw)
      : undefined;

  return {
    found: true,
    state,
    filledSize,
    unfilledSize: unfilled,
    ...(orderId ? { orderId } : {}),
  };
}

/** Lookup order ack by client_order_id — used to avoid double-firing market copies. */
export async function fetchDeltaOrderAckByClientOrderId(
  apiKeyStored: string,
  apiSecretStored: string,
  clientOrderId: string,
): Promise<DeltaClientOrderAck> {
  const empty: DeltaClientOrderAck = {
    found: false,
    state: "unknown",
    filledSize: 0,
    unfilledSize: 0,
  };
  const id = clientOrderId.trim();
  if (!id) return empty;

  try {
    const apiKey = decryptDeltaSecretOrPlain(apiKeyStored);
    const secret = decryptDeltaSecretOrPlain(apiSecretStored);
    const exchange = await getAuthClient(apiKey, secret);

    type OrderByClientResponse = {
      success?: boolean;
      result?: Record<string, unknown>;
    };

    try {
      const response = (await (
        exchange as InstanceType<typeof ccxt.delta> & {
          privateGetOrdersClientOrderIdClientOid: (params: {
            client_oid: string;
          }) => Promise<OrderByClientResponse>;
        }
      ).privateGetOrdersClientOrderIdClientOid({ client_oid: id })) as OrderByClientResponse;

      const row = response?.result;
      if (row && typeof row === "object") {
        return parseDeltaClientOrderAckRow(row);
      }
    } catch (directErr) {
      console.warn(
        `[exchangeService] privateGetOrdersClientOrderIdClientOid failed clientOrderId=${id}:`,
        directErr instanceof Error ? directErr.message : directErr,
      );
    }

    try {
      const orders = await exchange.fetchOrders(undefined, undefined, 50, {
        client_order_id: id,
        clientOrderId: id,
      });
      for (const order of orders) {
        const o = order as unknown as Record<string, unknown>;
        const oid =
          String(o.clientOrderId ?? o.client_order_id ?? "").trim() === id
            ? id
            : "";
        if (!oid) continue;
        const info =
          o.info != null && typeof o.info === "object"
            ? (o.info as Record<string, unknown>)
            : o;
        return parseDeltaClientOrderAckRow(info);
      }
    } catch (fetchErr) {
      console.warn(
        `[exchangeService] fetchOrders by clientOrderId failed clientOrderId=${id}:`,
        fetchErr instanceof Error ? fetchErr.message : fetchErr,
      );
    }
  } catch (err) {
    console.warn(
      `[exchangeService] fetchDeltaOrderAckByClientOrderId failed:`,
      err instanceof Error ? err.message : err,
    );
  }

  return empty;
}

/**
 * Linear swap `contractSize` (base asset per contract) on Delta India, or `1` if unknown.
 * Uses public market metadata only (no API keys required).
 */
function deltaContractSizeFallback(symbol: string): number {
  const u = symbol.toUpperCase();
  if (u.includes("BTC")) return 0.001;
  if (u.includes("ETH")) return 0.01;
  return 1;
}

export async function fetchDeltaSwapContractSize(symbol: string): Promise<number> {
  try {
    const exchange = await getPublicClient();
    const ccxtSymbol = resolveCcxtSymbol(exchange, symbol);
    const market = exchange.market(ccxtSymbol);
    const cs = Number(market.contractSize ?? 1);
    return Number.isFinite(cs) && cs > 0 ? cs : 1;
  } catch {
    return 1;
  }
}

function extractMarkFromCcxtTicker(ticker: {
  mark?: unknown;
  info?: unknown;
}): number | null {
  const markDirect = numberOrNull(ticker.mark);
  if (markDirect != null && markDirect > 0) return markDirect;

  const info =
    ticker.info != null && typeof ticker.info === "object"
      ? (ticker.info as Record<string, unknown>)
      : undefined;
  const fromInfo = numberOrNull(
    info?.mark_price ?? info?.markPrice ?? info?.m,
  );
  if (fromInfo != null && fromInfo > 0) return fromInfo;
  return null;
}

/**
 * Public **mark** price for PnL (aligns with Delta Terminal). Never returns LTP.
 */
export async function fetchDeltaMarkPrice(
  symbol: string,
): Promise<{ markPrice: number | null }> {
  try {
    const exchange = await getPublicClient();
    const ccxtSymbol = resolveCcxtSymbol(exchange, symbol);
    try {
      const ticker = await exchange.fetchTicker(ccxtSymbol);
      const mark = extractMarkFromCcxtTicker(ticker);
      return { markPrice: mark };
    } catch (tickerErr) {
      const msg =
        tickerErr instanceof Error ? tickerErr.message : String(tickerErr);
      console.warn(
        `[exchangeService] fetchTicker (mark) failed symbol=${symbol} ccxt=${ccxtSymbol}:`,
        msg,
      );
      return { markPrice: null };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[exchangeService] fetchDeltaMarkPrice failed symbol=${symbol}:`,
      msg,
    );
    return { markPrice: null };
  }
}

/**
 * Public last traded price — for slippage checks only (not for unrealized PnL).
 * Uses Delta India via {@link initializeDeltaClient}. Returns `{ last: null }` on any failure.
 */
export async function fetchDeltaTicker(
  symbol: string,
): Promise<{ last: number | null }> {
  try {
    const exchange = await getPublicClient();
    const ccxtSymbol = resolveCcxtSymbol(exchange, symbol);
    try {
      const ticker = await exchange.fetchTicker(ccxtSymbol);
      const raw =
        ticker.last ?? ticker.close ?? ticker.bid ?? ticker.ask ?? undefined;
      const n =
        typeof raw === "number"
          ? raw
          : raw === undefined || raw === null
            ? NaN
            : Number(raw);
      if (!Number.isFinite(n)) {
        return { last: null };
      }
      return { last: n };
    } catch (tickerErr) {
      const msg =
        tickerErr instanceof Error ? tickerErr.message : String(tickerErr);
      console.warn(
        `[exchangeService] fetchTicker failed symbol=${symbol} ccxt=${ccxtSymbol}:`,
        msg,
      );
      return { last: null };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[exchangeService] fetchDeltaTicker failed symbol=${symbol}:`,
      msg,
    );
    return { last: null };
  }
}

/**
 * Authenticated margined positions snapshot — open legs and explicit flat leg keys.
 * Wrapped by {@link fetchDeltaMarginedPositionSnapshot} with in-flight dedupe + TTL cache.
 */
async function fetchDeltaMarginedPositionSnapshotInner(
  apiKeyStored: string,
  apiSecretStored: string,
  options?: FetchMarginedSnapshotOptions,
): Promise<DeltaMarginedPositionSnapshot> {
  const lite = options?.lite !== false;
  const apiKey = decryptDeltaSecretOrPlain(apiKeyStored);
  const secret = decryptDeltaSecretOrPlain(apiSecretStored);
  if (!apiKey || !secret) {
    throw new Error("Invalid or undecryptable Delta API credentials");
  }

  type MarginedResponse = { result?: unknown[] };
  let rawList: unknown[] = [];
  let exchange: InstanceType<typeof ccxt.delta> | null = null;

  try {
    rawList = await fetchMarginedPositionsViaRest(apiKey, secret);
  } catch (restErr) {
    console.warn(
      `[exchangeService] REST /v2/positions/margined failed — CCXT fallback:`,
      restErr instanceof Error ? restErr.message : restErr,
    );
    exchange = await getAuthClient(apiKey, secret);
    let response: MarginedResponse;
    try {
      response = (await (
        exchange as InstanceType<typeof ccxt.delta> & {
          privateGetPositionsMargined: (params?: object) => Promise<MarginedResponse>;
        }
      ).privateGetPositionsMargined()) as MarginedResponse;
    } catch (err) {
      console.warn(
        `[exchangeService] privateGetPositionsMargined failed:`,
        err instanceof Error ? err.message : err,
      );
      throw err;
    }
    rawList = Array.isArray(response?.result) ? response.result : [];
  }

  if (!exchange) {
    exchange = await getAuthClient(apiKey, secret);
  }

  const optionTickerCache = lite
    ? await prefetchOptionTickerQuotes(collectOpenOptionProductSymbols(rawList))
    : new Map<string, OptionTickerQuote>();

  const open: DeltaLivePosition[] = [];
  const explicitFlatLegKeys: string[] = [];

  for (const row of rawList) {
    try {
      if (!row || typeof row !== "object") continue;
      const position = row as Record<string, unknown>;
      const info =
        position.info != null && typeof position.info === "object"
          ? (position.info as Record<string, unknown>)
          : null;

      const rawSize =
        numberOrNull(position.size) ??
        numberOrNull(info?.size) ??
        numberOrNull(position.contracts);

      const productSymbolRaw = String(position.product_symbol ?? "").trim();
      let productSymbol = productSymbolRaw;
      if (!productSymbol) {
        const pid = String(position.product_id ?? "").trim();
        if (pid) {
          const exact = resolveExactDeltaProductFromMarkets(exchange, pid);
          productSymbol = exact?.productId ?? pid;
        }
      } else if (/^\d+$/.test(productSymbol)) {
        const exact = resolveExactDeltaProductFromMarkets(exchange, productSymbol);
        if (exact) productSymbol = exact.productId;
      }

      if (rawSize === null || Math.abs(rawSize) < 1e-12) {
        if (productSymbol) {
          const side =
            normalizePositionSide(
              position.side ??
                position.position_side ??
                info?.side ??
                info?.position_side,
            ) ?? "BUY";
          if (lite) {
            explicitFlatLegKeys.push(
              deltaLiveLegKey(fastFlatLegSymbolKey(productSymbol), side),
            );
          } else {
            try {
              const { symbolKey } = resolvePositionMarket(exchange, productSymbol);
              explicitFlatLegKeys.push(deltaLiveLegKey(symbolKey, side));
            } catch (flatErr) {
              console.warn(
                `[exchangeService] explicit flat leg parse failed product_symbol=${productSymbol}:`,
                flatErr instanceof Error ? flatErr.message : flatErr,
              );
            }
          }
        }
        continue;
      }

      if (!productSymbol) continue;

      const {
        market,
        unified,
        symbolKey,
        isOption,
        contractSize,
      } = resolvePositionMarket(exchange, productSymbol);

      const contractLots = rawSize;
      const side: TradeSide = tradeSideFromSignedSize(contractLots);

      const signedBtc = isOption
        ? contractLots * contractSize
        : market != null
          ? deltaSignedBtcSize(
              contractLots,
              deltaContractValueFromMarket(market, position),
            )
          : Number.isInteger(Math.abs(contractLots)) && Math.abs(contractLots) >= 1
            ? contractLots * contractSize
            : contractLots;

      const realBaseSize =
        Math.abs(signedBtc) > 1e-12 ? Math.abs(signedBtc) : Math.abs(contractLots);
      let contractLotCount = isOption
        ? Math.abs(contractLots)
        : deltaContractLotCount(contractLots, contractSize, signedBtc);
      if (contractLotCount < 1e-12) {
        contractLotCount = Math.abs(contractLots);
      }
      if (contractLotCount < 1e-12) continue;

      const entryPrice =
        numberOrNull(position.entry_price) ??
        numberOrNull(position.average_price);

      let markPrice: number | null = null;
      if (position.mark_price !== undefined && position.mark_price !== null) {
        const parsed = parseFloat(String(position.mark_price));
        markPrice = Number.isFinite(parsed) ? parsed : null;
      } else if (position.markPrice !== undefined && position.markPrice !== null) {
        const parsed = Number(position.markPrice);
        markPrice = Number.isFinite(parsed) ? parsed : null;
      }

      if (markPrice === null && !isOption && !lite) {
        try {
          const ticker = await exchange.fetchTicker(unified);
          markPrice = extractMarkFromCcxtTicker(ticker);
        } catch {
          /* perp mark stays null */
        }
      }

      let unrealizedPnl: number | null = null;
      const apiUpnlRaw = position.unrealized_pnl;

      if (lite) {
        // Options: never trust raw API unrealized_pnl on Delta India (not USD terminal value).
        if (isOption && entryPrice !== null) {
          const upnlPrice = resolveOptionUpnlPriceLite(
            position,
            side,
            markPrice,
            productSymbol,
            optionTickerCache,
          );
          if (upnlPrice !== null) {
            const sign = side === "SELL" ? -1 : 1;
            unrealizedPnl = realBaseSize * (upnlPrice - entryPrice) * sign;
            const funding = parseFloat(
              String(position.unrealized_funding_pnl ?? "0"),
            );
            if (!Number.isNaN(funding) && unrealizedPnl !== null) {
              unrealizedPnl += funding;
            }
          }
        } else {
          unrealizedPnl = computePositionUnrealizedPnl({
            isOption,
            side,
            entryPrice,
            markPrice,
            realBaseSize,
            position,
            lite: true,
          });
        }
        if (unrealizedPnl === null && !isOption) {
          unrealizedPnl = parseApiUnrealizedPnl(position);
          if (unrealizedPnl === null && entryPrice !== null && markPrice !== null) {
            const sign = side === "SELL" ? -1 : 1;
            unrealizedPnl = realBaseSize * (markPrice - entryPrice) * sign;
          }
        }
      } else {
      let upnlPrice: number | null = markPrice;
      let upnlPriceSource = "mark";

      if (isOption) {
        const resolved = await resolveOptionUpnlPrice(
          exchange,
          unified,
          position,
          side,
          markPrice,
        );
        upnlPrice = resolved.price;
        upnlPriceSource = resolved.source;
      }

      if (entryPrice !== null && upnlPrice !== null) {
        const sign = side === "SELL" ? -1 : 1;
        unrealizedPnl = realBaseSize * (upnlPrice - entryPrice) * sign;

        const funding = parseFloat(String(position.unrealized_funding_pnl ?? "0"));
        if (!Number.isNaN(funding)) unrealizedPnl += funding;
      } else if (!isOption && apiUpnlRaw !== undefined && apiUpnlRaw !== null) {
        unrealizedPnl = parseFloat(String(apiUpnlRaw));
        const funding = parseFloat(String(position.unrealized_funding_pnl ?? "0"));
        if (!Number.isNaN(funding) && unrealizedPnl !== null) unrealizedPnl += funding;
      }

      if (Number.isNaN(unrealizedPnl as number)) unrealizedPnl = null;

      const { bid, offer } = extractDeltaBidOffer(position);

      console.log(`\n[PNL_TRACKER] -------------------------`);
      console.log(`[PNL_TRACKER] Symbol: ${unified} | Side: ${side} | option=${isOption}`);
      console.log(
        `[PNL_TRACKER] Contract lots: ${contractLotCount} (raw=${contractLots}) × contractSize=${contractSize} → RealBaseSize(BTC)=${realBaseSize}`,
      );
      console.log(
        `[PNL_TRACKER] Entry: ${entryPrice} | Mark(display): ${markPrice} | Bid: ${bid ?? "n/a"} | Offer: ${offer ?? "n/a"}`,
      );
      console.log(
        `[PNL_TRACKER] UPNL price (${upnlPriceSource}): ${upnlPrice} → PnL: ${unrealizedPnl}`,
      );
      console.log(
        `[PNL_TRACKER] API unrealized_pnl (ignored for options): ${apiUpnlRaw ?? "n/a"}`,
      );
      console.log(`[PNL_TRACKER] -------------------------\n`);
      }

      if (Number.isNaN(unrealizedPnl as number)) unrealizedPnl = null;

      let stopLoss: number | null = null;
      let takeProfit: number | null = null;
      const sl =
        numberOrNull(position.stop_loss_order_price) ??
        numberOrNull(position.stop_loss_price) ??
        numberOrNull(position.stopLossPrice);
      const tp =
        numberOrNull(position.take_profit_order_price) ??
        numberOrNull(position.take_profit_price) ??
        numberOrNull(position.takeProfitPrice);
      if (sl !== null) stopLoss = sl;
      if (tp !== null) takeProfit = tp;

      let entryTime: string | null = null;
      const createdAt = position.created_at;
      if (typeof createdAt === "string" && createdAt) {
        entryTime = createdAt;
      } else if (position.timestamp != null) {
        const ts = Number(position.timestamp);
        if (Number.isFinite(ts)) {
          entryTime = new Date(ts).toISOString();
        }
      }

      open.push({
        symbol: unified,
        symbolKey,
        side,
        contracts: contractLotCount,
        realBaseSize,
        entryPrice,
        markPrice,
        unrealizedPnl:
          unrealizedPnl !== null && Number.isFinite(unrealizedPnl)
            ? unrealizedPnl
            : null,
        stopLoss,
        takeProfit,
        entryTime,
      });
    } catch (rowErr) {
      console.warn(
        `[exchangeService] fetchDeltaMarginedPositionSnapshot row skipped:`,
        rowErr instanceof Error ? rowErr.message : rowErr,
      );
    }
  }

  return { open, explicitFlatLegKeys };
}

export async function fetchDeltaMarginedPositionSnapshot(
  apiKeyStored: string,
  apiSecretStored: string,
  options?: FetchMarginedSnapshotOptions,
): Promise<DeltaMarginedPositionSnapshot> {
  const cacheKey = marginedSnapshotCacheKey(apiKeyStored, apiSecretStored);
  const bypassTtl = options?.skipCache === true;

  if (!bypassTtl) {
    const hit = marginedSnapshotCache.get(cacheKey);
    if (hit && Date.now() - hit.at < MARGINED_SNAPSHOT_TTL_MS) {
      return hit.snapshot;
    }
  }

  const existing = marginedSnapshotInflight.get(cacheKey);
  if (existing) return existing;

  const work = fetchDeltaMarginedPositionSnapshotInner(
    apiKeyStored,
    apiSecretStored,
    options,
  )
    .then((snapshot) => {
      marginedSnapshotCache.set(cacheKey, { at: Date.now(), snapshot });
      return snapshot;
    })
    .finally(() => {
      marginedSnapshotInflight.delete(cacheKey);
    });

  marginedSnapshotInflight.set(cacheKey, work);
  return work;
}

/**
 * Authenticated open positions via Delta India **`GET /v2/positions/margined`** (raw API).
 * Avoids CCXT `fetchPositions` / `parsePosition`, which drops `mark_price` and `unrealized_pnl`.
 * Defaults to `lite: true` (no per-option tickers) — safe for trade engine, auto-exit, admin UI.
 */
export async function fetchDeltaOpenPositions(
  apiKeyStored: string,
  apiSecretStored: string,
  options?: FetchMarginedSnapshotOptions,
): Promise<DeltaLivePosition[]> {
  const snapshot = await fetchDeltaMarginedPositionSnapshot(
    apiKeyStored,
    apiSecretStored,
    { lite: true, ...options },
  );
  return snapshot.open;
}

/** Verify Delta India credentials and return open leg count for admin "Test connection". */
export async function testDeltaIndiaConnection(
  apiKeyStored: string,
  apiSecretStored: string,
): Promise<{
  success: boolean;
  openPositionCount?: number;
  availableBalanceUsd?: number | null;
  apiKeyPrefix?: string;
  error?: string;
}> {
  const apiKey = decryptDeltaSecretOrPlain(apiKeyStored);
  const secret = decryptDeltaSecretOrPlain(apiSecretStored);
  const apiKeyPrefix =
    apiKey.length > 6 ? `${apiKey.slice(0, 6)}***` : apiKey ? "***" : "";

  if (!apiKey.trim() || !secret.trim()) {
    return {
      success: false,
      apiKeyPrefix,
      error:
        "API key and secret are missing or unreadable — re-paste from Delta Exchange India.",
    };
  }

  try {
    const positions = await fetchDeltaOpenPositions(apiKeyStored, apiSecretStored);
    let availableBalanceUsd: number | null = null;
    try {
      availableBalanceUsd = await fetchDeltaTotalBalanceUsd(
        apiKeyStored,
        apiSecretStored,
      );
    } catch {
      /* balance is optional — positions fetch proves auth */
    }
    return {
      success: true,
      openPositionCount: positions.length,
      availableBalanceUsd,
      apiKeyPrefix,
    };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : String(err ?? "Connection failed");
    return { success: false, error: message, apiKeyPrefix };
  }
}

export type DeltaBalanceBreakdown = {
  totalBalance: number;
  availableBalance: number;
  usedBalance: number;
};

function asBalanceRecord(v: unknown): Record<string, unknown> | null {
  if (v != null && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return null;
}

/** Delta terminal "Total Account Value" — includes open-position PnL. */
function metaNetEquityFrom(...sources: unknown[]): number | null {
  for (const src of sources) {
    const rec = asBalanceRecord(src);
    if (!rec) continue;

    // Wallet API passes `response.meta` directly — net_equity lives on the object itself.
    const direct =
      numberOrNull(rec.net_equity) ??
      numberOrNull(rec.netEquity) ??
      numberOrNull(rec.equity);
    if (direct !== null && Number.isFinite(direct)) return direct;

    const meta = asBalanceRecord(rec.meta);
    if (!meta) continue;
    const nested =
      numberOrNull(meta.net_equity) ??
      numberOrNull(meta.netEquity) ??
      numberOrNull(meta.equity);
    if (nested !== null && Number.isFinite(nested)) return nested;
  }
  return null;
}

/**
 * Sum only non-negative margin buckets (actual locked collateral).
 * Ignores negative unrealized PnL fields that sometimes appear on margined rows.
 */
function positiveLockedMarginUsd(row: Record<string, unknown>): number {
  const keys = [
    "position_margin",
    "order_margin",
    "blocked_margin",
    "blocked_balance",
    "cross_position_margin",
    "cross_order_margin",
    "cross_locked_collateral",
    "cross_initial_margin",
    "initial_margin",
    "portfolio_margin",
    "commission",
    "cross_commission",
    "used_balance",
  ];
  let sum = 0;
  for (const key of keys) {
    const n = numberOrNull(row[key]);
    if (n !== null && n > 0) sum += n;
  }
  return sum;
}

/**
 * Total = meta.net_equity (terminal account value).
 * Locked = total − available (never negative).
 */
function finalizeDeltaBalanceBreakdown(args: {
  availableBalance: number;
  netEquity?: number | null;
  cashBalance?: number | null;
  positiveLocked?: number;
}): DeltaBalanceBreakdown {
  const available = Math.max(
    0,
    Number.isFinite(args.availableBalance) ? args.availableBalance : 0,
  );

  let totalBalance = args.netEquity ?? null;
  if (totalBalance === null || !Number.isFinite(totalBalance)) {
    const cash = Math.max(0, args.cashBalance ?? 0);
    const locked = Math.max(0, args.positiveLocked ?? 0);
    if (cash > 0 || locked > 0) {
      totalBalance = cash + locked;
    } else {
      totalBalance = available;
    }
  }

  totalBalance = Math.max(available, totalBalance);
  const usedBalance = Math.max(0, totalBalance - available);

  return {
    totalBalance,
    availableBalance: available,
    usedBalance,
  };
}

function balanceFieldUsd(
  bal: Awaited<ReturnType<InstanceType<typeof ccxt.delta>["fetchBalance"]>>,
  bucket: "free" | "used" | "total",
): number | null {
  const map = bal[bucket] as Record<string, unknown> | undefined;
  if (!map) return null;
  for (const ccy of ["USD", "USDT"]) {
    const n = numberOrNull(map[ccy]);
    if (n !== null && n >= 0) return n;
  }
  return null;
}

function parseDeltaBalanceBreakdown(
  bal: Awaited<ReturnType<InstanceType<typeof ccxt.delta>["fetchBalance"]>>,
): DeltaBalanceBreakdown {
  const info = (bal.info ?? {}) as Record<string, unknown>;

  const freeCcxt = balanceFieldUsd(bal, "free");
  const availableInfo =
    numberOrNull(info.available_balance) ?? numberOrNull(info.available_margin);

  const availableBalance = Math.max(
    0,
    freeCcxt ?? availableInfo ?? balanceFieldUsd(bal, "total") ?? 0,
  );

  const netEquity = metaNetEquityFrom(info, bal);
  const cashBalance =
    numberOrNull(info.balance) ??
    numberOrNull(info.wallet_balance) ??
    balanceFieldUsd(bal, "total");

  return finalizeDeltaBalanceBreakdown({
    availableBalance,
    netEquity,
    cashBalance,
    positiveLocked: positiveLockedMarginUsd(info),
  });
}

/** Parse a Delta India `/v2/wallet/balances` row (USD wallet). */
function parseDeltaWalletBalanceRow(
  row: Record<string, unknown>,
  ...equitySources: unknown[]
): DeltaBalanceBreakdown | null {
  const asset =
    row.asset != null && typeof row.asset === "object"
      ? (row.asset as Record<string, unknown>)
      : null;
  const symbol = String(asset?.symbol ?? row.asset_symbol ?? "")
    .trim()
    .toUpperCase();
  if (symbol !== "USD" && symbol !== "USDT") return null;

  const availableBalance =
    numberOrNull(row.available_balance) ??
    numberOrNull(row.available) ??
    numberOrNull(row.available_margin) ??
    0;

  const netEquity = metaNetEquityFrom(...equitySources, row);
  const cashBalance =
    numberOrNull(row.balance) ??
    numberOrNull(row.wallet_balance) ??
    numberOrNull(row.total_balance);

  return finalizeDeltaBalanceBreakdown({
    availableBalance,
    netEquity,
    cashBalance,
    positiveLocked: positiveLockedMarginUsd(row),
  });
}

async function fetchDeltaWalletBalanceBreakdownUsd(
  exchange: InstanceType<typeof ccxt.delta>,
): Promise<DeltaBalanceBreakdown | null> {
  try {
    type WalletResponse = { result?: unknown[]; meta?: unknown };
    const response = (await (
      exchange as InstanceType<typeof ccxt.delta> & {
        privateGetWalletBalances: () => Promise<WalletResponse>;
      }
    ).privateGetWalletBalances()) as WalletResponse;

    const rows = Array.isArray(response?.result) ? response.result : [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const parsed = parseDeltaWalletBalanceRow(
        row as Record<string, unknown>,
        response,
        response.meta,
      );
      if (parsed) return parsed;
    }
  } catch (err) {
    console.warn(
      `[exchangeService] privateGetWalletBalances failed:`,
      err instanceof Error ? err.message : err,
    );
  }
  return null;
}

/**
 * Total, free (available), and used (locked) USD balance from CCXT `fetchBalance()`.
 */
export async function fetchDeltaBalanceBreakdownUsd(
  apiKeyStored: string,
  apiSecretStored: string,
): Promise<DeltaBalanceBreakdown> {
  const apiKey = decryptDeltaSecretOrPlain(apiKeyStored);
  const secret = decryptDeltaSecretOrPlain(apiSecretStored);
  if (!apiKey.trim() || !secret.trim()) {
    return { totalBalance: 0, availableBalance: 0, usedBalance: 0 };
  }
  const exchange = await getAuthClient(apiKey, secret);

  const walletBreakdown = await fetchDeltaWalletBalanceBreakdownUsd(exchange);
  if (walletBreakdown) return walletBreakdown;

  const bal = await exchange.fetchBalance();
  return parseDeltaBalanceBreakdown(bal);
}

/**
 * User-facing available (free) capital from the subscriber's own Delta credentials (CCXT).
 */
export async function fetchDeltaAvailableBalanceUsd(
  apiKeyStored: string,
  apiSecretStored: string,
): Promise<number> {
  const breakdown = await fetchDeltaBalanceBreakdownUsd(apiKeyStored, apiSecretStored);
  return breakdown.availableBalance;
}

/** @deprecated Prefer {@link fetchDeltaAvailableBalanceUsd} for user dashboards. */
export async function fetchDeltaTotalBalanceUsd(
  apiKeyStored: string,
  apiSecretStored: string,
): Promise<number> {
  return fetchDeltaAvailableBalanceUsd(apiKeyStored, apiSecretStored);
}

export type BtcOptionType = "call" | "put";

export type AtmBtcOptionMatch = {
  productId: string;
  strike: number;
  expiryMs: number;
};

type DeltaProductRow = {
  symbol?: string;
  strike_price?: unknown;
  settlement_time?: string;
  state?: string;
  contract_type?: string;
};

/** Parse `C-BTC-90000-310125` / `P-BTC-...` symbology (ddmmyy expiry). */
export function parseBtcOptionProductId(
  productId: string,
): { type: BtcOptionType; strike: number; expiryMs: number } | null {
  const m = productId.trim().match(/^(C|P)-BTC-(\d+)-(\d{6})$/i);
  if (!m) return null;
  const type: BtcOptionType = m[1]!.toUpperCase() === "C" ? "call" : "put";
  const strike = Number(m[2]);
  if (!Number.isFinite(strike) || strike <= 0) return null;
  const ddmmyy = m[3]!;
  const dd = Number(ddmmyy.slice(0, 2));
  const mm = Number(ddmmyy.slice(2, 4));
  const yy = Number(ddmmyy.slice(4, 6));
  if (!Number.isFinite(dd) || !Number.isFinite(mm) || !Number.isFinite(yy)) {
    return null;
  }
  const year = yy >= 70 ? 1900 + yy : 2000 + yy;
  const expiryMs = Date.UTC(year, mm - 1, dd, 12, 0, 0);
  if (!Number.isFinite(expiryMs)) return null;
  return { type, strike, expiryMs };
}

function expiryMsFromSettlement(iso: string | undefined): number | null {
  if (!iso?.trim()) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Lists live BTC call or put options from Delta India public products API.
 */
export async function listBtcOptionProducts(
  optionType: BtcOptionType,
): Promise<AtmBtcOptionMatch[]> {
  const contractTypes =
    optionType === "call" ? "call_options" : "put_options";
  try {
    const { data } = await axios.get<{ result?: DeltaProductRow[] }>(
      `${DELTA_INDIA_API_BASE}/v2/products`,
      {
        params: {
          underlying_asset_symbols: "BTC",
          contract_types: contractTypes,
        },
        timeout: 20_000,
      },
    );
    const rows = Array.isArray(data?.result) ? data.result : [];
    const out: AtmBtcOptionMatch[] = [];

    for (const row of rows) {
      const symbol = String(row.symbol ?? "").trim();
      if (!symbol) continue;
      if (row.state && row.state !== "live") continue;

      const parsed = parseBtcOptionProductId(symbol);
      const strikeFromApi = numberOrNull(row.strike_price);
      const strike =
        strikeFromApi != null && strikeFromApi > 0
          ? strikeFromApi
          : parsed?.strike;
      const expiryMs =
        expiryMsFromSettlement(row.settlement_time) ?? parsed?.expiryMs ?? null;

      if (strike == null || expiryMs == null) continue;
      if (parsed && parsed.type !== optionType) continue;

      out.push({ productId: symbol, strike, expiryMs });
    }

    return out;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[exchangeService] listBtcOptionProducts failed: ${msg}`);
    return [];
  }
}

/**
 * Nearest live expiry ATM BTC option (product id for {@link executeTrade}).
 */
export async function findAtmBtcOptionProductId(
  optionType: BtcOptionType,
  spotPrice: number,
): Promise<AtmBtcOptionMatch | null> {
  if (!Number.isFinite(spotPrice) || spotPrice <= 0) return null;

  let candidates = await listBtcOptionProducts(optionType);

  if (candidates.length === 0) {
    try {
      const exchange = await getPublicClient();
      for (const market of Object.values(exchange.markets)) {
        if (market?.option !== true && !isDeltaOptionProductId(String(market?.id ?? ""))) {
          continue;
        }
        const id = String(market.id ?? market.symbol ?? "").trim();
        const parsed = parseBtcOptionProductId(id);
        if (!parsed || parsed.type !== optionType) continue;
        const strike = numberOrNull(market.strike) ?? parsed.strike;
        const expiryMs =
          typeof market.expiry === "number" && market.expiry > 0
            ? market.expiry
            : parsed.expiryMs;
        candidates.push({ productId: id, strike, expiryMs });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[exchangeService] markets fallback for options failed: ${msg}`);
    }
  }

  const now = Date.now();
  const minLeadMs = 60_000;
  const live = candidates.filter((c) => c.expiryMs > now + minLeadMs);
  if (live.length === 0) return null;

  const nearestExpiry = Math.min(...live.map((c) => c.expiryMs));
  const onNearest = live.filter((c) => c.expiryMs === nearestExpiry);

  let best = onNearest[0]!;
  let bestDist = Math.abs(best.strike - spotPrice);
  for (const c of onNearest) {
    const d = Math.abs(c.strike - spotPrice);
    if (d < bestDist) {
      best = c;
      bestDist = d;
    }
  }

  return best;
}

/** ATM strike on a fixed expiry (for batch adjustments — same expiry as initial entry). */
export async function findAtmBtcOptionForExpiry(
  optionType: BtcOptionType,
  spotPrice: number,
  expiryMs: number,
): Promise<AtmBtcOptionMatch | null> {
  if (!Number.isFinite(spotPrice) || spotPrice <= 0 || !Number.isFinite(expiryMs)) {
    return null;
  }

  const candidates = await listBtcOptionProducts(optionType);
  const expiryToleranceMs = 86_400_000;
  const onExpiry = candidates.filter(
    (c) => Math.abs(c.expiryMs - expiryMs) <= expiryToleranceMs,
  );
  if (onExpiry.length === 0) return null;

  let best = onExpiry[0]!;
  let bestDist = Math.abs(best.strike - spotPrice);
  for (const c of onExpiry) {
    const d = Math.abs(c.strike - spotPrice);
    if (d < bestDist) {
      best = c;
      bestDist = d;
    }
  }
  return best;
}
