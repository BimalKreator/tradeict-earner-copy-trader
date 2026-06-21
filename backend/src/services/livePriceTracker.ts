import WebSocket from "ws";
import { SubscriptionStatus, type PrismaClient } from "@prisma/client";
import {
  fetchDeltaOpenPositions,
} from "./exchangeService.js";
import { FUTURE_HEDGE_BTC_SYMBOL } from "./futureHedgeDataService.js";
import {
  cacheLiveQuotes,
  ingestLivePriceWsMessage,
} from "./liveMarkPriceCache.js";

/** Delta Exchange India public WebSocket — mark, v2/ticker quotes, L2 top-of-book. */
const DELTA_INDIA_PUBLIC_WS = "wss://public-socket.india.delta.exchange";

const HEARTBEAT_WATCHDOG_MS = 35_000;
const SYMBOL_REFRESH_MS = 15_000;
const MIN_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 60_000;

const wantedSymbols = new Set<string>();
/** Symbols already sent on the current WS session (incremental subscribe). */
const subscribedSymbols = new Set<string>();
let ws: WebSocket | null = null;
let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let symbolRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
let destroyed = false;

function markPriceSubscribeSymbols(symbols: string[]): string[] {
  return symbols.map((s) => (s.startsWith("MARK:") ? s : `MARK:${s}`));
}

function sendSubscribe(socket: WebSocket, symbols: string[]): void {
  if (symbols.length === 0) return;
  const markSyms = markPriceSubscribeSymbols(symbols);
  socket.send(
    JSON.stringify({
      type: "subscribe",
      payload: {
        channels: [
          { name: "mark_price", symbols: markSyms },
          { name: "ticker", symbols },
          { name: "v2/ticker", symbols },
          { name: "l2_orderbook", symbols },
        ],
      },
    }),
  );
}

/** Subscribe newly opened legs immediately — do not wait for the 3s refresh loop. */
function subscribeNewSymbols(symbols: string[]): void {
  if (symbols.length === 0) return;
  const fresh = symbols.filter((s) => !subscribedSymbols.has(s));
  if (fresh.length === 0) return;

  if (ws && ws.readyState === WebSocket.OPEN) {
    sendSubscribe(ws, fresh);
    for (const s of fresh) subscribedSymbols.add(s);
    console.log(
      `[livePriceTracker] WS subscribe +${fresh.length} symbol(s): ${fresh.slice(0, 5).join(", ")}` +
        (fresh.length > 5 ? ` …+${fresh.length - 5}` : ""),
    );
  }
}

function syncAllSubscriptions(): void {
  subscribeNewSymbols(Array.from(wantedSymbols));
}

/**
 * Register symbols for live v2/ticker + l2_orderbook WS feeds.
 * Triggers an immediate incremental subscribe when the socket is open.
 */
export function registerSymbolsForLivePrices(symbols: Iterable<string>): void {
  const added: string[] = [];
  for (const s of symbols) {
    const t = String(s ?? "").trim();
    if (t && !wantedSymbols.has(t)) {
      wantedSymbols.add(t);
      added.push(t);
    }
  }
  if (added.length > 0) {
    subscribeNewSymbols(added);
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
    console.warn("[livePriceTracker] heartbeat missed; reconnecting");
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
    connect();
  }, delay);
}

function tearDownSocket(): void {
  clearHeartbeat();
  subscribedSymbols.clear();
  try {
    ws?.removeAllListeners();
    ws?.close();
  } catch {
    /* ignore */
  }
  ws = null;
}

function connect(): void {
  if (destroyed) return;
  tearDownSocket();

  const socket = new WebSocket(DELTA_INDIA_PUBLIC_WS);
  ws = socket;

  socket.on("open", () => {
    if (destroyed) return;
    reconnectAttempt = 0;
    socket.send(JSON.stringify({ type: "enable_heartbeat" }));
    armHeartbeat();
    syncAllSubscriptions();
  });

  socket.on("message", (data) => {
    try {
      const parsed: unknown = JSON.parse(data.toString());
      ingestLivePriceWsMessage(parsed);
      if (
        parsed &&
        typeof parsed === "object" &&
        String((parsed as Record<string, unknown>).type ?? "") === "heartbeat"
      ) {
        armHeartbeat();
      }
    } catch {
      /* ignore malformed */
    }
  });

  socket.on("error", (err) => {
    console.error("[livePriceTracker] WS error:", err);
  });

  socket.on("close", () => {
    tearDownSocket();
    if (!destroyed) scheduleReconnect();
  });
}

async function refreshSymbolsFromMasterAccounts(
  prisma: PrismaClient,
): Promise<void> {
  const strategies = await prisma.strategy.findMany({
    where: {
      OR: [
        { autoExitTarget: { not: null } },
        { autoExitStopLoss: { not: null } },
        {
          subscriptions: {
            some: { isActive: true, status: SubscriptionStatus.ACTIVE },
          },
        },
        { NOT: { masterApiKey: "" } },
      ],
    },
    select: { masterApiKey: true, masterApiSecret: true },
  });

  for (const strat of strategies) {
    const key = strat.masterApiKey?.trim() ?? "";
    const secret = strat.masterApiSecret?.trim() ?? "";
    if (!key || !secret) continue;
    try {
      const positions = await fetchDeltaOpenPositions(key, secret);
      for (const p of positions) {
        registerSymbolsForLivePrices([p.symbolKey]);
        cacheLiveQuotes(p.symbolKey, {
          mark: p.markPrice,
          bid: p.bestBid,
          ask: p.bestAsk,
        });
      }
    } catch {
      /* skip strategy */
    }
  }
}

function scheduleSymbolRefresh(prisma: PrismaClient): void {
  symbolRefreshTimer = setTimeout(() => {
    void refreshSymbolsFromMasterAccounts(prisma).finally(() => {
      syncAllSubscriptions();
      if (!destroyed) scheduleSymbolRefresh(prisma);
    });
  }, SYMBOL_REFRESH_MS);
}

/** Start public WS mark/ticker feed + periodic symbol discovery from master accounts. */
export function startLivePriceTracker(prisma: PrismaClient): () => void {
  destroyed = false;
  registerSymbolsForLivePrices([
    FUTURE_HEDGE_BTC_SYMBOL,
    "BTCUSD",
    "BTCUSDT",
  ]);
  connect();
  void refreshSymbolsFromMasterAccounts(prisma).finally(() => syncAllSubscriptions());
  scheduleSymbolRefresh(prisma);

  return () => {
    destroyed = true;
    if (symbolRefreshTimer != null) {
      clearTimeout(symbolRefreshTimer);
      symbolRefreshTimer = null;
    }
    if (reconnectTimer != null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    tearDownSocket();
    wantedSymbols.clear();
    subscribedSymbols.clear();
  };
}
