import ccxt from "ccxt";
import {
  decryptDeltaSecretOrPlain,
} from "../utils/encryption.js";

/** Delta Exchange India REST base (CCXT `delta` defaults to global `api.delta.exchange`). */
const DELTA_INDIA_API_BASE = "https://api.india.delta.exchange";

/**
 * Single factory for `ccxt.delta`: swap markets, rate limit, and **Delta India** REST URLs
 * (required for India API keys and tickers).
 */
export function initializeDeltaClient(
  apiKey?: string,
  secret?: string,
): InstanceType<typeof ccxt.delta> {
  const exchange = new ccxt.delta({
    enableRateLimit: true,
    options: {
      defaultType: "swap",
    },
    ...(apiKey != null && apiKey !== "" ? { apiKey } : {}),
    ...(secret != null && secret !== "" ? { secret } : {}),
  });
  exchange.urls.api = {
    public: DELTA_INDIA_API_BASE,
    private: DELTA_INDIA_API_BASE,
  };
  return exchange;
}

export type TradeSide = "BUY" | "SELL";

export interface ExecuteTradeResult {
  success: boolean;
  orderId?: string;
  raw?: unknown;
  error?: string;
}

/** Normalized open perpetual position from Delta (for dashboards). */
export interface DeltaLivePosition {
  /** CCXT unified symbol (Delta India linear perps: e.g. ETH/USD:USD) */
  symbol: string;
  /** Compact ticker-style id aligned with copy-trade symbols (e.g. ETHUSDT). */
  symbolKey: string;
  side: TradeSide;
  contracts: number;
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

/** Cosmic / UI keys (ETHUSDT, ETHUSD) → match keys for {@link unifiedSymbolToKey} on CCXT markets. */
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
 */
export async function executeTrade(
  encryptedApiKey: string,
  encryptedApiSecret: string,
  symbol: string,
  side: TradeSide,
  size: number,
): Promise<ExecuteTradeResult> {
  try {
    const apiKey = decryptDeltaSecretOrPlain(encryptedApiKey);
    const secret = decryptDeltaSecretOrPlain(encryptedApiSecret);

    const exchange = initializeDeltaClient(apiKey, secret);

    await exchange.loadMarkets();

    const ccxtSymbol =
      resolveDeltaIndiaSwapUnifiedSymbol(exchange, symbol) ??
      normalizeDeltaPerpSymbolForCcxt(symbol);
    const ccxtSide = side === "BUY" ? "buy" : "sell";

    let order: Awaited<ReturnType<typeof exchange.createMarketOrder>>;
    try {
      order = await exchange.createMarketOrder(ccxtSymbol, ccxtSide, size);
    } catch (orderErr) {
      const message =
        orderErr instanceof Error ? orderErr.message : String(orderErr);
      console.log(message);
      return {
        success: false,
        error: message,
      };
    }

    return {
      success: true,
      orderId: order.id ?? undefined,
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
 * Public market data for slippage checks (no API keys required).
 * Uses Delta India via {@link initializeDeltaClient}. Returns `{ last: null }` on any failure
 * (missing market, network, etc.) so callers never throw.
 */
export async function fetchDeltaTicker(
  symbol: string,
): Promise<{ last: number | null }> {
  try {
    const exchange = initializeDeltaClient();
    await exchange.loadMarkets();
    const ccxtSymbol =
      resolveDeltaIndiaSwapUnifiedSymbol(exchange, symbol) ??
      normalizeDeltaPerpSymbolForCcxt(symbol);
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
 * Authenticated: fetch non-flat perpetual positions from Delta India (swap).
 */
export async function fetchDeltaOpenPositions(
  apiKeyStored: string,
  apiSecretStored: string,
): Promise<DeltaLivePosition[]> {
  const apiKey = decryptDeltaSecretOrPlain(apiKeyStored);
  const secret = decryptDeltaSecretOrPlain(apiSecretStored);

  const exchange = initializeDeltaClient(apiKey, secret);

  await exchange.loadMarkets();
  const positions = await exchange.fetchPositions();

  const out: DeltaLivePosition[] = [];
  for (const p of positions) {
    const contracts = Number(p.contracts ?? 0);
    if (!Number.isFinite(contracts) || Math.abs(contracts) < 1e-12) continue;

    const unified = typeof p.symbol === "string" ? p.symbol : "";
    if (!unified) continue;

    const symbolKey = unifiedSymbolToKey(unified);
    const side = ccxtSideToTradeSide(p.side);

    const entryPrice =
      p.entryPrice !== undefined && p.entryPrice !== null
        ? Number(p.entryPrice)
        : null;
    const markPrice =
      p.markPrice !== undefined && p.markPrice !== null
        ? Number(p.markPrice)
        : null;
    const unrealizedPnl =
      p.unrealizedPnl !== undefined && p.unrealizedPnl !== null
        ? Number(p.unrealizedPnl)
        : null;

    let stopLoss: number | null = null;
    let takeProfit: number | null = null;
    const info = p.info as Record<string, unknown> | undefined;
    if (info && typeof info === "object") {
      const sl =
        typeof info.stop_loss_order_price === "number"
          ? info.stop_loss_order_price
          : typeof info.stop_loss_price === "number"
            ? info.stop_loss_price
            : typeof info.stopLossPrice === "number"
              ? info.stopLossPrice
              : null;
      const tp =
        typeof info.take_profit_order_price === "number"
          ? info.take_profit_order_price
          : typeof info.take_profit_price === "number"
            ? info.take_profit_price
            : typeof info.takeProfitPrice === "number"
              ? info.takeProfitPrice
              : null;
      if (sl !== null && Number.isFinite(sl)) stopLoss = sl;
      if (tp !== null && Number.isFinite(tp)) takeProfit = tp;
    }

    let entryTime: string | null = null;
    if (typeof p.datetime === "string" && p.datetime) {
      entryTime = p.datetime;
    } else if (p.timestamp != null && Number.isFinite(p.timestamp)) {
      entryTime = new Date(p.timestamp).toISOString();
    }

    out.push({
      symbol: unified,
      symbolKey,
      side,
      contracts,
      entryPrice: Number.isFinite(entryPrice ?? NaN) ? entryPrice : null,
      markPrice: Number.isFinite(markPrice ?? NaN) ? markPrice : null,
      unrealizedPnl: Number.isFinite(unrealizedPnl ?? NaN) ? unrealizedPnl : null,
      stopLoss,
      takeProfit,
      entryTime,
    });
  }

  return out;
}
