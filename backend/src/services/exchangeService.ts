import axios from "axios";
import ccxt from "ccxt";
import {
  decryptDeltaSecretOrPlain,
} from "../utils/encryption.js";

/** Delta Exchange India REST base (CCXT `delta` defaults to global `api.delta.exchange`). */
const DELTA_INDIA_API_BASE = "https://api.india.delta.exchange";

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

/**
 * After `loadMarkets()`, map a Delta product id or trading label to CCXT unified symbol.
 * Resolves options and perps via `market.id`; falls back to India swap normalization.
 */
export function resolveCcxtSymbol(
  exchange: InstanceType<typeof ccxt.delta>,
  tradingSymbol: string,
): string {
  const raw = tradingSymbol.trim();
  if (!raw) return raw;

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
  try {
    const apiKey = decryptDeltaSecretOrPlain(encryptedApiKey);
    const secret = decryptDeltaSecretOrPlain(encryptedApiSecret);

    const exchange = await getAuthClient(apiKey, secret);

    const ccxtSymbol = resolveCcxtSymbol(exchange, symbol);
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
      console.log(message);
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
 * Authenticated open positions via Delta India **`GET /v2/positions/margined`** (raw API).
 * Avoids CCXT `fetchPositions` / `parsePosition`, which drops `mark_price` and `unrealized_pnl`.
 */
export async function fetchDeltaOpenPositions(
  apiKeyStored: string,
  apiSecretStored: string,
): Promise<DeltaLivePosition[]> {
  const apiKey = decryptDeltaSecretOrPlain(apiKeyStored);
  const secret = decryptDeltaSecretOrPlain(apiSecretStored);

  const exchange = await getAuthClient(apiKey, secret);

  type MarginedResponse = { result?: unknown[] };
  const response = (await (
    exchange as InstanceType<typeof ccxt.delta> & {
      privateGetPositionsMargined: (params?: object) => Promise<MarginedResponse>;
    }
  ).privateGetPositionsMargined()) as MarginedResponse;

  const rawList = Array.isArray(response?.result) ? response.result : [];

  const out: DeltaLivePosition[] = [];
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
      if (rawSize === null || Math.abs(rawSize) < 1e-12) continue;

      const productSymbol = String(
        position.product_symbol ?? position.product_id ?? "",
      ).trim();
      if (!productSymbol) continue;

      const {
        market,
        unified,
        symbolKey,
        isOption,
        contractSize,
      } = resolvePositionMarket(exchange, productSymbol);

      const contractLots = rawSize;

      // Side MUST follow raw signed size — do not infer from converted base units.
      const side: TradeSide = tradeSideFromSignedSize(contractLots);

      // Options: API `size` is contract count (±100) → scale to BTC (±0.1) via contractSize.
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

      const realBaseSize = Math.abs(signedBtc) > 1e-12 ? Math.abs(signedBtc) : Math.abs(contractLots);
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

    // Prefer Delta margined API `mark_price` — CCXT ticker marks are often stale for options.
    let markPrice: number | null = null;
    if (position.mark_price !== undefined && position.mark_price !== null) {
      const parsed = parseFloat(String(position.mark_price));
      markPrice = Number.isFinite(parsed) ? parsed : null;
    } else if (position.markPrice !== undefined && position.markPrice !== null) {
      const parsed = Number(position.markPrice);
      markPrice = Number.isFinite(parsed) ? parsed : null;
    }

    if (markPrice === null && !isOption) {
      try {
        const ticker = await exchange.fetchTicker(unified);
        markPrice = extractMarkFromCcxtTicker(ticker);
      } catch {
        /* perp mark stays null */
      }
    }

    let unrealizedPnl: number | null = null;
    const apiUpnlRaw = position.unrealized_pnl;

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

    out.push({
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
        `[exchangeService] fetchDeltaOpenPositions row skipped:`,
        rowErr instanceof Error ? rowErr.message : rowErr,
      );
    }
  }

  return out;
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

  const totalCcxt = balanceFieldUsd(bal, "total");
  const freeCcxt = balanceFieldUsd(bal, "free");
  const usedCcxt = balanceFieldUsd(bal, "used");

  const totalInfo = numberOrNull(info.total_balance);
  const availableInfo =
    numberOrNull(info.available_balance) ?? numberOrNull(info.available_margin);
  const usedInfo =
    numberOrNull(info.used_balance) ??
    numberOrNull(info.position_margin) ??
    numberOrNull(info.blocked_margin);

  let totalBalance = totalCcxt ?? totalInfo ?? 0;
  let availableBalance = freeCcxt ?? availableInfo ?? 0;
  let usedBalance = usedCcxt ?? usedInfo ?? 0;

  if (totalBalance <= 0 && availableBalance > 0) {
    totalBalance = availableBalance + usedBalance;
  }
  if (usedBalance <= 0 && totalBalance > 0 && availableBalance >= 0) {
    usedBalance = Math.max(0, totalBalance - availableBalance);
  }
  if (totalBalance <= 0 && availableBalance <= 0 && usedBalance > 0) {
    totalBalance = usedBalance;
  }

  return {
    totalBalance: Number.isFinite(totalBalance) ? totalBalance : 0,
    availableBalance: Number.isFinite(availableBalance) ? availableBalance : 0,
    usedBalance: Number.isFinite(usedBalance) ? usedBalance : 0,
  };
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
