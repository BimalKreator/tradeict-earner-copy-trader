import axios from "axios";
import ccxt from "ccxt";
import { createHmac } from "node:crypto";
import http from "node:http";
import https from "node:https";
import {
  decryptDeltaSecretOrPlain,
} from "../utils/encryption.js";
import {
  DeltaRestPausedError,
  handleDeltaCdn429,
  isDeltaRestPausedError,
  scheduleDeltaRestRequest,
} from "../utils/deltaRateLimiter.js";
import {
  cacheLiveQuotes,
  hasFreshTerminalQuotes,
  isLiveQuotesFresh,
  resolveLiveQuotes,
  resolveOptionQuotesWsOnly,
} from "./liveMarkPriceCache.js";
import {
  cacheDeltaTerminalUpl,
  getDeltaTerminalUpl,
  parseDeltaPositionTerminalUpl,
} from "./deltaTerminalUplCache.js";
import {
  BTC_OPTION_CONTRACT_VALUE,
  computeTerminalPnlUsd,
  roundPnlUsdHalfUp,
} from "./pnlMath.js";

export type TradeSide = "BUY" | "SELL";

function numberOrNull(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Delta Exchange India REST base (CCXT `delta` defaults to global `api.delta.exchange`). */
const DELTA_INDIA_API_BASE = "https://api.india.delta.exchange";

/** Reuse TLS sessions across concurrent follower order placements. */
const deltaHttpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: 64,
});
const deltaHttpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: 64,
});

const deltaAxios = axios.create({
  timeout: 25_000,
  httpAgent: deltaHttpAgent,
  httpsAgent: deltaHttpsAgent,
});

/** All public Delta GETs — rate-limited + 429-aware. */
async function deltaPublicGet<T>(
  url: string,
  config?: { params?: Record<string, unknown>; timeout?: number },
): Promise<T> {
  return scheduleDeltaRestRequest(async () => {
    let lastError: unknown;
    for (let attempt = 0; attempt <= DELTA_429_MAX_RETRIES; attempt += 1) {
      try {
        const { data } = await deltaAxios.get<T>(url, config);
        return data;
      } catch (err) {
        lastError = err;
        if (isAxios429(err)) {
          if (handleDeltaCdn429(err)) {
            throw new DeltaRestPausedError(
              "API Paused globally due to CDN limit",
              "cdn",
            );
          }
          if (attempt < DELTA_429_MAX_RETRIES) {
            const retryAfter = axios.isAxiosError(err)
              ? parseRetryAfterMs(
                  (err.response?.headers ?? {}) as Record<string, unknown>,
                )
              : null;
            const delay =
              retryAfter ?? DELTA_429_BASE_DELAY_MS * 2 ** attempt;
            console.warn(
              `[delta] HTTP 429 on GET ${url} — retry ${attempt + 1}/${DELTA_429_MAX_RETRIES} after ${delay}ms`,
            );
            await sleepMs(delay);
            continue;
          }
        }
        throw err;
      }
    }
    throw lastError ?? new Error("Delta public GET failed after retries");
  });
}

const DELTA_429_MAX_RETRIES = 3;
const DELTA_429_BASE_DELAY_MS = 500;

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(headers: Record<string, unknown>): number | null {
  const raw = headers["retry-after"];
  if (raw == null) return null;
  const value = String(raw).trim();
  const asSeconds = Number(value);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return Math.ceil(asSeconds * 1000);
  }
  const asDate = Date.parse(value);
  if (Number.isFinite(asDate)) {
    return Math.max(0, asDate - Date.now());
  }
  return null;
}

