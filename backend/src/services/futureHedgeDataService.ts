import WebSocket from "ws";
import type { PrismaClient } from "@prisma/client";
import {
  fetchDeltaTicker,
  initializeDeltaClient,
  resolveCcxtSymbol,
} from "./exchangeService.js";
import { FUTURE_HEDGE_STRATEGY_TITLE } from "./futureHedgeService.js";

/** Compact Delta India perp key (BTC linear perp). */
export const FUTURE_HEDGE_BTC_SYMBOL =
  process.env.FUTURE_HEDGE_BTC_SYMBOL?.trim() || "BTCUSDT";

export type FutureHedgeTrend = "UPTREND" | "DOWNTREND";

const DELTA_INDIA_PUBLIC_WS = "wss://public-socket.india.delta.exchange";

const TICKER_POLL_MS = Number(process.env.FUTURE_HEDGE_TICKER_POLL_MS) || 5_000;
const OHLCV_REFRESH_MS = Number(process.env.FUTURE_HEDGE_OHLCV_REFRESH_MS) || 60_000;
const CONFIG_REFRESH_MS = 30_000;
const OHLCV_TIMEFRAME = process.env.FUTURE_HEDGE_OHLCV_TIMEFRAME?.trim() || "1m";
const OHLCV_CANDLE_LIMIT = 320;
const DEFAULT_EMA_PERIOD = 200;
const HEARTBEAT_WATCHDOG_MS = 35_000;
const MIN_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 60_000;
const PRICE_STALE_MS = 120_000;

type MarketSnapshot = {
  symbol: string;
  livePrice: number | null;
  ema: number | null;
  emaPeriod: number;
  trend: FutureHedgeTrend | null;
  livePriceUpdatedAt: string | null;
  emaUpdatedAt: string | null;
  priceSource: "ws" | "rest" | null;
};

let livePrice: number | null = null;
let livePriceUpdatedAt = 0;
let priceSource: "ws" | "rest" | null = null;
let emaValue: number | null = null;
let emaUpdatedAt = 0;
let emaPeriodConfigured = DEFAULT_EMA_PERIOD;
let lastTrend: FutureHedgeTrend | null = null;

let destroyed = true;
let ws: WebSocket | null = null;
let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
let tickerPollTimer: ReturnType<typeof setInterval> | null = null;
let ohlcvTimer: ReturnType<typeof setInterval> | null = null;
let configTimer: ReturnType<typeof setInterval> | null = null;
let ohlcvInFlight = false;
let ccxtSymbolCached: string | null = null;

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

/** Last traded / close from Delta ticker payloads (not mark-only). */
function extractTickerLastPrice(row: Record<string, unknown>): number | null {
  return (
    num(row.last) ??
    num(row.l) ??
    num(row.close) ??
    num(row.c) ??
    num(row.price) ??
    null
  );
}

function symbolMatchesBtc(raw: string): boolean {
  const s = raw.trim().toUpperCase();
  if (!s) return false;
  const compact = s.startsWith("MARK:") ? s.slice(5) : s;
  const u = compact.toUpperCase();
  return (
    u === FUTURE_HEDGE_BTC_SYMBOL.toUpperCase() ||
    u === "BTCUSD" ||
    u === "BTC/USDT" ||
    u === "BTC/USD:USD"
  );
}

function setLivePrice(price: number, source: "ws" | "rest"): void {
  if (!Number.isFinite(price) || price <= 0) return;
  livePrice = price;
  livePriceUpdatedAt = Date.now();
  priceSource = source;
  recomputeTrend();
}

/**
 * Standard EMA on close prices. Returns the latest EMA value or null if insufficient data.
 */
export function computeEma(closes: number[], period: number): number | null {
  if (period < 1 || closes.length < period) return null;

  const slice = closes.filter((c) => Number.isFinite(c) && c > 0);
  if (slice.length < period) return null;

  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += slice[i]!;
  }
  let ema = sum / period;
  const k = 2 / (period + 1);

  for (let i = period; i < slice.length; i++) {
    ema = (slice[i]! - ema) * k + ema;
  }

  return Number.isFinite(ema) && ema > 0 ? ema : null;
}

function recomputeTrend(): void {
  if (livePrice == null || emaValue == null) return;
  lastTrend = livePrice > emaValue ? "UPTREND" : "DOWNTREND";
}

function isPriceStale(): boolean {
  if (livePriceUpdatedAt <= 0) return true;
  return Date.now() - livePriceUpdatedAt > PRICE_STALE_MS;
}

