import { createHmac } from "node:crypto";
import WebSocket from "ws";
import {
  type PrismaClient,
  SubscriptionStatus,
  TradeStatus,
  UserStatus,
} from "@prisma/client";
import {
  executeTrade,
  fetchDeltaOpenPositions,
  fetchDeltaTicker,
  normalizeDeltaPerpSymbolForCcxt,
  type DeltaLivePosition,
  type TradeSide,
} from "./exchangeService.js";
import { decryptDeltaSecretOrPlain } from "../utils/encryption.js";
import { recordTradePnl } from "../controllers/subscriptionController.js";
import { notifyTradeExecuted } from "./telegramService.js";
import { logUserActivity } from "./userActivityService.js";

/** Delta Exchange India private WebSocket (see Delta WebSocket docs). */
const DELTA_INDIA_PRIVATE_WS = "wss://socket.india.delta.exchange";

const WS_AUTH_PATH = "/live";
const HEARTBEAT_WATCHDOG_MS = 35_000;
const MIN_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 60_000;
const ROSTER_SYNC_MS = 45_000;

function wsAuthSignature(secretPlain: string, timestampSec: string): string {
  const prehash = `GET${timestampSec}${WS_AUTH_PATH}`;
  return createHmac("sha256", secretPlain).update(prehash).digest("hex");
}

function percentSlippage(entry: number, market: number): number {
  if (entry <= 0) return Number.POSITIVE_INFINITY;
  return (Math.abs(market - entry) / entry) * 100;
}