function isAxios429(err: unknown): boolean {
  return (
    axios.isAxiosError(err) &&
    err.response != null &&
    err.response.status === 429
  );
}

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
  let lastError: unknown;

  for (let attempt = 0; attempt <= DELTA_429_MAX_RETRIES; attempt += 1) {
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

    try {
      const data = await scheduleDeltaRestRequest(async () => {
        const { data: responseData } = await deltaAxios.request<
          T & { success?: boolean; error?: unknown }
        >({
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
        return responseData;
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
    } catch (err) {
      lastError = err;
      if (isDeltaRestPausedError(err)) {
        throw err;
      }
      if (isAxios429(err)) {
        if (handleDeltaCdn429(err)) {
          throw new DeltaRestPausedError(
            "API Paused globally due to CDN limit",
            "cdn",
          );
        }
        if (attempt < DELTA_429_MAX_RETRIES) {
          const retryAfter = axios.isAxiosError(err)
            ? parseRetryAfterMs(
                (err.response?.headers ?? {}) as Record<string, unknown>,
              )
            : null;
          const delay =
            retryAfter ?? DELTA_429_BASE_DELAY_MS * 2 ** attempt;
          console.warn(
            `[delta] HTTP 429 on ${args.method} ${args.path} — retry ${attempt + 1}/${DELTA_429_MAX_RETRIES} after ${delay}ms`,
          );
          await sleepMs(delay);
          continue;
        }
      }
      throw err;
    }
  }

  throw lastError ?? new Error("Delta REST request failed after retries");
}

function parseOrderCommission(order: Record<string, unknown>): number | null {
  return (
    numberOrNull(order.paid_commission) ??
    numberOrNull(order.commission) ??
    numberOrNull(order.total_commission)
  );
}

function parseOrderFillPrice(order: Record<string, unknown>): number | null {
  return (
    numberOrNull(order.average_fill_price) ??
    numberOrNull(order.average_price) ??
    numberOrNull(order.price) ??
    numberOrNull(order.limit_price)
  );
}

async function fetchDeltaOrderById(
  apiKey: string,
  secret: string,
  orderId: string,
): Promise<Record<string, unknown> | null> {
  const id = orderId.trim();
  if (!id) return null;
  try {
    const response = await deltaIndiaSignedRequest<{ result?: unknown }>({
      apiKey,
      secret,
      method: "GET",
      path: `/v2/orders/${encodeURIComponent(id)}`,
    });
    const row = response.result;
    if (row != null && typeof row === "object" && !Array.isArray(row)) {
      return row as Record<string, unknown>;
    }
  } catch (err) {
    console.warn(
      `[exchangeService] fetchDeltaOrderById failed orderId=${id}:`,
      err instanceof Error ? err.message : err,
    );
  }
  return null;
}

const SETTLEMENT_POLL_ATTEMPTS = 8;
const SETTLEMENT_POLL_INTERVAL_MS = 400;

/** Poll filled order for Delta `paid_commission` + average fill (POST ack can omit them). */
async function enrichRestOrderFillDetails(
  apiKey: string,
  secret: string,
  initial: Record<string, unknown>,
  _contractSize: number,
  _lots: number,
): Promise<{ fillPrice: number | null; feeCost: number | null }> {
  let row = initial;
  const orderId = String(initial.id ?? "").trim();

  for (let attempt = 0; attempt < SETTLEMENT_POLL_ATTEMPTS; attempt += 1) {
    const fillPrice = parseOrderFillPrice(row);
    const fee = parseOrderCommission(row);
    if (fillPrice != null && fillPrice > 0 && fee != null) {
      return { fillPrice, feeCost: Math.abs(fee) };
    }
    if (attempt >= SETTLEMENT_POLL_ATTEMPTS - 1 || !orderId) break;
    await new Promise((r) => setTimeout(r, SETTLEMENT_POLL_INTERVAL_MS));
    const fresh = await fetchDeltaOrderById(apiKey, secret, orderId);
    if (fresh) row = fresh;
  }

  const fillPrice = parseOrderFillPrice(row);
  const feeCost = parseOrderCommission(row);
  return {
    fillPrice: fillPrice != null && fillPrice > 0 ? fillPrice : null,
    feeCost:
      feeCost != null && Number.isFinite(feeCost) ? Math.max(0, Math.abs(feeCost)) : null,
  };
}

function normalizeDeltaApiRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) {
    return result.filter(
      (r): r is Record<string, unknown> => r != null && typeof r === "object",
    );
  }
  return [];
}

function parseDeltaRealizedPnl(position: Record<string, unknown>): number | null {
  const candidates = [
    position.realized_pnl,
    position.realizedPnl,
    position.realised_pnl,
  ];
  for (const raw of candidates) {
    if (raw === undefined || raw === null) continue;
    const n = parseFloat(String(raw));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export type DeltaPositionPnlSnapshot = {
  realizedPnl: number | null;
  unrealizedPnl: number | null;
};

export type DeltaCloseSettlement = {
  orderId: string;
  exitPrice: number;
  exitFee: number;
  /** Gross realized PnL from Delta position delta / crystallized UPL (before entry fees). */
  grossRealizedPnl: number;
  fillCount: number;
};

function aggregateFillSummary(fills: Record<string, unknown>[]): {
  exitPrice: number | null;
  exitFee: number;
} {
  let totalSize = 0;
  let weightedPrice = 0;
  let totalFee = 0;
  for (const f of fills) {
    const size = numberOrNull(f.size) ?? 0;
    const price = numberOrNull(f.price) ?? 0;
    const comm = numberOrNull(f.commission) ?? 0;
    if (size > 0 && price > 0) {
      weightedPrice += price * size;
      totalSize += size;
    }
    if (comm > 0) totalFee += Math.abs(comm);
  }
  return {
    exitPrice: totalSize > 0 ? weightedPrice / totalSize : null,
    exitFee: totalFee,
  };
}

async function fetchDeltaFillsRaw(
  apiKey: string,
  secret: string,
  params: Record<string, string | number>,
): Promise<Record<string, unknown>[]> {
  const query: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    query[k] = String(v);
  }
  const response = await deltaIndiaSignedRequest<{ result?: unknown }>({
    apiKey,
    secret,
    method: "GET",
    path: "/v2/fills",
    query,
  });
  return normalizeDeltaApiRows(response.result);
}

/** Fills for a specific order — filters recent page when API has no order_id query param. */
export async function fetchDeltaFillsForOrder(
  apiKey: string,
  secret: string,
  orderId: string,
): Promise<Record<string, unknown>[]> {
  const id = orderId.trim();
  if (!id) return [];
  try {
    const fills = await fetchDeltaFillsRaw(apiKey, secret, { page_size: 50 });
    const matched = fills.filter((f) => String(f.order_id ?? "").trim() === id);
    if (matched.length > 0) return matched;
    return fills.filter((f) => String(f.order_id ?? "").trim() === id);
  } catch (err) {
    console.warn(
      `[exchangeService] fetchDeltaFillsForOrder failed orderId=${id}:`,
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

/** Read Delta native realized + unrealized PnL for one open leg (REST pass-through). */
export async function snapshotDeltaPositionPnl(
  apiKeyStored: string,
  apiSecretStored: string,
  symbol: string,
  side: TradeSide,
): Promise<DeltaPositionPnlSnapshot | null> {
  const apiKey = decryptDeltaSecretOrPlain(apiKeyStored);
  const secret = decryptDeltaSecretOrPlain(apiSecretStored);
  const positions = await fetchDeltaMarginedPositionSnapshotRaw(apiKey, secret);
  const { tradePositionSymbolsAlign } = await import("./tradePositionService.js");

  for (const row of positions) {
    const rawSize = numberOrNull(row.size);
    if (rawSize === null || Math.abs(rawSize) < 1e-12) continue;
    const productSymbol = String(row.product_symbol ?? "").trim();
    if (!productSymbol) continue;
    const legSide = tradeSideFromSignedSize(rawSize);
    if (legSide !== side) continue;
    if (!tradePositionSymbolsAlign(symbol, productSymbol)) continue;
    return {
      realizedPnl: parseDeltaRealizedPnl(row),
      unrealizedPnl: parseDeltaPositionUnrealizedPnl(row),
    };
  }
  return { realizedPnl: null, unrealizedPnl: null };
}

/** Gross realized PnL for a close from Delta position snapshots (no local price math). */
export function computeDeltaCloseGrossRealizedPnl(
  pre: DeltaPositionPnlSnapshot | null | undefined,
  post: DeltaPositionPnlSnapshot | null | undefined,
): number | null {
  if (!pre) return null;
  const preR = pre.realizedPnl ?? 0;
  const preU = pre.unrealizedPnl ?? 0;
  if (post != null) {
    const postR = post.realizedPnl ?? 0;
    const postU = post.unrealizedPnl ?? 0;
    const delta = postR - preR + (preU - postU);
    return Number.isFinite(delta) ? delta : null;
  }
  if (preU !== 0) return preU;
  return preR !== 0 ? null : 0;
}

async function fetchDeltaProductCashflowSince(
  apiKey: string,
  secret: string,
  productId: number,
  startTimeMicros: number,
): Promise<number | null> {
  try {
    const response = await deltaIndiaSignedRequest<{ result?: unknown }>({
      apiKey,
      secret,
      method: "GET",
      path: "/v2/wallet/transactions",
      query: {
        start_time: String(startTimeMicros),
        page_size: "50",
      },
    });
    const rows = normalizeDeltaApiRows(response.result);
    let sum = 0;
    let found = false;
    for (const row of rows) {
      const pid = numberOrNull(row.product_id);
      if (pid !== productId) continue;
      const tt = String(row.transaction_type ?? "").toLowerCase();
      if (tt !== "cashflow" && tt !== "fill_appropriation") continue;
      const amt = parseFloat(String(row.amount ?? "0"));
      if (Number.isFinite(amt)) {
        sum += amt;
        found = true;
      }
    }
    return found ? sum : null;
  } catch {
    return null;
  }
}

/**
 * Poll Delta order + fills until exit price, commission, and gross realized PnL are available.
 */
export async function fetchDeltaCloseSettlement(
  apiKeyStored: string,
  apiSecretStored: string,
  orderId: string,
  opts: {
    symbol: string;
    openSide: TradeSide;
    preSnapshot?: DeltaPositionPnlSnapshot | null;
    productId?: number;
    fillCreatedAtMicros?: number;
  },
): Promise<DeltaCloseSettlement | null> {
  const apiKey = decryptDeltaSecretOrPlain(apiKeyStored);
  const secret = decryptDeltaSecretOrPlain(apiSecretStored);
  const id = orderId.trim();
  if (!id) return null;

  for (let attempt = 0; attempt < SETTLEMENT_POLL_ATTEMPTS; attempt += 1) {
    const order = await fetchDeltaOrderById(apiKey, secret, id);
    const fills = await fetchDeltaFillsForOrder(apiKey, secret, id);
    const fillAgg = aggregateFillSummary(fills);
    const exitPrice =
      (order ? parseOrderFillPrice(order) : null) ?? fillAgg.exitPrice;
    const orderFee = order ? parseOrderCommission(order) : null;
    const exitFee =
      orderFee != null
        ? Math.abs(orderFee)
        : fillAgg.exitFee > 0
          ? fillAgg.exitFee
          : null;

    const state = String(order?.state ?? "").toLowerCase();
    const filled =
      state === "closed" ||
      (exitPrice != null && exitPrice > 0 && (exitFee != null || fills.length > 0));

    if (filled && exitPrice != null && exitPrice > 0 && exitFee != null) {
      const post = await snapshotDeltaPositionPnl(
        apiKeyStored,
        apiSecretStored,
        opts.symbol,
        opts.openSide,
      );
      let gross =
        computeDeltaCloseGrossRealizedPnl(opts.preSnapshot, post) ??
        computeDeltaCloseGrossRealizedPnl(opts.preSnapshot, null);

      if (gross == null && opts.productId != null && opts.fillCreatedAtMicros != null) {
        gross = await fetchDeltaProductCashflowSince(
          apiKey,
          secret,
          opts.productId,
          opts.fillCreatedAtMicros,
        );
      }

      if (gross != null && Number.isFinite(gross)) {
        return {
          orderId: id,
          exitPrice,
          exitFee,
          grossRealizedPnl: gross,
          fillCount: fills.length,
        };
      }
    }

    if (attempt < SETTLEMENT_POLL_ATTEMPTS - 1) {
      await new Promise((r) => setTimeout(r, SETTLEMENT_POLL_INTERVAL_MS));
    }
  }

  console.warn(
    `[exchangeService] fetchDeltaCloseSettlement incomplete orderId=${id} symbol=${opts.symbol}`,
  );
  return null;
}

/** Ghost reconcile — latest closing fill for a flat leg (no pre-snapshot). */
export async function fetchDeltaRecentLegCloseSettlement(
  apiKeyStored: string,
  apiSecretStored: string,
  symbol: string,
  openSide: TradeSide,
): Promise<DeltaCloseSettlement | null> {
  const apiKey = decryptDeltaSecretOrPlain(apiKeyStored);
  const secret = decryptDeltaSecretOrPlain(apiSecretStored);
  const closeSide: TradeSide = openSide === "BUY" ? "SELL" : "BUY";
  const resolved = await resolveDeltaProductNumericId(symbol);
  if (!resolved) return null;

  const startMicros = (Date.now() - 24 * 60 * 60 * 1000) * 1000;
  let fills: Record<string, unknown>[] = [];
  try {
    fills = await fetchDeltaFillsRaw(apiKey, secret, {
      product_ids: String(resolved.productId),
      start_time: startMicros,
      page_size: 50,
    });
  } catch {
    return null;
  }

  const closing = fills
    .filter((f) => {
      const s = String(f.side ?? "").toLowerCase();
      return s === closeSide.toLowerCase() || s === (closeSide === "BUY" ? "buy" : "sell");
    })
    .sort((a, b) => {
      const ta = parseFloat(String(a.created_at ?? "0"));
      const tb = parseFloat(String(b.created_at ?? "0"));
      return tb - ta;
    });

  const latest = closing[0];
  if (!latest) return null;
  const orderId = String(latest.order_id ?? "").trim();
  if (!orderId) return null;
  const createdMicros = parseFloat(String(latest.created_at ?? "0"));

  return fetchDeltaCloseSettlement(apiKeyStored, apiSecretStored, orderId, {
    symbol,
    openSide,
    preSnapshot: null,
    productId: resolved.productId,
    ...(Number.isFinite(createdMicros) ? { fillCreatedAtMicros: createdMicros } : {}),
  });
}

/** Raw margined rows for internal snapshot helpers (no CCXT parse). */
async function fetchDeltaMarginedPositionSnapshotRaw(
  apiKey: string,
  secret: string,
): Promise<Record<string, unknown>[]> {
  const response = await deltaIndiaSignedRequest<{ result?: unknown }>({
    apiKey,
    secret,
    method: "GET",
    path: "/v2/positions/margined",
    query: {
      contract_types: "perpetual_futures,call_options,put_options",
    },
  });
  return normalizeDeltaApiRows(response.result);
}

async function resolveDeltaProductNumericId(
  productRef: string,
): Promise<{ symbol: string; productId: number; contractSize: number } | null> {
  for (const ref of deltaIndiaProductRefCandidates(productRef)) {
    const row = await fetchDeltaProductFromRestApi(ref);
    if (!row) continue;

    const symbol = String(row.symbol ?? "").trim();
    const productId = Number(row.id);
    if (!symbol || !Number.isFinite(productId) || productId <= 0) continue;

    const contractValue = Number(row.contract_value ?? 0.001);
    const contractSize =
      Number.isFinite(contractValue) && contractValue > 0 ? contractValue : 0.001;

    if (ref.trim().toUpperCase() !== productRef.trim().toUpperCase()) {
      console.log(
        `[exchangeService] resolved product "${productRef}" via alias "${ref}" → ${symbol}`,
      );
    }

    return { symbol, productId, contractSize };
  }

  return null;
}

/** Delta India perp ids use …USD (e.g. BTCUSD); copy rows often store …USDT. */
function deltaIndiaProductRefCandidates(ref: string): string[] {
  const trimmed = ref.trim();
  const upper = trimmed.toUpperCase();
  if (!upper) return [];

  if (isDeltaOptionProductId(trimmed) || /^\d+$/.test(trimmed)) {
    return [trimmed];
  }

  const seen = new Set<string>();
  const out: string[] = [];
  const push = (v: string) => {
    const t = v.trim();
    if (!t) return;
    const key = t.toUpperCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(t);
  };

  push(trimmed);
  if (upper.endsWith("USDT")) {
    push(`${upper.slice(0, -4)}USD`);
  } else if (upper.endsWith("USD") && !upper.endsWith("USDT")) {
    push(`${upper.slice(0, -3)}USDT`);
  }

  return out;
}

/** Compact Delta India perp product ref — BTCUSDT → BTCUSD for REST orders / position reads. */
export function normalizeDeltaPerpProductRef(raw: string): string {
  const s = raw.trim();
  if (!s || isDeltaOptionProductId(s) || s.includes("/")) return s;
  const upper = s.toUpperCase();
  if (upper.endsWith("USDT")) {
    return `${upper.slice(0, -4)}USD`;
  }
  return s;
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

  if (opts?.reduceOnly === true && size <= 0) {
    return { success: false, error: "Reduce-only close requires positive size" };
  }

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

    const isOptionOrder = isDeltaOptionProductId(resolved.symbol);
    const openSide: TradeSide | null = opts?.reduceOnly
      ? side === "BUY"
        ? "SELL"
        : "BUY"
      : null;
    let preSnapshot: DeltaPositionPnlSnapshot | null = null;
    if (openSide != null) {
      preSnapshot = await snapshotDeltaPositionPnl(
        apiKey,
        secret,
        resolved.symbol,
        openSide,
      );
    }

    let fillPrice: number | null = parseOrderFillPrice(order);
    let feeCost: number | null = parseOrderCommission(order);
    if (feeCost != null) feeCost = Math.abs(feeCost);

    const enriched = await enrichRestOrderFillDetails(
      apiKey,
      secret,
      order,
      resolved.contractSize,
      lots,
    );
    fillPrice = enriched.fillPrice ?? fillPrice;
    feeCost = enriched.feeCost ?? feeCost;

    const orderIdRaw = order.id;
    const orderId =
      orderIdRaw != null && String(orderIdRaw).trim()
        ? String(orderIdRaw)
        : undefined;

    let closeSettlement: DeltaCloseSettlement | undefined;
    if (opts?.reduceOnly === true && orderId && openSide != null) {
      const settlement = await fetchDeltaCloseSettlement(apiKey, secret, orderId, {
        symbol: resolved.symbol,
        openSide,
        preSnapshot,
        productId: resolved.productId,
      });
      if (settlement) {
        closeSettlement = settlement;
        fillPrice = settlement.exitPrice;
        feeCost = settlement.exitFee;
      }
    }

    return {
      success: true,
      ...(orderId ? { orderId } : {}),
      ...(clientOrderId ? { clientOrderId } : {}),
      ...(fillPrice != null && fillPrice > 0 ? { fillPrice } : {}),
      ...(feeCost != null && Number.isFinite(feeCost)
        ? { feeCost: Math.max(0, feeCost) }
        : {}),
      ...(closeSettlement
        ? {
            closeSettlement,
            grossRealizedPnl: closeSettlement.grossRealizedPnl,
          }
        : {}),
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

const MARGINED_POSITION_CONTRACT_TYPES =
  "perpetual_futures,call_options,put_options";

/**
 * Overlay realtime size/entry only — never copy UPNL from `/v2/positions` (margined API is terminal source).
 */
function overlayRealtimeSizeOnMarginedRow(
  margined: Record<string, unknown>,
  rt: { size: number; entryPrice: string | null; row: Record<string, unknown> },
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    ...margined,
    size: rt.size,
  };
  if (rt.entryPrice != null) out.entry_price = rt.entryPrice;
  return out;
}

/** Stable key for merging margined + realtime position rows. */
function positionProductMergeKey(position: Record<string, unknown>): string {
  const ps = String(position.product_symbol ?? "").trim();
  if (ps && !/^\d+$/.test(ps)) return ps.toUpperCase();
  const pid = String(position.product_id ?? "").trim();
  return pid ? `pid:${pid}` : "";
}

/** Delta returns a single object, array, or nested list for underlying_asset_symbol queries. */
function normalizeRealtimePositionsResult(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (!result || typeof result !== "object") return [];

  const obj = result as Record<string, unknown>;
  if (Array.isArray(obj.positions)) return obj.positions;
  if (obj.product_id != null || obj.product_symbol != null || obj.size != null) {
    return [result];
  }

  const values = Object.values(obj).filter(
    (v) => v != null && typeof v === "object" && "size" in (v as object),
  );
  return values.length > 0 ? values : [];
}

/**
 * Real-time positions — Delta docs: margined API can lag ~10s after fills/adjustments.
 * `GET /v2/positions?underlying_asset_symbol=BTC` reflects strike rolls immediately.
 */
async function fetchRealtimePositionsViaRest(
  apiKey: string,
  secret: string,
  underlyingAssetSymbol = "BTC",
): Promise<unknown[]> {
  const response = await deltaIndiaSignedRequest<{ result?: unknown }>({
    apiKey,
    secret,
    method: "GET",
    path: "/v2/positions",
    query: { underlying_asset_symbol: underlyingAssetSymbol },
  });
  return normalizeRealtimePositionsResult(response.result);
}

/**
 * Overlay realtime sizes onto margined rows; add new strikes; zero legs absent from realtime.
 */
function mergeRealtimeIntoMarginedPositions(
  marginedRows: unknown[],
  realtimeRows: unknown[],
): { merged: unknown[]; realtimeOpen: number; zeroedStale: number; added: number } {
  const realtimeByKey = new Map<
    string,
    { size: number; entryPrice: string | null; row: Record<string, unknown> }
  >();

  for (const row of realtimeRows) {
    if (!row || typeof row !== "object") continue;
    const pos = row as Record<string, unknown>;
    const key = positionProductMergeKey(pos);
    const size =
      numberOrNull(pos.size) ?? numberOrNull(pos.contracts);
    if (!key || size === null) continue;
    realtimeByKey.set(key, {
      size,
      entryPrice:
        pos.entry_price != null ? String(pos.entry_price) : null,
      row: pos,
    });
  }

  if (realtimeByKey.size === 0) {
    return {
      merged: marginedRows,
      realtimeOpen: 0,
      zeroedStale: 0,
      added: 0,
    };
  }

  const marginedKeys = new Set<string>();
  let zeroedStale = 0;
  const merged = marginedRows.map((row) => {
    if (!row || typeof row !== "object") return row;
    const pos = row as Record<string, unknown>;
    const key = positionProductMergeKey(pos);
    if (key) marginedKeys.add(key);

    const rt = key ? realtimeByKey.get(key) : undefined;
    if (rt === undefined) {
      const marginedSize =
        numberOrNull(pos.size) ?? numberOrNull(pos.contracts);
      if (
        key &&
        marginedSize !== null &&
        Math.abs(marginedSize) >= 1e-12
      ) {
        zeroedStale += 1;
        return { ...pos, size: 0 };
      }
      return row;
    }

    return overlayRealtimeSizeOnMarginedRow(pos, rt);
  });

  let added = 0;
  let realtimeOpen = 0;
  for (const [key, rt] of realtimeByKey) {
    if (Math.abs(rt.size) >= 1e-12) realtimeOpen += 1;
    if (marginedKeys.has(key)) continue;
    if (Math.abs(rt.size) < 1e-12) continue;
    added += 1;
    merged.push({
      product_id: rt.row.product_id,
      product_symbol:
        String(rt.row.product_symbol ?? "").trim() || key.replace(/^pid:/, ""),
      size: rt.size,
      ...(rt.entryPrice != null ? { entry_price: rt.entryPrice } : {}),
      ...(rt.row.unrealized_pnl !== undefined && rt.row.unrealized_pnl !== null
        ? { unrealized_pnl: rt.row.unrealized_pnl }
        : {}),
      ...(rt.row.mark_price !== undefined && rt.row.mark_price !== null
        ? { mark_price: rt.row.mark_price }
        : {}),
      ...(rt.row.average_price !== undefined && rt.row.average_price !== null
        ? { average_price: rt.row.average_price }
        : {}),
    });
  }

  const upnlBaseline = indexMarginedUpnlFieldsByKey(marginedRows);
  const mergedWithUpnl = merged.map((row) => {
    if (!row || typeof row !== "object") return row;
    return restoreMarginedUpnlFields(row as Record<string, unknown>, upnlBaseline);
  });

  return { merged: mergedWithUpnl, realtimeOpen, zeroedStale, added };
}

/** Snapshot margined UPNL before realtime overlay can drop sparse fields. */
function indexMarginedUpnlFieldsByKey(
  marginedRows: unknown[],
): Map<string, { unrealized_pnl?: unknown; unrealized_funding_pnl?: unknown }> {
  const map = new Map<
    string,
    { unrealized_pnl?: unknown; unrealized_funding_pnl?: unknown }
  >();
  for (const row of marginedRows) {
    if (!row || typeof row !== "object") continue;
    const pos = row as Record<string, unknown>;
    const key = positionProductMergeKey(pos);
    if (!key) continue;
    if (pos.unrealized_pnl === undefined && pos.unrealized_funding_pnl === undefined) {
      continue;
    }
    map.set(key, {
      ...(pos.unrealized_pnl !== undefined ? { unrealized_pnl: pos.unrealized_pnl } : {}),
      ...(pos.unrealized_funding_pnl !== undefined
        ? { unrealized_funding_pnl: pos.unrealized_funding_pnl }
        : {}),
    });
  }
  return map;
}

function restoreMarginedUpnlFields(
  row: Record<string, unknown>,
  baseline: Map<string, { unrealized_pnl?: unknown; unrealized_funding_pnl?: unknown }>,
): Record<string, unknown> {
  const key = positionProductMergeKey(row);
  if (!key) return row;
  const size = numberOrNull(row.size) ?? numberOrNull(row.contracts);
  if (size === null || Math.abs(size) < 1e-12) return row;

  const saved = baseline.get(key);
  if (!saved) return row;

  return {
    ...row,
    ...(saved.unrealized_pnl !== undefined ? { unrealized_pnl: saved.unrealized_pnl } : {}),
    ...(saved.unrealized_funding_pnl !== undefined
      ? { unrealized_funding_pnl: saved.unrealized_funding_pnl }
      : {}),
  };
}

/** Authenticated margined positions via Delta REST — paginated, options-inclusive. */
async function fetchMarginedPositionsViaRest(
  apiKey: string,
  secret: string,
): Promise<unknown[]> {
  const all: unknown[] = [];
  let after: string | undefined;

  for (let page = 0; page < 25; page++) {
    const query: Record<string, string> = {
      contract_types: MARGINED_POSITION_CONTRACT_TYPES,
      page_size: "100",
    };
    if (after) query.after = after;

    const response = await deltaIndiaSignedRequest<{
      result?: unknown[];
      meta?: { after?: string | null };
    }>({
      apiKey,
      secret,
      method: "GET",
      path: "/v2/positions/margined",
      query,
    });

    const batch = Array.isArray(response.result) ? response.result : [];
    all.push(...batch);

    const nextAfter = response.meta?.after;
    if (!nextAfter || batch.length === 0) break;
    after = String(nextAfter);
  }

  return all;
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
  {
    client: InstanceType<typeof ccxt.delta>;
    marketsLoaded: boolean;
    lastUsedAt: number;
  }
>();

/** Evict decrypted CCXT clients idle longer than this (memory + secret exposure). */
const AUTH_CLIENT_CACHE_TTL_MS = 12 * 60 * 1000;

function evictStaleAuthClients(now = Date.now()): void {
  for (const [key, entry] of _authClientCache) {
    if (now - entry.lastUsedAt > AUTH_CLIENT_CACHE_TTL_MS) {
      _authClientCache.delete(key);
    }
  }
}

async function getAuthClient(
  apiKey: string,
  secret: string,
): Promise<InstanceType<typeof ccxt.delta>> {
  evictStaleAuthClients();

  // Debug: confirm the credentials CCXT actually receives match the keys
  // stored in the admin panel. `apiKey` here is post-decryption plaintext;
  // mismatched output → encryption key drift or stale cache, not a CCXT bug.
  const maskedKey = apiKey.length > 0 ? "***" : "MISSING";
  console.log(
    `[DEBUG_AUTH] Initializing CCXT client (credentials redacted) key=${maskedKey}`,
  );

  const cacheKey = `${apiKey}::${secret}`;
  const now = Date.now();
  let entry = _authClientCache.get(cacheKey);
  if (!entry) {
    entry = {
      client: initializeDeltaClient(apiKey, secret),
      marketsLoaded: false,
      lastUsedAt: now,
    };
    _authClientCache.set(cacheKey, entry);
  } else {
    entry.lastUsedAt = now;
  }
  if (!entry.marketsLoaded) {
    await entry.client.loadMarkets();
    entry.marketsLoaded = true;
  }
  entry.lastUsedAt = Date.now();
  return entry.client;
}

/** Drop cached CCXT clients after master credentials change. */
export function clearDeltaAuthClientCache(): void {
  _authClientCache.clear();
  _optionMarketCache.clear();
}

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
  /** Delta average fill price from order / fills REST. */
  fillPrice?: number;
  /** Delta `paid_commission` on the closing order (exit leg only). */
  feeCost?: number;
  /** Delta gross realized PnL for reduce-only closes (position delta). */
  grossRealizedPnl?: number;
  /** Full polled settlement when closing a position leg. */
  closeSettlement?: DeltaCloseSettlement;
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

/** Delta v2 tickers / positions nest live quotes under `quotes.best_bid` / `quotes.best_ask`. */
function extractDeltaQuotesBidOffer(
  source: Record<string, unknown> | null,
): { bid: number | null; offer: number | null } {
  if (!source) return { bid: null, offer: null };

  const quotes =
    source.quotes != null && typeof source.quotes === "object"
      ? (source.quotes as Record<string, unknown>)
      : null;

  const bid =
    numberOrNull(source.best_bid) ??
    numberOrNull(source.bid_price) ??
    numberOrNull(source.bid) ??
    (quotes ? numberOrNull(quotes.best_bid) ?? numberOrNull(quotes.bid) : null);

  const offer =
    numberOrNull(source.best_ask) ??
    numberOrNull(source.best_offer) ??
    numberOrNull(source.offer_price) ??
    numberOrNull(source.ask_price) ??
    numberOrNull(source.ask) ??
    (quotes
      ? numberOrNull(quotes.best_ask) ??
        numberOrNull(quotes.ask) ??
        numberOrNull(quotes.offer)
      : null);

  return { bid, offer };
}

/** Bid/offer from margined position or nested product (matches Delta UPL@Bid / UPL@Offer). */
function extractDeltaBidOffer(position: Record<string, unknown>): {
  bid: number | null;
  offer: number | null;
} {
  const product =
    position.product != null && typeof position.product === "object"
      ? (position.product as Record<string, unknown>)
      : null;

  const fromPosition = extractDeltaQuotesBidOffer(position);
  if (fromPosition.bid != null || fromPosition.offer != null) {
    return fromPosition;
  }
  return extractDeltaQuotesBidOffer(product);
}

function deltaContractValueFromMarket(
  market: { contractSize?: unknown },
  position: Record<string, unknown>,
  symbolKey: string,
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

  return deltaContractSizeFallback(symbolKey);
}

/**
 * Options: `contract_value` on the margined/realtime row is authoritative.
 * CCXT `market.contractSize` is often `1` and must not size PnL for BTC options.
 */
function resolveOptionContractValue(
  position: Record<string, unknown>,
  productSymbol: string,
): number {
  const ps = productSymbol.trim().toUpperCase();
  if (
    isDeltaOptionProductId(productSymbol) &&
    (ps.startsWith("C-BTC-") || ps.startsWith("P-BTC-") || ps.includes("BTC"))
  ) {
    return BTC_OPTION_CONTRACT_VALUE;
  }

  const cvDirect = numberOrNull(position.contract_value);
  if (cvDirect != null && cvDirect > 0) return cvDirect;

  const product = position.product;
  if (product != null && typeof product === "object") {
    const cv = numberOrNull((product as Record<string, unknown>).contract_value);
    if (cv != null && cv > 0) return cv;
  }

  return deltaContractSizeFallback(productSymbol);
}

/** Integer `size` = lots; fractional `size` = base BTC → convert to lots. */
function optionContractLotCount(rawSize: number, contractValue: number): number {
  const abs = Math.abs(rawSize);
  if (abs < 1e-12) return 0;

  if (Number.isInteger(abs) && abs >= 1) return abs;

  if (contractValue > 0 && contractValue < 1 && abs < 1) {
    const lots = abs / contractValue;
    if (Number.isFinite(lots) && lots >= 1) {
      return Math.round(lots);
    }
  }

  return abs;
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
    paid_commission?: unknown;
    commission?: unknown;
    info?: Record<string, unknown> | null;
  };
  const fromDelta =
    numberOrNull(o.paid_commission) ??
    numberOrNull(o.commission) ??
    (o.info != null && typeof o.info === "object"
      ? parseOrderCommission(o.info)
      : null);
  if (fromDelta != null) return Math.abs(fromDelta);

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
  /** L2 best bid from margined/ticker REST — UPL@Bid for longs. */
  bestBid: number | null;
  /** L2 best ask (offer) — UPL@Offer for shorts. */
  bestAsk: number | null;
  /** Delta `contract_value` per lot — used to recalculate terminal UPNL. */
  contractValue: number;
  /** Call/put leg — UPL@Bid/Offer only (no mark PnL). */
  isOption: boolean;
  /** Delta server UPL from positions WS/REST (`upl` / terminal field). */
  terminalUpl: number | null;
  unrealizedPnl: number | null;
  /** Delta REST `realized_pnl` — cumulative since position opened. */
  realizedPnl: number | null;
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

/** One margined snapshot per account at a time; 10s TTL avoids duplicate Delta REST under load. */
const MARGINED_SNAPSHOT_TTL_MS = 10_000;
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

/** Delta Web Terminal exit price for UPNL — bid for longs, ask for shorts. */
export function resolveDeltaTerminalExitPrice(
  side: TradeSide,
  quotes: {
    bestBid?: number | null;
    bestAsk?: number | null;
    markPrice?: number | null;
  },
  opts?: { allowMarkFallback?: boolean },
): number | null {
  if (side === "BUY") {
    const bid = quotes.bestBid;
    if (bid != null && Number.isFinite(bid) && bid > 0) return bid;
  } else {
    const ask = quotes.bestAsk;
    if (ask != null && Number.isFinite(ask) && ask > 0) return ask;
  }

  if (opts?.allowMarkFallback === false) return null;

  const mark = quotes.markPrice;
  if (mark != null && Number.isFinite(mark) && mark > 0) return mark;
  return null;
}

export function sideQuoteReady(
  side: TradeSide,
  bestBid: number | null | undefined,
  bestAsk: number | null | undefined,
): boolean {
  if (side === "BUY") {
    return bestBid != null && Number.isFinite(bestBid) && bestBid > 0;
  }
  return bestAsk != null && Number.isFinite(bestAsk) && bestAsk > 0;
}

/**
 * Delta Web Terminal UPNL — UPL@Bid (long) / UPL@Offer (short).
 * Returns null when side quote missing (never mark for options).
 */
export function computeDeltaTerminalUnrealizedPnl(args: {
  side: TradeSide;
  entryPrice: number | null;
  positionLots: number;
  contractValue: number;
  bestBid?: number | null;
  bestAsk?: number | null;
  markPrice?: number | null;
  /** When false (options), never substitute mark if bid/ask for the side is missing. */
  allowMarkFallback?: boolean;
  symbolKey?: string;
}): number | null {
  const { side, entryPrice, positionLots, contractValue } = args;
  const optionLeg = args.allowMarkFallback === false;
  const bestBid = args.bestBid ?? null;
  const bestAsk = args.bestAsk ?? null;

  if (
    entryPrice == null ||
    !Number.isFinite(entryPrice) ||
    !Number.isFinite(positionLots) ||
    Math.abs(positionLots) < 1e-12 ||
    !Number.isFinite(contractValue) ||
    contractValue <= 0
  ) {
    return null;
  }

  if (optionLeg && !sideQuoteReady(side, bestBid, bestAsk)) {
    return null;
  }

  const exitPrice = resolveDeltaTerminalExitPrice(
    side,
    {
      bestBid,
      bestAsk,
      markPrice: args.markPrice ?? null,
    },
    { allowMarkFallback: args.allowMarkFallback !== false },
  );

  if (exitPrice == null || !Number.isFinite(exitPrice)) {
    return null;
  }

  return computeTerminalPnlUsd({
    side,
    entryPrice,
    exitPrice,
    positionLots,
    contractValue,
    ...(args.symbolKey ? { symbol: args.symbolKey } : {}),
  });
}

export type DeltaTerminalQuoteOverrides = {
  bestBid?: number | null;
  bestAsk?: number | null;
  markPrice?: number | null;
};

/** True when PnL must use L2 bid/ask (never mark). */
export function positionRequiresBidAskPnl(
  pos: Pick<DeltaLivePosition, "symbolKey" | "isOption" | "contractValue">,
): boolean {
  if (pos.isOption) return true;
  if (isDeltaOptionProductId(pos.symbolKey)) return true;
  return pos.contractValue > 0 && pos.contractValue < 1;
}

/** Resolve live UPNL — options: bid/ask math first; perps: Delta `upl` then quotes. */
export function resolveDeltaLiveUnrealizedPnl(
  pos: Pick<
    DeltaLivePosition,
    | "symbolKey"
    | "isOption"
    | "side"
    | "entryPrice"
    | "markPrice"
    | "bestBid"
    | "bestAsk"
    | "contracts"
    | "contractValue"
    | "terminalUpl"
  >,
  quoteOverrides?: DeltaTerminalQuoteOverrides | null,
): number | null {
  const bestBid = quoteOverrides?.bestBid ?? pos.bestBid;
  const bestAsk = quoteOverrides?.bestAsk ?? pos.bestAsk;
  const optionLeg = positionRequiresBidAskPnl(pos);

  const computed = computeDeltaTerminalUnrealizedPnl({
    side: pos.side,
    entryPrice: pos.entryPrice,
    positionLots: pos.contracts,
    contractValue: optionLeg
      ? pos.symbolKey.toUpperCase().includes("BTC")
        ? BTC_OPTION_CONTRACT_VALUE
        : pos.contractValue
      : pos.contractValue,
    bestBid,
    bestAsk,
    markPrice: quoteOverrides?.markPrice ?? pos.markPrice,
    allowMarkFallback: !optionLeg,
    symbolKey: pos.symbolKey,
  });

  if (optionLeg) {
    if (computed !== null) return computed;
    const terminalUpl =
      pos.terminalUpl ?? getDeltaTerminalUpl(pos.symbolKey, pos.side);
    if (terminalUpl != null && Number.isFinite(terminalUpl)) {
      return roundPnlUsdHalfUp(terminalUpl);
    }
    return null;
  }

  const terminalUpl =
    pos.terminalUpl ?? getDeltaTerminalUpl(pos.symbolKey, pos.side);
  if (terminalUpl != null && Number.isFinite(terminalUpl)) {
    return roundPnlUsdHalfUp(terminalUpl);
  }

  return computed;
}

/** Atomic quote sync + PnL — bid/ask MUST be populated before calculation. */
export async function hydratePositionForLivePnl(
  pos: DeltaLivePosition,
): Promise<{ position: DeltaLivePosition; livePnl: number | null }> {
  const quotes = await resolveTerminalQuotesForPosition(pos);
  if (quotes === null) {
    return {
      position: { ...pos, bestBid: null, bestAsk: null, markPrice: null },
      livePnl: null,
    };
  }

  const bestBid =
    quotes.bestBid != null && quotes.bestBid > 0 ? quotes.bestBid : null;
  const bestAsk =
    quotes.bestAsk != null && quotes.bestAsk > 0 ? quotes.bestAsk : null;
  const terminalUpl =
    pos.terminalUpl ?? getDeltaTerminalUpl(pos.symbolKey, pos.side);

  const contractValue = positionRequiresBidAskPnl(pos)
    ? pos.symbolKey.toUpperCase().includes("BTC")
      ? BTC_OPTION_CONTRACT_VALUE
      : pos.contractValue
    : pos.contractValue;

  const position: DeltaLivePosition = {
    ...pos,
    bestBid,
    bestAsk,
    markPrice: quotes.markPrice ?? pos.markPrice,
    contractValue,
    terminalUpl,
  };

  const livePnl = resolveDeltaLiveUnrealizedPnl(position);
  return { position, livePnl };
}

export {
  getDeltaTerminalUpl,
  ingestDeltaPositionTerminalUplRow,
  parseDeltaPositionTerminalUpl,
} from "./deltaTerminalUplCache.js";

/** Raw REST `unrealized_pnl` — settlement snapshots only; live UI uses {@link computeDeltaTerminalUnrealizedPnl}. */
export function parseDeltaPositionUnrealizedPnl(
  position: Record<string, unknown>,
): number | null {
  const raw = position.unrealized_pnl;
  if (raw === undefined || raw === null) return null;
  const upnl = Number(raw);
  return Number.isFinite(upnl) ? upnl : null;
}

/** @deprecated Use {@link parseDeltaPositionUnrealizedPnl}. */
function parseApiUnrealizedPnl(position: Record<string, unknown>): number | null {
  return parseDeltaPositionUnrealizedPnl(position);
}

/**
 * Options `size`: integer = lot count (× contract_value); fractional = already BTC.
 */
function optionSignedBaseSize(rawSize: number, contractValue: number): number {
  const abs = Math.abs(rawSize);
  if (abs < 1e-12) return 0;

  const isLotCount =
    Number.isInteger(abs) && abs >= 1 && contractValue > 0 && contractValue < 1;
  if (isLotCount) return rawSize * contractValue;

  if (!Number.isInteger(abs) && abs <= 10) return rawSize;

  return rawSize * contractValue;
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
  _exchange: InstanceType<typeof ccxt.delta>,
  raw: string,
): ResolvedExactDeltaProduct | null {
  const ref = raw.trim();
  if (!ref) return null;

  if (isValidDeltaOptionProductSymbol(ref)) {
    const productId = ref.trim().toUpperCase();
    return { productId, ccxtSymbol: productId };
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
const PRODUCT_REST_CACHE_TTL_MS = 30 * 60 * 1000;
const productRestCache = new Map<
  string,
  { at: number; row: Record<string, unknown> | null }
>();

function isOptionQuoteRef(ref: string): boolean {
  const t = ref.trim();
  return isDeltaOptionProductId(t) || /^\d+$/.test(t);
}

/** Subscribe option/perp on public WS — dynamic import avoids exchangeService ↔ livePriceTracker cycle. */
function requestOptionWsSubscribe(ref: string): void {
  const sym = ref.trim();
  if (!sym) return;
  void import("./livePriceTracker.js")
    .then((m) => m.registerSymbolsForLivePrices([sym]))
    .catch(() => {
      /* WS tracker may not be started yet */
    });
}

async function fetchDeltaProductFromRestApi(
  productRef: string,
): Promise<Record<string, unknown> | null> {
  const ref = productRef.trim();
  if (!ref) return null;

  const cacheKey = ref.toUpperCase();
  const hit = productRestCache.get(cacheKey);
  if (hit && Date.now() - hit.at < PRODUCT_REST_CACHE_TTL_MS) {
    return hit.row;
  }

  try {
    const data = await deltaPublicGet<{ success?: boolean; result?: unknown }>(
      `${DELTA_INDIA_API_BASE}/v2/products/${encodeURIComponent(ref)}`,
      { timeout: 20_000 },
    );
    const row =
      data?.success === true &&
      data.result != null &&
      typeof data.result === "object" &&
      !Array.isArray(data.result)
        ? (data.result as Record<string, unknown>)
        : null;
    productRestCache.set(cacheKey, { at: Date.now(), row });
    return row;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[exchangeService] fetchDeltaProductFromRestApi failed ref=${ref}: ${msg}`,
    );
    productRestCache.set(cacheKey, { at: Date.now(), row: null });
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
  _exchange?: InstanceType<typeof ccxt.delta>,
): Promise<ResolvedExactDeltaProduct | null> {
  const ref = raw.trim();
  if (!ref) return null;

  if (isValidDeltaOptionProductSymbol(ref)) {
    const productId = ref.trim().toUpperCase();
    return { productId, ccxtSymbol: productId };
  }

  if (isDeltaOptionProductId(ref) || /^\d+$/.test(ref)) {
    const row = await fetchDeltaProductFromRestApi(ref);
    if (!row) return null;
    const sym = String(row.symbol ?? row.product_symbol ?? "").trim();
    if (!isValidDeltaOptionProductSymbol(sym)) return null;
    const productId = sym.toUpperCase();
    return { productId, ccxtSymbol: productId };
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

  if (isValidDeltaOptionProductSymbol(productSymbol)) {
    const productId = productSymbol.trim().toUpperCase();
    return {
      market: null,
      unified: productId,
      symbolKey: productId,
      isOption: true,
      contractSize: fallbackSize,
    };
  }

  if (isDeltaOptionProductId(productSymbol) || /^\d+$/.test(productSymbol.trim())) {
    return {
      market: null,
      unified: productSymbol,
      symbolKey: productSymbol,
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
  opts?: {
    reduceOnly?: boolean;
    clientOrderId?: string;
    /** Admin / manual ops — bypass master open policy gate. */
    bypassMasterOpenPolicy?: boolean;
    /** Logged on order ack for tracing caller. */
    orderSource?: string;
  },
): Promise<ExecuteTradeResult> {
  const clientOrderId = opts?.clientOrderId?.trim() || undefined;
  const inputSymbol = normalizeDeltaPerpProductRef(symbol.trim());
  const reduceOnly = opts?.reduceOnly === true;
  const orderSource = opts?.orderSource?.trim() || "unspecified";
  try {
    const apiKey = decryptDeltaSecretOrPlain(encryptedApiKey);
    const secret = decryptDeltaSecretOrPlain(encryptedApiSecret);
    if (!apiKey || !secret) {
      return {
        success: false,
        error: "Invalid or undecryptable Delta API credentials",
      };
    }

    const { assertMasterExchangeOpenAllowed } = await import(
      "./masterOrderPolicy.js"
    );
    const policy = assertMasterExchangeOpenAllowed(
      apiKey,
      reduceOnly,
      opts?.bypassMasterOpenPolicy === true,
    );
    if (!policy.ok) {
      console.warn(
        `[copy-exec] BLOCKED master open symbol="${inputSymbol}" side=${side} lots=${size} ` +
          `source=${orderSource} reason=${policy.error}`,
      );
      return { success: false, error: policy.error };
    }

    const isOptionOrder =
      isDeltaOptionProductId(inputSymbol) || /^\d+$/.test(inputSymbol);

    // Delta REST first — authoritative `paid_commission`, fill price, contract_value.
    {
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
          `[copy-exec] REST market order ok symbol="${inputSymbol}" lots=${size} ` +
            `orderId=${restResult.orderId ?? "none"} source=${orderSource} reduceOnly=${reduceOnly}`,
        );
        return restResult;
      }
      if (isOptionOrder) {
        console.warn(
          `[copy-exec] option order REST failed for "${inputSymbol}" — ` +
            `CCXT fallback disabled: ${restResult.error ?? "unknown"}`,
        );
        return restResult;
      }
      if (reduceOnly) {
        console.warn(
          `[copy-exec] reduceOnly perp close REST failed for "${inputSymbol}" — ` +
            `trying CCXT fallback: ${restResult.error ?? "unknown"}`,
        );
      } else {
        console.warn(
          `[copy-exec] REST perp order failed for "${inputSymbol}" — trying CCXT fallback: ${restResult.error ?? "unknown"}`,
        );
      }
    }

    const exchange = await getAuthClient(apiKey, secret);

    let canonicalProductId = inputSymbol;
    let ccxtSymbol: string;
    try {
      ccxtSymbol = resolveCcxtSymbol(exchange, inputSymbol);
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
        `ccxtSymbol="${ccxtSymbol}" reduceOnly=${reduceOnly} ` +
        `clientOrderId=${clientOrderId ?? "none"}`,
    );

    const ccxtSide = side === "BUY" ? "buy" : "sell";
    const params: Record<string, unknown> = {};
    if (reduceOnly) {
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

    const explicitFee = extractFeeCostFromOrder(order);
    const feeCost =
      explicitFee != null && Number.isFinite(explicitFee) && explicitFee > 0
        ? Math.abs(explicitFee)
        : undefined;

    const fillPrice = extractFillPriceFromOrder(order);

    return {
      success: true,
      orderId: order.id ?? undefined,
      ...(clientOrderId ? { clientOrderId } : {}),
      ...(fillPrice != null ? { fillPrice } : {}),
      ...(feeCost != null ? { feeCost } : {}),
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

/** Lookup order ack by client_order_id — Delta REST only (no CCXT fetchOrders). */
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
    if (!apiKey || !secret) return empty;

    const response = await deltaIndiaSignedRequest<{ result?: unknown }>({
      apiKey,
      secret,
      method: "GET",
      path: `/v2/orders/client_order_id/${encodeURIComponent(id)}`,
    });
    const row = response.result;
    if (row != null && typeof row === "object" && !Array.isArray(row)) {
      return parseDeltaClientOrderAckRow(row as Record<string, unknown>);
    }
  } catch (err) {
    console.warn(
      `[exchangeService] REST client_order_id lookup failed clientOrderId=${id}:`,
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
  const fallback = deltaContractSizeFallback(symbol);
  const ref = symbol.trim();
  if (!ref) return fallback;

  const resolved = await resolveDeltaProductNumericId(ref);
  if (resolved != null && resolved.contractSize > 0) {
    return resolved.contractSize;
  }

  try {
    const exchange = await getPublicClient();
    const ccxtSymbol = resolveCcxtSymbol(exchange, ref);
    const market = exchange.market(ccxtSymbol);
    const cs = Number(market.contractSize ?? NaN);
    if (!Number.isFinite(cs) || cs <= 0) return fallback;
    // CCXT often reports `1` for Delta India linear contracts — use known fallbacks.
    if (fallback < 1 && cs >= 1) return fallback;
    return cs;
  } catch {
    return fallback;
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
 * Delta India public REST ticker — CCXT omits most live option contracts.
 * Prefer bulk GET /v2/tickers (30s cache). Options never use per-symbol REST.
 */
type DeltaTickerQuote = {
  last: number | null;
  mark: number | null;
  bid: number | null;
  ask: number | null;
};

const ALL_TICKERS_TTL_MS = 30_000;
let allTickersCache: {
  at: number;
  byRef: Map<string, DeltaTickerQuote>;
} | null = null;
let allTickersInflight: Promise<Map<string, DeltaTickerQuote>> | null = null;

function parseDeltaTickerRow(row: Record<string, unknown>): DeltaTickerQuote {
  const last =
    numberOrNull(row.close) ??
    numberOrNull(row.mark_price) ??
    numberOrNull(row.spot_price);
  const mark = numberOrNull(row.mark_price) ?? last;
  const { bid, offer: ask } = extractDeltaQuotesBidOffer(row);
  return { last, mark, bid, ask };
}

function indexTickerRow(
  map: Map<string, DeltaTickerQuote>,
  row: Record<string, unknown>,
): void {
  const sym = String(
    row.symbol ?? row.product_symbol ?? row.s ?? "",
  ).trim();
  const id = String(row.product_id ?? row.id ?? "").trim();
  const parsed = parseDeltaTickerRow(row);

  if (sym) {
    map.set(sym, parsed);
    map.set(sym.toUpperCase(), parsed);
  }
  if (id) {
    map.set(id, parsed);
  }
}

async function fetchAllDeltaTickersMap(): Promise<Map<string, DeltaTickerQuote>> {
  if (
    allTickersCache &&
    Date.now() - allTickersCache.at < ALL_TICKERS_TTL_MS
  ) {
    return allTickersCache.byRef;
  }

  if (allTickersInflight) return allTickersInflight;

  allTickersInflight = (async () => {
    try {
      const data = await deltaPublicGet<{
        success?: boolean;
        result?: unknown;
      }>(`${DELTA_INDIA_API_BASE}/v2/tickers`, { timeout: 25_000 });

      const map = new Map<string, DeltaTickerQuote>();
      if (data?.success === true && Array.isArray(data.result)) {
        for (const row of data.result) {
          if (row && typeof row === "object" && !Array.isArray(row)) {
            indexTickerRow(map, row as Record<string, unknown>);
          }
        }
      }
      allTickersCache = { at: Date.now(), byRef: map };
      return map;
    } finally {
      allTickersInflight = null;
    }
  })();

  return allTickersInflight;
}

function lookupDeltaTickerFromMap(
  map: Map<string, DeltaTickerQuote>,
  productRef: string,
): DeltaTickerQuote | null {
  const ref = productRef.trim();
  if (!ref) return null;

  const tried = new Set<string>();
  const tryKey = (candidate: string): DeltaTickerQuote | null => {
    const c = candidate.trim();
    if (!c) return null;
    const upper = c.toUpperCase();
    if (tried.has(upper)) return null;
    tried.add(upper);
    return map.get(c) ?? map.get(upper) ?? null;
  };

  const direct = tryKey(ref);
  if (direct) return direct;

  for (const alias of deltaIndiaProductRefCandidates(ref)) {
    const hit = tryKey(alias);
    if (hit) return hit;
  }

  return null;
}

async function lookupDeltaTickerFromBulk(
  productRef: string,
): Promise<DeltaTickerQuote | null> {
  const map = await fetchAllDeltaTickersMap();
  return lookupDeltaTickerFromMap(map, productRef);
}

/** WS-only for options — never hits per-symbol L2 REST. Perps may use REST when WS stale. */
async function fetchDeltaL2BestQuotesForRef(
  ref: string,
): Promise<{ bid: number | null; ask: number | null }> {
  const trimmed = ref.trim();
  if (!trimmed) return { bid: null, ask: null };

  if (isOptionQuoteRef(trimmed)) {
    requestOptionWsSubscribe(trimmed);
    const ws = resolveOptionQuotesWsOnly(trimmed);
    return { bid: ws.bestBid, ask: ws.bestAsk };
  }

  const ws = resolveLiveQuotes(trimmed);
  if (isLiveQuotesFresh(trimmed)) {
    const bid =
      ws.bestBid != null && ws.bestBid > 0 ? ws.bestBid : null;
    const ask =
      ws.bestAsk != null && ws.bestAsk > 0 ? ws.bestAsk : null;
    if (bid != null || ask != null) {
      return { bid, ask };
    }
  }

  try {
    const data = await deltaPublicGet<{ success?: boolean; result?: unknown }>(
      `${DELTA_INDIA_API_BASE}/v2/l2orderbook/${encodeURIComponent(trimmed)}`,
      { params: { depth: 1 }, timeout: 15_000 },
    );
    if (data?.success !== true || data.result == null || typeof data.result !== "object") {
      return { bid: null, ask: null };
    }

    const book = data.result as {
      buy?: Array<{ price?: unknown }>;
      sell?: Array<{ price?: unknown }>;
    };
    const bid = book.buy?.[0] ? numberOrNull(book.buy[0].price) : null;
    const ask = book.sell?.[0] ? numberOrNull(book.sell[0].price) : null;
    if (bid != null || ask != null) {
      cacheLiveQuotes(trimmed, { bid, ask });
    }
    return { bid, ask };
  } catch (err) {
    if (isDeltaRestPausedError(err)) {
      return { bid: null, ask: null };
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[exchangeService] fetchDeltaL2BestQuotes failed ref=${trimmed}:`,
      msg,
    );
    return { bid: null, ask: null };
  }
}

async function fetchDeltaL2BestQuotes(
  productRef: string,
): Promise<{ bid: number | null; ask: number | null }> {
  const ref = productRef.trim();
  if (!ref) return { bid: null, ask: null };

  if (isOptionQuoteRef(ref)) {
    requestOptionWsSubscribe(ref);
    return fetchDeltaL2BestQuotesForRef(ref);
  }

  const tried = new Set<string>();
  const tryRef = async (candidate: string): Promise<{ bid: number | null; ask: number | null } | null> => {
    const c = candidate.trim();
    if (!c || tried.has(c.toUpperCase())) return null;
    tried.add(c.toUpperCase());
    const q = await fetchDeltaL2BestQuotesForRef(c);
    if (
      (q.bid != null && q.bid > 0) ||
      (q.ask != null && q.ask > 0)
    ) {
      return q;
    }
    return null;
  };

  const direct = await tryRef(ref);
  if (direct) return direct;

  for (const alias of deltaIndiaProductRefCandidates(ref)) {
    const q = await tryRef(alias);
    if (q) return q;
  }

  return { bid: null, ask: null };
}

/** Bulk `/v2/tickers` only — never per-symbol GET. Options use WS cache exclusively. */
async function fetchDeltaTickerFromRestApi(
  productRef: string,
): Promise<DeltaTickerQuote> {
  const ref = productRef.trim();
  const empty = { last: null, mark: null, bid: null, ask: null };
  if (!ref) return empty;

  if (isOptionQuoteRef(ref)) {
    requestOptionWsSubscribe(ref);
    const ws = resolveOptionQuotesWsOnly(ref);
    return {
      last: ws.markPrice,
      mark: ws.markPrice,
      bid: ws.bestBid,
      ask: ws.bestAsk,
    };
  }

  const bulk = await lookupDeltaTickerFromBulk(ref);
  return bulk ?? empty;
}

/**
 * Public top-of-book + mark for terminal UPNL (UPL@Bid / UPL@Offer).
 * Options: WebSocket cache only — subscribe and wait; never per-symbol REST.
 */
export async function fetchDeltaBestQuotes(
  symbol: string,
): Promise<{ bid: number | null; ask: number | null; mark: number | null }> {
  const ref = symbol.trim();
  if (!ref) return { bid: null, ask: null, mark: null };

  if (isOptionQuoteRef(ref)) {
    requestOptionWsSubscribe(ref);
    const ws = resolveOptionQuotesWsOnly(ref);
    return { bid: ws.bestBid, ask: ws.bestAsk, mark: ws.markPrice };
  }

  const ws = resolveLiveQuotes(ref);
  if (isLiveQuotesFresh(ref)) {
    const bid =
      ws.bestBid != null && ws.bestBid > 0 ? ws.bestBid : null;
    const ask =
      ws.bestAsk != null && ws.bestAsk > 0 ? ws.bestAsk : null;
    const mark =
      ws.markPrice != null && ws.markPrice > 0 ? ws.markPrice : null;
    if (bid != null || ask != null || mark != null) {
      return { bid, ask, mark };
    }
  }

  let bid: number | null = null;
  let ask: number | null = null;
  let mark: number | null = null;

  const rest = await fetchDeltaTickerFromRestApi(ref);
  bid = rest.bid;
  ask = rest.ask;
  mark =
    rest.mark ??
    (rest.last != null && Number.isFinite(rest.last) && rest.last > 0
      ? rest.last
      : null);

  if (bid == null || ask == null) {
    const l2 = await fetchDeltaL2BestQuotes(ref);
    bid = bid ?? l2.bid;
    ask = ask ?? l2.ask;
  }

  if (mark == null) {
    const markRes = await fetchDeltaMarkPrice(ref);
    mark = markRes.markPrice;
  }

  if (bid != null || ask != null || mark != null) {
    cacheLiveQuotes(ref, { bid, ask, mark });
  }

  return { bid, ask, mark };
}

/** Boot seed: options → WS subscribe only; perps → one bulk `/v2/tickers` (30s TTL). */
export async function seedTerminalQuotesForSymbols(
  symbols: Iterable<string>,
): Promise<void> {
  const unique = [
    ...new Set(
      [...symbols]
        .map((s) => String(s ?? "").trim())
        .filter((s) => s.length > 0),
    ),
  ];
  if (unique.length === 0) return;

  const optionSymbols = unique.filter(isOptionQuoteRef);
  const perpSymbols = unique.filter((s) => !isOptionQuoteRef(s));

  for (const sym of optionSymbols) {
    requestOptionWsSubscribe(sym);
  }

  if (perpSymbols.length === 0) return;

  const needsPerpSeed = perpSymbols.filter((sym) => !hasFreshTerminalQuotes(sym));
  if (needsPerpSeed.length === 0) return;

  try {
    const map = await fetchAllDeltaTickersMap();
    for (const sym of needsPerpSeed) {
      const rest = lookupDeltaTickerFromMap(map, sym);
      if (rest) {
        cacheLiveQuotes(sym, {
          bid: rest.bid,
          ask: rest.ask,
          mark: rest.mark,
        });
      }
    }
  } catch (err) {
    if (!isDeltaRestPausedError(err)) {
      console.warn(
        `[exchangeService] bulk ticker seed failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

/**
 * WS cache for options (never REST). Perps may use bulk REST when WS stale.
 * Returns null when option side quote is missing (UI shows "—").
 */
export async function resolveTerminalQuotesForPosition(
  pos: Pick<
    DeltaLivePosition,
    "symbolKey" | "side" | "bestBid" | "bestAsk" | "markPrice" | "isOption" | "contractValue"
  >,
): Promise<DeltaTerminalQuoteOverrides | null> {
  const cached = resolveLiveQuotes(pos.symbolKey);
  let bestBid = cached.bestBid ?? pos.bestBid;
  let bestAsk = cached.bestAsk ?? pos.bestAsk;

  const optionLeg = positionRequiresBidAskPnl(pos);
  if (optionLeg) {
    requestOptionWsSubscribe(pos.symbolKey);
    const ws = resolveOptionQuotesWsOnly(pos.symbolKey);
    if (ws.bestBid != null && ws.bestBid > 0) bestBid = ws.bestBid;
    if (ws.bestAsk != null && ws.bestAsk > 0) bestAsk = ws.bestAsk;

    if (!sideQuoteReady(pos.side, bestBid, bestAsk)) {
      return null;
    }

    return { bestBid, bestAsk, markPrice: null };
  }

  let markPrice = cached.markPrice ?? pos.markPrice;
  if (
    isLiveQuotesFresh(pos.symbolKey) &&
    sideQuoteReady(pos.side, bestBid, bestAsk)
  ) {
    return { bestBid, bestAsk, markPrice };
  }

  if (!sideQuoteReady(pos.side, bestBid, bestAsk)) {
    const rest = await fetchDeltaBestQuotes(pos.symbolKey);
    if (bestBid == null || bestBid <= 0) bestBid = rest.bid;
    if (bestAsk == null || bestAsk <= 0) bestAsk = rest.ask;
    if (markPrice == null || markPrice <= 0) markPrice = rest.mark;
    cacheLiveQuotes(pos.symbolKey, {
      bid: rest.bid,
      ask: rest.ask,
      mark: rest.mark,
    });
  }

  return { bestBid, bestAsk, markPrice };
}

/**
 * Public last traded price — for slippage checks only (not for unrealized PnL).
 * Options: WS cache only (subscribe + wait). Perps: bulk REST / CCXT.
 */
export async function fetchDeltaTicker(
  symbol: string,
): Promise<{ last: number | null }> {
  const ref = symbol.trim();
  if (!ref) return { last: null };

  if (isOptionQuoteRef(ref)) {
    requestOptionWsSubscribe(ref);
    const ws = resolveOptionQuotesWsOnly(ref);
    if (ws.markPrice != null) return { last: ws.markPrice };
    const mid =
      ws.bestBid != null &&
      ws.bestAsk != null &&
      ws.bestBid > 0 &&
      ws.bestAsk > 0
        ? (ws.bestBid + ws.bestAsk) / 2
        : ws.bestBid ?? ws.bestAsk;
    if (mid != null && Number.isFinite(mid) && mid > 0) {
      return { last: mid };
    }
    return { last: null };
  }

  try {
    const exchange = await getPublicClient();
    const ccxtSymbol = resolveCcxtSymbol(exchange, ref);
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
    try {
      const realtimeRows = await fetchRealtimePositionsViaRest(apiKey, secret, "BTC");
      const overlay = mergeRealtimeIntoMarginedPositions(rawList, realtimeRows);
      rawList = overlay.merged;
      if (
        overlay.realtimeOpen > 0 ||
        overlay.zeroedStale > 0 ||
        overlay.added > 0
      ) {
        console.log(
          `[exchangeService] realtime position overlay open=${overlay.realtimeOpen} ` +
            `added=${overlay.added} zeroedStale=${overlay.zeroedStale} ` +
            `marginedRows=${overlay.merged.length}`,
        );
      }
    } catch (realtimeErr) {
      console.warn(
        `[exchangeService] realtime /v2/positions overlay skipped:`,
        realtimeErr instanceof Error ? realtimeErr.message : realtimeErr,
      );
    }
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
          if (isValidDeltaOptionProductSymbol(pid)) {
            productSymbol = pid;
          } else if (/^\d+$/.test(pid)) {
            const row = await fetchDeltaProductFromRestApi(pid);
            const sym = String(row?.symbol ?? row?.product_symbol ?? "").trim();
            productSymbol =
              sym && isValidDeltaOptionProductSymbol(sym) ? sym : pid;
          } else {
            productSymbol = pid;
          }
        }
      } else if (/^\d+$/.test(productSymbol)) {
        const row = await fetchDeltaProductFromRestApi(productSymbol);
        const sym = String(row?.symbol ?? row?.product_symbol ?? "").trim();
        if (sym && isValidDeltaOptionProductSymbol(sym)) {
          productSymbol = sym;
        }
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

      const contractValue = isOption
        ? resolveOptionContractValue(position, productSymbol)
        : deltaContractValueFromMarket(market ?? {}, position, productSymbol);

      const pnlContractValue = isOption && symbolKey.toUpperCase().includes("BTC")
        ? BTC_OPTION_CONTRACT_VALUE
        : contractValue;

      const signedBtc = isOption
        ? optionSignedBaseSize(contractLots, contractValue)
        : market != null
          ? deltaSignedBtcSize(contractLots, contractValue)
          : Number.isInteger(Math.abs(contractLots)) && Math.abs(contractLots) >= 1
            ? contractLots * contractValue
            : contractLots;

      const realBaseSize = isOption
        ? Math.abs(optionSignedBaseSize(contractLots, contractValue))
        : Math.abs(signedBtc) > 1e-12
          ? Math.abs(signedBtc)
          : Math.abs(contractLots);
      let contractLotCount = isOption
        ? optionContractLotCount(contractLots, contractValue)
        : deltaContractLotCount(contractLots, contractSize, signedBtc);
      if (contractLotCount < 1e-12) {
        contractLotCount = Math.abs(contractLots);
      }
      if (contractLotCount < 1e-12) continue;

      const entryPrice =
        numberOrNull(position.entry_price) ??
        numberOrNull(position.average_price);

      const markPrice = extractDeltaMarkPrice(position);
      const { bid: bestBid, offer: bestAsk } = extractDeltaBidOffer(position);

      const unrealizedPnl = computeDeltaTerminalUnrealizedPnl({
        side,
        entryPrice,
        positionLots: contractLotCount,
        contractValue: pnlContractValue,
        bestBid,
        bestAsk,
        markPrice,
        allowMarkFallback: !isOption,
        symbolKey,
      });
      const realizedPnl = parseDeltaRealizedPnl(position);

      if (!lite && unrealizedPnl === null) {
        console.log(
          `[PNL_TRACKER] ${unified} option=${isOption} side=${side} ` +
            `lots=${contractLotCount} cv=${contractValue} entry=${entryPrice ?? "n/a"} ` +
            `bid=${bestBid ?? "n/a"} ask=${bestAsk ?? "n/a"} mark=${markPrice ?? "n/a"}`,
        );
      }

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

      const terminalUpl = parseDeltaPositionTerminalUpl(position);
      if (terminalUpl !== null) {
        cacheDeltaTerminalUpl(symbolKey, side, terminalUpl);
      }

      open.push({
        symbol: unified,
        symbolKey,
        side,
        contracts: contractLotCount,
        realBaseSize,
        entryPrice,
        markPrice,
        bestBid,
        bestAsk,
        contractValue,
        isOption,
        terminalUpl,
        unrealizedPnl:
          unrealizedPnl !== null && Number.isFinite(unrealizedPnl)
            ? unrealizedPnl
            : null,
        realizedPnl,
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
    const data = await deltaPublicGet<{ result?: DeltaProductRow[] }>(
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