async function resolveCcxtBtcSymbol(): Promise<string> {
  if (ccxtSymbolCached) return ccxtSymbolCached;
  const exchange = initializeDeltaClient();
  await exchange.loadMarkets();
  ccxtSymbolCached = resolveCcxtSymbol(exchange, FUTURE_HEDGE_BTC_SYMBOL);
  return ccxtSymbolCached;
}

async function refreshEmaFromExchange(period: number): Promise<void> {
  if (ohlcvInFlight) return;
  ohlcvInFlight = true;
  try {
    const exchange = initializeDeltaClient();
    await exchange.loadMarkets();
    const symbol = await resolveCcxtBtcSymbol();
    const candles = await exchange.fetchOHLCV(
      symbol,
      OHLCV_TIMEFRAME,
      undefined,
      OHLCV_CANDLE_LIMIT,
    );

    const closes: number[] = [];
    for (const row of candles) {
      if (!Array.isArray(row) || row.length < 5) continue;
      const close = num(row[4]);
      if (close != null && close > 0) closes.push(close);
    }

    const nextEma = computeEma(closes, period);
    if (nextEma != null) {
      emaValue = nextEma;
      emaUpdatedAt = Date.now();
      recomputeTrend();
    } else {
      console.warn(
        `[future-hedge-data] EMA(${period}) not computed — only ${closes.length} closes`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[future-hedge-data] OHLCV/EMA refresh failed: ${msg}`);
  } finally {
    ohlcvInFlight = false;
  }
}

async function pollTickerRest(): Promise<void> {
  try {
    const { last } = await fetchDeltaTicker(FUTURE_HEDGE_BTC_SYMBOL);
    if (last != null && last > 0) {
      setLivePrice(last, "rest");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[future-hedge-data] REST ticker poll failed: ${msg}`);
  }
}

function ingestWsTickerMessage(raw: unknown): void {
  if (!raw || typeof raw !== "object") return;
  const msg = raw as Record<string, unknown>;
  const type = String(msg.type ?? "");

  if (type !== "ticker" && type !== "v2/ticker") return;

  const layers: unknown[] = [msg.d, msg.data];
  const payload = asRecord(msg.payload);
  if (payload) {
    layers.push(payload.d, payload.data, payload);
  }

  for (const layer of layers) {
    if (Array.isArray(layer)) {
      for (const row of layer) {
        const r = asRecord(row);
        if (!r) continue;
        const sym = String(
          r.s ?? r.symbol ?? r.product_symbol ?? r.sy ?? "",
        ).trim();
        if (!symbolMatchesBtc(sym)) continue;
        const last = extractTickerLastPrice(r);
        if (last != null) setLivePrice(last, "ws");
      }
    } else {
      const r = asRecord(layer);
      if (!r) continue;
      const sym = String(
        r.s ?? r.symbol ?? r.product_symbol ?? r.sy ?? "",
      ).trim();
      if (!symbolMatchesBtc(sym)) continue;
      const last = extractTickerLastPrice(r);
      if (last != null) setLivePrice(last, "ws");
    }
  }
}

function clearHeartbeat(): void {
  if (heartbeatTimer != null) {
    clearTimeout(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function armHeartbeat(): void {
  clearHeartbeat();
  heartbeatTimer = setTimeout(() => {
    console.warn("[future-hedge-data] heartbeat missed; reconnecting WS");
    ws?.terminate();
  }, HEARTBEAT_WATCHDOG_MS);
}

function scheduleReconnect(): void {
  if (destroyed || reconnectTimer != null) return;
  const delay = Math.min(
    MAX_RECONNECT_MS,
    MIN_RECONNECT_MS * 2 ** reconnectAttempt,
  );
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (destroyed) return;
    reconnectAttempt += 1;
    connectWebSocket();
  }, delay);
}

function tearDownSocket(): void {
  clearHeartbeat();
  try {
    ws?.removeAllListeners();
    ws?.close();
  } catch {
    /* ignore */
  }
  ws = null;
}

function connectWebSocket(): void {
  if (destroyed) return;
  tearDownSocket();

  const socket = new WebSocket(DELTA_INDIA_PUBLIC_WS);
  ws = socket;

  socket.on("open", () => {
    if (destroyed) return;
    reconnectAttempt = 0;
    socket.send(JSON.stringify({ type: "enable_heartbeat" }));
    socket.send(
      JSON.stringify({
        type: "subscribe",
        payload: {
          channels: [
            { name: "ticker", symbols: [FUTURE_HEDGE_BTC_SYMBOL] },
            { name: "v2/ticker", symbols: [FUTURE_HEDGE_BTC_SYMBOL] },
          ],
        },
      }),
    );
    armHeartbeat();
    console.log(
      `[future-hedge-data] WS subscribed ticker for ${FUTURE_HEDGE_BTC_SYMBOL}`,
    );
  });

  socket.on("message", (data) => {
    try {
      const parsed: unknown = JSON.parse(data.toString());
      ingestWsTickerMessage(parsed);
      if (
        parsed &&
        typeof parsed === "object" &&
        String((parsed as Record<string, unknown>).type ?? "") === "heartbeat"
      ) {
        armHeartbeat();
      }
    } catch {
      /* ignore malformed frames */
    }
  });

  socket.on("error", (err) => {
    console.error("[future-hedge-data] WS error:", err);
  });

  socket.on("close", () => {
    tearDownSocket();
    if (!destroyed) scheduleReconnect();
  });
}

async function refreshEmaPeriodFromDb(prisma: PrismaClient): Promise<void> {
  try {
    const row = await prisma.futureHedgeConfig.findFirst({
      where: { strategy: { title: FUTURE_HEDGE_STRATEGY_TITLE } },
      select: { emaPeriod: true },
    });
    if (row?.emaPeriod != null && row.emaPeriod >= 1) {
      emaPeriodConfigured = row.emaPeriod;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[future-hedge-data] config read failed: ${msg}`);
  }
}

function startLoops(prisma: PrismaClient): void {
  void pollTickerRest();
  void refreshEmaPeriodFromDb(prisma).then(() =>
    refreshEmaFromExchange(emaPeriodConfigured),
  );

  tickerPollTimer = setInterval(() => {
    void pollTickerRest();
  }, TICKER_POLL_MS);

  ohlcvTimer = setInterval(() => {
    void refreshEmaFromExchange(emaPeriodConfigured);
  }, OHLCV_REFRESH_MS);

  configTimer = setInterval(() => {
    void refreshEmaPeriodFromDb(prisma);
  }, CONFIG_REFRESH_MS);
}

function stopLoops(): void {
  if (tickerPollTimer != null) {
    clearInterval(tickerPollTimer);
    tickerPollTimer = null;
  }
  if (ohlcvTimer != null) {
    clearInterval(ohlcvTimer);
    ohlcvTimer = null;
  }
  if (configTimer != null) {
    clearInterval(configTimer);
    configTimer = null;
  }
  if (reconnectTimer != null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

/**
 * Latest BTC perp last traded price (USD). Returns null if never received or stale.
 */
export function getLiveFuturePrice(): number | null {
  if (isPriceStale()) return null;
  return livePrice;
}

/**
 * UPTREND when live price is above the configured EMA; otherwise DOWNTREND.
 * If price or EMA is unavailable, returns the last known trend or DOWNTREND (conservative).
 */
export function getCurrentTrend(): FutureHedgeTrend {
  if (livePrice != null && emaValue != null && !isPriceStale()) {
    return livePrice > emaValue ? "UPTREND" : "DOWNTREND";
  }
  return lastTrend ?? "DOWNTREND";
}

/** Debug / health snapshot for admin or future engine phases. */
export function getFutureHedgeMarketSnapshot(): MarketSnapshot {
  return {
    symbol: FUTURE_HEDGE_BTC_SYMBOL,
    livePrice: getLiveFuturePrice(),
    ema: emaValue,
    emaPeriod: emaPeriodConfigured,
    trend: getCurrentTrend(),
    livePriceUpdatedAt:
      livePriceUpdatedAt > 0
        ? new Date(livePriceUpdatedAt).toISOString()
        : null,
    emaUpdatedAt:
      emaUpdatedAt > 0 ? new Date(emaUpdatedAt).toISOString() : null,
    priceSource,
  };
}

/**
 * Background BTC market data: Delta public WS (ticker LTP) + REST poll + OHLCV EMA.
 * Safe to call once at boot; repeated calls are ignored while already running.
 */
export function startFutureHedgeDataEngine(prisma: PrismaClient): () => void {
  if (!destroyed) {
    console.warn("[future-hedge-data] engine already running");
    return () => undefined;
  }

  destroyed = false;
  reconnectAttempt = 0;
  console.log(
    `[future-hedge-data] starting engine symbol=${FUTURE_HEDGE_BTC_SYMBOL} timeframe=${OHLCV_TIMEFRAME}`,
  );

  connectWebSocket();
  startLoops(prisma);

  return () => {
    destroyed = true;
    stopLoops();
    tearDownSocket();
    console.log("[future-hedge-data] engine stopped");
  };
}