function normalizeSide(raw: unknown): TradeSide | null {
  const s = String(raw ?? "").toLowerCase();
  if (s === "buy" || s === "long") return "BUY";
  if (s === "sell" || s === "short") return "SELL";
  return null;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Flatten nested payload objects from Delta WS messages. */
function asRecord(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function mergePayloadLayers(raw: unknown): Record<string, unknown> {
  const base = asRecord(raw);
  if (!base) return {};
  const out: Record<string, unknown> = { ...base };
  const inner = asRecord(base.payload);
  if (inner) {
    for (const [k, v] of Object.entries(inner)) {
      if (!(k in out)) out[k] = v;
    }
  }
  return out;
}

function orderStateIndicatesFill(state: string): boolean {
  const u = state.toLowerCase();
  return (
    u.includes("fill") ||
    u === "closed" ||
    u === "completed" ||
    u === "done"
  );
}

/**
 * Derives a copy signal from an `orders` channel message (schema varies by contract type).
 */
function extractOrderFillSignal(
  raw: unknown,
): {
  symbol: string;
  side: TradeSide;
  contracts: number;
  avgPrice: number;
  reduceOnly: boolean;
} | null {
  const o = mergePayloadLayers(raw);
  const state = String(o.state ?? o.order_state ?? o.status ?? "");
  if (!orderStateIndicatesFill(state)) return null;

  const symbol = String(
    o.product_symbol ?? o.symbol ?? o.contract_symbol ?? "",
  ).trim();
  if (!symbol) return null;

  const side = normalizeSide(o.side ?? o.order_side);
  if (!side) return null;

  const contracts =
    num(o.fill_qty) ??
    num(o.filled_qty) ??
    num(o.size) ??
    num(o.order_qty);
  if (contracts == null || contracts <= 0) return null;

  const avgPrice =
    num(o.average_fill_price) ??
    num(o.avg_fill_price) ??
    num(o.fill_avg_price) ??
    num(o.price) ??
    num(o.limit_price);
  if (avgPrice == null || avgPrice <= 0) return null;

  const reduceOnly = Boolean(o.reduce_only ?? o.reduceOnly);

  return { symbol, side, contracts, avgPrice, reduceOnly };
}

/**
 * Reads position snapshot fields from a `positions` channel message.
 */
function extractPositionSnapshot(raw: unknown): {
  symbol: string;
  side: TradeSide;
  contracts: number;
  avgEntry: number | null;
  productKey: string;
} | null {
  const o = mergePayloadLayers(raw);
  const symbol = String(
    o.product_symbol ?? o.symbol ?? o.contract_symbol ?? "",
  ).trim();
  const productKey = String(o.product_id ?? symbol);
  if (!symbol && !productKey) return null;

  const side = normalizeSide(o.side ?? o.position_side ?? o.direction);
  if (!side) return null;

  const contracts = Math.abs(
    num(o.size) ?? num(o.position_size) ?? num(o.contracts) ?? 0,
  );
  if (!Number.isFinite(contracts)) return null;

  const avgEntry =
    num(o.entry_price) ?? num(o.avg_entry_price) ?? num(o.avg_admission_price);

  return {
    symbol: symbol || productKey,
    side,
    contracts,
    avgEntry,
    productKey: productKey || symbol,
  };
}

async function recordTrade(
  prisma: PrismaClient,
  args: {
    userId: string;
    strategyId: string;
    symbol: string;
    side: string;
    size: number;
    entryPrice: number;
    status: TradeStatus;
    exitPrice?: number | null;
    pnl?: number | null;
  },
) {
  await prisma.trade.create({
    data: {
      userId: args.userId,
      strategyId: args.strategyId,
      symbol: args.symbol,
      side: args.side,
      size: args.size,
      entryPrice: args.entryPrice,
      status: args.status,
      ...(args.exitPrice != null ? { exitPrice: args.exitPrice } : {}),
      ...(args.pnl != null ? { pnl: args.pnl } : {}),
    },
  });

  if (
    args.status === TradeStatus.CLOSED &&
    args.pnl != null &&
    Number.isFinite(args.pnl)
  ) {
    await recordTradePnl(prisma, {
      userId: args.userId,
      strategyId: args.strategyId,
      tradeProfit: args.pnl,
    });
  }

  if (args.status === TradeStatus.OPEN) {
    void notifyTradeExecuted(prisma, {
      userId: args.userId,
      strategyId: args.strategyId,
      symbol: args.symbol,
      side: args.side,
      size: args.size,
      entryPrice: args.entryPrice,
    }).catch((err) => {
      console.warn("[telegram] notifyTradeExecuted:", err);
    });
  }

  if (args.status === TradeStatus.FAILED) {
    void logUserActivity(prisma, {
      userId: args.userId,
      kind: "TRADE_SKIPPED",
      message: `Trade skipped: ${args.symbol} ${args.side} @ ${args.entryPrice} (size ${args.size})`,
    });
  }
}

function realizedPnlUsd(args: {
  side: TradeSide;
  entryPrice: number;
  exitPrice: number;
  size: number;
}): number {
  const diff = args.exitPrice - args.entryPrice;
  return args.side === "BUY" ? diff * args.size : -diff * args.size;
}

function entryPriceMatches(stored: number, leader: number): boolean {
  const eps = Math.max(1e-8, Math.abs(leader) * 1e-6);
  return Math.abs(stored - leader) <= eps;
}

async function closeFollowerTradeAndRecordPnl(
  prisma: PrismaClient,
  args: {
    userId: string;
    strategyId: string;
    symbol: string;
    side: TradeSide;
    masterEntryPrice: number;
    sizedPosition: number;
    exitPrice: number;
  },
): Promise<void> {
  const candidates = await prisma.trade.findMany({
    where: {
      userId: args.userId,
      strategyId: args.strategyId,
      symbol: args.symbol,
      side: args.side,
      status: TradeStatus.OPEN,
    },
    orderBy: { createdAt: "asc" },
  });

  const open = candidates.find((t) =>
    entryPriceMatches(t.entryPrice, args.masterEntryPrice),
  );

  if (!open) return;

  const tradeProfit = realizedPnlUsd({
    side: args.side,
    entryPrice: args.masterEntryPrice,
    exitPrice: args.exitPrice,
    size: args.sizedPosition,
  });

  await prisma.trade.update({
    where: { id: open.id },
    data: {
      exitPrice: args.exitPrice,
      pnl: tradeProfit,
      status: TradeStatus.CLOSED,
    },
  });

  await recordTradePnl(prisma, {
    userId: args.userId,
    strategyId: args.strategyId,
    tradeProfit,
  });
}

/** Leader snapshot for late-join REST sync (unchanged contract). */
type MasterLedTrade = {
  id: string;
  deltaSymbol: string;
  side: TradeSide;
  entryPrice: number;
  size: number;
};

function deltaPositionsToMasterLed(
  positions: DeltaLivePosition[],
): MasterLedTrade[] {
  const out: MasterLedTrade[] = [];
  for (const p of positions) {
    const entry =
      p.entryPrice != null && Number.isFinite(p.entryPrice)
        ? p.entryPrice
        : p.markPrice != null && Number.isFinite(p.markPrice)
          ? p.markPrice
          : null;
    if (entry === null) continue;
    const size = Math.abs(p.contracts);
    if (!Number.isFinite(size) || size < 1e-12) continue;
    out.push({
      id: `${p.symbolKey}:${p.side}`,
      deltaSymbol: p.symbolKey,
      side: p.side,
      entryPrice: entry,
      size,
    });
  }
  return out;
}

async function fetchMasterOpenPositions(
  apiKey: string,
  apiSecret: string,
): Promise<MasterLedTrade[]> {
  const raw = await fetchDeltaOpenPositions(apiKey, apiSecret);
  return deltaPositionsToMasterLed(raw);
}

export async function lateJoinMirrorOpenPositionsForSubscriber(
  prisma: PrismaClient,
  args: { strategyId: string; userId: string },
): Promise<void> {
  const strategy = await prisma.strategy.findUnique({
    where: { id: args.strategyId },
  });
  if (!strategy || !strategy.syncActiveTrades) return;

  const sub = await prisma.userSubscription.findFirst({
    where: {
      strategyId: args.strategyId,
      userId: args.userId,
      status: SubscriptionStatus.ACTIVE,
    },
    include: {
      exchangeAccount: true,
      user: { include: { deltaApiKeys: true } },
    },
  });
  if (!sub || sub.user.status !== UserStatus.ACTIVE) return;

  let leaders: MasterLedTrade[];
  try {
    leaders = await fetchMasterOpenPositions(
      strategy.masterApiKey,
      strategy.masterApiSecret,
    );
  } catch (err) {
    console.error("[late-join] master Delta fetch failed:", err);
    return;
  }

  for (const leader of leaders) {
    const tickLj = await fetchDeltaTicker(leader.deltaSymbol);
    const marketPrice =
      tickLj.last != null && Number.isFinite(tickLj.last)
        ? tickLj.last
        : undefined;

    const userSize = leader.size * sub.multiplier;

    if (
      marketPrice !== undefined &&
      percentSlippage(leader.entryPrice, marketPrice) > strategy.slippage
    ) {
      await recordTrade(prisma, {
        userId: sub.userId,
        strategyId: strategy.id,
        symbol: leader.deltaSymbol,
        side: leader.side,
        size: userSize,
        entryPrice: leader.entryPrice,
        status: TradeStatus.FAILED,
      });
      continue;
    }

    if (marketPrice === undefined) {
      await recordTrade(prisma, {
        userId: sub.userId,
        strategyId: strategy.id,
        symbol: leader.deltaSymbol,
        side: leader.side,
        size: userSize,
        entryPrice: leader.entryPrice,
        status: TradeStatus.FAILED,
      });
      continue;
    }

    const creds =
      sub.exchangeAccount != null
        ? {
            apiKey: sub.exchangeAccount.apiKey,
            apiSecret: sub.exchangeAccount.apiSecret,
          }
        : sub.user.deltaApiKeys[0] != null
          ? {
              apiKey: sub.user.deltaApiKeys[0]!.apiKey,
              apiSecret: sub.user.deltaApiKeys[0]!.apiSecret,
            }
          : null;

    if (!creds) {
      await recordTrade(prisma, {
        userId: sub.userId,
        strategyId: strategy.id,
        symbol: leader.deltaSymbol,
        side: leader.side,
        size: userSize,
        entryPrice: leader.entryPrice,
        status: TradeStatus.FAILED,
      });
      continue;
    }

    const result = await executeTrade(
      creds.apiKey,
      creds.apiSecret,
      leader.deltaSymbol,
      leader.side,
      userSize,
    );

    if (!result.success) {
      const ccxtSym = normalizeDeltaPerpSymbolForCcxt(leader.deltaSymbol);
      console.error(
        `[late-join] executeTrade failed userId=${sub.userId} strategyId=${strategy.id} deltaSymbol=${leader.deltaSymbol} ccxtSymbol=${ccxtSym} side=${leader.side} size=${userSize}: ${result.error ?? "unknown"}`,
      );
    }

    await recordTrade(prisma, {
      userId: sub.userId,
      strategyId: strategy.id,
      symbol: leader.deltaSymbol,
      side: leader.side,
      size: userSize,
      entryPrice: leader.entryPrice,
      status: result.success ? TradeStatus.OPEN : TradeStatus.FAILED,
    });
  }
}

export async function lateJoinMirrorForAllActiveSubscribers(
  prisma: PrismaClient,
  strategyId: string,
): Promise<void> {
  const strategy = await prisma.strategy.findUnique({
    where: { id: strategyId },
    select: { syncActiveTrades: true },
  });
  if (!strategy?.syncActiveTrades) return;

  const subs = await prisma.userSubscription.findMany({
    where: {
      strategyId,
      status: SubscriptionStatus.ACTIVE,
      user: { status: UserStatus.ACTIVE },
    },
    select: { userId: true },
  });

  for (const row of subs) {
    try {
      await lateJoinMirrorOpenPositionsForSubscriber(prisma, {
        strategyId,
        userId: row.userId,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[tradeEngine] late-join backfill failed strategyId=${strategyId} userId=${row.userId}:`,
        msg,
      );
    }
  }
}

async function copyMasterFillToSubscribers(
  prisma: PrismaClient,
  strategyId: string,
  args: {
    symbol: string;
    side: TradeSide;
    masterContracts: number;
    avgPrice: number;
  },
): Promise<void> {
  const strategy = await prisma.strategy.findUnique({
    where: { id: strategyId },
  });
  if (!strategy) return;

  const tick = await fetchDeltaTicker(args.symbol);
  const marketPrice =
    tick.last != null && Number.isFinite(tick.last) ? tick.last : undefined;

  const subs = await prisma.userSubscription.findMany({
    where: {
      strategyId,
      status: SubscriptionStatus.ACTIVE,
      user: { status: UserStatus.ACTIVE },
    },
    include: {
      exchangeAccount: true,
      user: { include: { deltaApiKeys: true } },
    },
  });

  const skipAll =
    marketPrice !== undefined &&
    percentSlippage(args.avgPrice, marketPrice) > strategy.slippage;

  if (skipAll) {
    console.warn(
      `[tradeEngine] Slippage exceeded for ${args.symbol}; skipping copy for strategy ${strategyId}`,
    );
    await Promise.all(
      subs.map(async (sub) => {
        const userSize = args.masterContracts * sub.multiplier;
        await recordTrade(prisma, {
          userId: sub.userId,
          strategyId,
          symbol: args.symbol,
          side: args.side,
          size: userSize,
          entryPrice: args.avgPrice,
          status: TradeStatus.FAILED,
        });
      }),
    );
    return;
  }

  if (marketPrice === undefined) {
    await Promise.all(
      subs.map(async (sub) => {
        const userSize = args.masterContracts * sub.multiplier;
        await recordTrade(prisma, {
          userId: sub.userId,
          strategyId,
          symbol: args.symbol,
          side: args.side,
          size: userSize,
          entryPrice: args.avgPrice,
          status: TradeStatus.FAILED,
        });
      }),
    );
    return;
  }

  await Promise.all(
    subs.map(async (sub) => {
      const userSize = args.masterContracts * sub.multiplier;
      const creds =
        sub.exchangeAccount != null
          ? {
              apiKey: sub.exchangeAccount.apiKey,
              apiSecret: sub.exchangeAccount.apiSecret,
            }
          : sub.user.deltaApiKeys[0] != null
            ? {
                apiKey: sub.user.deltaApiKeys[0]!.apiKey,
                apiSecret: sub.user.deltaApiKeys[0]!.apiSecret,
              }
            : null;

      if (!creds) {
        await recordTrade(prisma, {
          userId: sub.userId,
          strategyId,
          symbol: args.symbol,
          side: args.side,
          size: userSize,
          entryPrice: args.avgPrice,
          status: TradeStatus.FAILED,
        });
        return;
      }

      const result = await executeTrade(
        creds.apiKey,
        creds.apiSecret,
        args.symbol,
        args.side,
        userSize,
      );

      await recordTrade(prisma, {
        userId: sub.userId,
        strategyId,
        symbol: args.symbol,
        side: args.side,
        size: userSize,
        entryPrice: args.avgPrice,
        status: result.success ? TradeStatus.OPEN : TradeStatus.FAILED,
      });
    }),
  );
}

async function notifyMasterFlat(
  prisma: PrismaClient,
  strategyId: string,
  snap: {
    symbol: string;
    side: TradeSide;
    masterEntryPrice: number;
    masterContracts: number;
  },
): Promise<void> {
  const tick = await fetchDeltaTicker(snap.symbol);
  const exitPrice =
    tick.last != null && Number.isFinite(tick.last) ? tick.last : undefined;
  if (exitPrice === undefined || !Number.isFinite(exitPrice)) return;

  const subs = await prisma.userSubscription.findMany({
    where: {
      strategyId,
      status: SubscriptionStatus.ACTIVE,
      user: { status: UserStatus.ACTIVE },
    },
  });

  await Promise.all(
    subs.map(async (sub) => {
      const userSize = snap.masterContracts * sub.multiplier;
      await closeFollowerTradeAndRecordPnl(prisma, {
        userId: sub.userId,
        strategyId,
        symbol: snap.symbol,
        side: snap.side,
        masterEntryPrice: snap.masterEntryPrice,
        sizedPosition: userSize,
        exitPrice,
      });
    }),
  );
}

type LastOpenMeta = {
  symbol: string;
  side: TradeSide;
  contracts: number;
  avgEntry: number;
};

class StrategyMasterSocket {
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private destroyed = false;
  /** Last non-zero position per product (for closed detection). */
  private readonly lastPositionContracts = new Map<string, number>();
  private readonly lastOpenMeta = new Map<string, LastOpenMeta>();

  constructor(
    private readonly prisma: PrismaClient,
    readonly strategyId: string,
  ) {}

  start(): void {
    if (this.destroyed) return;
    this.connect();
  }

  private clearHeartbeatWatchdog(): void {
    if (this.heartbeatTimer != null) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private armHeartbeatWatchdog(): void {
    this.clearHeartbeatWatchdog();
    this.heartbeatTimer = setTimeout(() => {
      console.warn(
        `[tradeEngine] heartbeat missed strategyId=${this.strategyId}; reconnecting`,
      );
      this.ws?.terminate();
    }, HEARTBEAT_WATCHDOG_MS);
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    if (this.reconnectTimer != null) return;
    const delay = Math.min(
      MAX_RECONNECT_MS,
      MIN_RECONNECT_MS * 2 ** this.reconnectAttempt,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.destroyed) return;
      this.reconnectAttempt += 1;
      this.connect();
    }, delay);
  }

  private tearDownSocket(): void {
    this.clearHeartbeatWatchdog();
    try {
      this.ws?.removeAllListeners();
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }

  private connect(): void {
    if (this.destroyed) return;
    this.tearDownSocket();

    void this.prisma.strategy
      .findUnique({ where: { id: this.strategyId } })
      .then((s) => {
        if (this.destroyed) return;
        if (!s) {
          this.scheduleReconnect();
          return;
        }
        const key = decryptDeltaSecretOrPlain(s.masterApiKey).trim();
        const secret = decryptDeltaSecretOrPlain(s.masterApiSecret).trim();
        if (!key || !secret) {
          this.scheduleReconnect();
          return;
        }

        const socket = new WebSocket(DELTA_INDIA_PRIVATE_WS);
        this.ws = socket;

        socket.on("open", () => {
          if (this.destroyed) return;
          this.reconnectAttempt = 0;
          socket.send(JSON.stringify({ type: "enable_heartbeat" }));
          const ts = String(Math.floor(Date.now() / 1000));
          const signature = wsAuthSignature(secret, ts);
          socket.send(
            JSON.stringify({
              type: "auth",
              payload: {
                "api-key": key,
                signature,
                timestamp: ts,
              },
            }),
          );
          this.armHeartbeatWatchdog();
        });

        socket.on("message", (data) => {
          void this.onMessage(data);
        });

        socket.on("error", (err) => {
          console.error(
            `[tradeEngine] WS error strategyId=${this.strategyId}:`,
            err,
          );
        });

        socket.on("close", () => {
          this.tearDownSocket();
          if (!this.destroyed) this.scheduleReconnect();
        });
      })
      .catch((err) => {
        console.error(
          `[tradeEngine] strategy load failed strategyId=${this.strategyId}:`,
          err,
        );
        this.scheduleReconnect();
      });
  }

  private async onMessage(data: WebSocket.RawData): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const msg = parsed as Record<string, unknown>;
    const type = String(msg.type ?? "");

    if (type === "heartbeat") {
      this.armHeartbeatWatchdog();
      return;
    }

    if (
      type === "success" &&
      String(msg.message ?? "").toLowerCase() === "authenticated"
    ) {
      const subPayload = {
        type: "subscribe",
        payload: {
          channels: [
            { name: "orders", symbols: ["all"] },
            { name: "positions", symbols: ["all"] },
          ],
        },
      };
      this.ws?.send(JSON.stringify(subPayload));
      return;
    }

    if (type === "orders") {
      const sig = extractOrderFillSignal(parsed);
      if (!sig || sig.reduceOnly) return;
      await copyMasterFillToSubscribers(this.prisma, this.strategyId, {
        symbol: sig.symbol,
        side: sig.side,
        masterContracts: sig.contracts,
        avgPrice: sig.avgPrice,
      });
      return;
    }

    if (type === "positions") {
      const snap = extractPositionSnapshot(parsed);
      if (!snap) return;

      const prev = this.lastPositionContracts.get(snap.productKey) ?? 0;
      const next = snap.contracts;

      if (next <= 0 && prev > 0) {
        const meta = this.lastOpenMeta.get(snap.productKey);
        if (meta != null && meta.avgEntry > 0) {
          await notifyMasterFlat(this.prisma, this.strategyId, {
            symbol: meta.symbol,
            side: meta.side,
            masterEntryPrice: meta.avgEntry,
            masterContracts: prev,
          });
        }
        this.lastPositionContracts.delete(snap.productKey);
        this.lastOpenMeta.delete(snap.productKey);
        return;
      }

      if (next > 0) {
        const avg =
          snap.avgEntry ??
          this.lastOpenMeta.get(snap.productKey)?.avgEntry ??
          0;
        this.lastPositionContracts.set(snap.productKey, next);
        if (avg > 0) {
          this.lastOpenMeta.set(snap.productKey, {
            symbol: snap.symbol,
            side: snap.side,
            contracts: next,
            avgEntry: avg,
          });
        }
      }
      return;
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer != null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.tearDownSocket();
  }
}

/**
 * WebSocket-driven copy engine: one private socket per strategy with master API credentials.
 * Periodically re-syncs which strategies need sockets (new subscriptions / key updates).
 */
export function startTradeEngine(prisma: PrismaClient): () => void {
  const cancelled = { value: false };
  const sockets = new Map<string, StrategyMasterSocket>();
  let rosterTimeout: ReturnType<typeof setTimeout> | null = null;

  async function syncRoster(): Promise<void> {
    if (cancelled.value) return;
    try {
      const strategies = await prisma.strategy.findMany({
        where: {
          subscriptions: { some: { status: SubscriptionStatus.ACTIVE } },
        },
        select: { id: true, masterApiKey: true, masterApiSecret: true },
      });

      const want = new Set<string>();
      for (const s of strategies) {
        if (
          s.masterApiKey?.trim() &&
          s.masterApiSecret?.trim()
        ) {
          want.add(s.id);
        }
      }

      for (const id of sockets.keys()) {
        if (!want.has(id)) {
          sockets.get(id)?.destroy();
          sockets.delete(id);
        }
      }

      for (const id of want) {
        if (!sockets.has(id)) {
          const conn = new StrategyMasterSocket(prisma, id);
          sockets.set(id, conn);
          conn.start();
        }
      }
    } catch (err) {
      console.error("[tradeEngine] roster sync failed:", err);
    }
  }

  function scheduleRoster(): void {
    rosterTimeout = setTimeout(() => {
      void syncRoster().finally(() => {
        if (!cancelled.value) scheduleRoster();
      });
    }, ROSTER_SYNC_MS);
  }

  void syncRoster().finally(() => {
    if (!cancelled.value) scheduleRoster();
  });

  return () => {
    cancelled.value = true;
    if (rosterTimeout != null) {
      clearTimeout(rosterTimeout);
      rosterTimeout = null;
    }
    for (const s of sockets.values()) {
      s.destroy();
    }
    sockets.clear();
  };
}
