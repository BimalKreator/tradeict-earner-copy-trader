import WebSocket from "ws";
import { SubscriptionStatus, type PrismaClient } from "@prisma/client";
import { fetchDeltaOpenPositions } from "./exchangeService.js";
import {
  cacheLiveMarkPrice,
  ingestLivePriceWsMessage,
} from "./liveMarkPriceCache.js";

/** Delta Exchange India public WebSocket (mark_price, v2/ticker). */
const DELTA_INDIA_PUBLIC_WS = "wss://public-socket.india.delta.exchange";

const HEARTBEAT_WATCHDOG_MS = 35_000;
const SYMBOL_REFRESH_MS = 3_000;
const MIN_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 60_000;

const wantedSymbols = new Set<string>();
let ws: WebSocket | null = null;
let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let symbolRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
let destroyed = false;
let subscribedKey = "";

export function registerSymbolsForLivePrices(symbols: Iterable<string>): void {
  for (const s of symbols) {
    const t = String(s ?? "").trim();
    if (t) wantedSymbols.add(t);
  }
}

function markPriceSubscribeSymbols(symbols: string[]): string[] {
  return symbols.map((s) => (s.startsWith("MARK:") ? s : `MARK:${s}`));
}

function subscriptionKey(symbols: string[]): string {
  return [...symbols].sort().join("|");
}

function sendSubscribe(socket: WebSocket, symbols: string[]): void {
  if (symbols.length === 0) return;
  const markSyms = markPriceSubscribeSymbols(symbols);
  socket.send(
    JSON.stringify({
      type: "subscribe",
      payload: {
        channels: [
          { name: "v2/ticker", symbols },
          { name: "mark_price", symbols: markSyms },
        ],
      },
    }),
  );
}

function syncSubscriptions(): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const symbols = Array.from(wantedSymbols);
  const key = subscriptionKey(symbols);
  if (key === subscribedKey) return;
  subscribedKey = key;
  if (symbols.length === 0) return;
  sendSubscribe(ws, symbols);
  console.log(
    `[livePriceTracker] subscribed v2/ticker + mark_price for ${symbols.length} symbol(s)`,
  );
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
  subscribedKey = "";
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
    syncSubscriptions();
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
        { subscriptions: { some: { status: SubscriptionStatus.ACTIVE } } },
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
        if (
          p.markPrice != null &&
          Number.isFinite(p.markPrice) &&
          p.markPrice > 0
        ) {
          cacheLiveMarkPrice(p.symbolKey, p.markPrice);
        }
      }
    } catch {
      /* skip strategy */
    }
  }
}

function scheduleSymbolRefresh(prisma: PrismaClient): void {
  symbolRefreshTimer = setTimeout(() => {
    void refreshSymbolsFromMasterAccounts(prisma).finally(() => {
      syncSubscriptions();
      if (!destroyed) scheduleSymbolRefresh(prisma);
    });
  }, SYMBOL_REFRESH_MS);
}

/** Start public WS mark/ticker feed + periodic symbol discovery from master accounts. */
export function startLivePriceTracker(prisma: PrismaClient): () => void {
  destroyed = false;
  connect();
  void refreshSymbolsFromMasterAccounts(prisma).finally(() => syncSubscriptions());
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
  };
}
