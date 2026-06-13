import { createHmac, createHash } from "node:crypto";
import WebSocket from "ws";
import { type PrismaClient, TradeStatus } from "@prisma/client";
import {
  extractDeltaProductSymbolFromPayload,
  fetchDeltaOpenPositions,
  fetchDeltaTicker,
  isDeltaOptionProductId,
  isValidDeltaOptionProductSymbol,
  normalizeDeltaPerpSymbolForCcxt,
  resolveCanonicalDeltaProductId,
  tradeSideFromSignedSize,
  type DeltaLivePosition,
  type TradeSide,
} from "./exchangeService.js";
import { decryptDeltaSecretOrPlain } from "../utils/encryption.js";
import { recordTradePnl } from "../controllers/subscriptionController.js";
import {
  EXIT_REASON,
  consumeBotInitiatedCloseReason,
  resolveCloseExitReason,
  resolveClosureOrigin,
  type ExitReasonValue,
} from "../constants/exitReasons.js";
import { isHardExecutionError } from "./followerTradeExecution.js";
import {
  settleOpenCopyTradesForLeg,
} from "./tradeSettlementService.js";
import {
  STRATEGY_SELECT_IS_ACTIVE,
  STRATEGY_SELECT_LATE_JOIN,
  STRATEGY_SELECT_SLIPPAGE,
  STRATEGY_SELECT_WS_CREDS,
  STRATEGY_WHERE_COPY_ENABLED,
} from "../prisma/strategySelect.js";
import { notifyTradeExecuted } from "./telegramService.js";
import { logUserActivity } from "./userActivityService.js";
import { runAllStrategyAutoExitChecks } from "./autoExitService.js";
import {
  assertStrategyActiveForCopy,
  executeFollowerTradeWithVerification,
  followerBotOpenDeficitLots,
  followerEligibleForMasterLegCopy,
  isMasterLegFreshForRestCatchup,
  masterLegRestPreExistingUnknown,
  parseMasterLegOpenedAt,
  syncMasterCloseToFutureHedgeFollowers,
  reconcileFollowersToEmptyMasterBook,
  syncMasterOpenFillToFutureHedgeFollowers,
} from "./followerTradeExecution.js";
import {
  findActiveCopySubscriptionForUser,
  findActiveCopySubscribersForStrategy,
  findActiveFutureHedgeCopySubscribers,
  findCopySubscriptionForUser,
  followerLotsFromMaster,
  resolveFutureHedgeStrategyId,
  STRATEGY_WHERE_HAS_ACTIVE_COPY_SUBSCRIBERS,
  subscriptionMultiplier,
} from "./strategySubscriptionService.js";
import { FUTURE_HEDGE_STRATEGY_TITLE } from "../constants/strategyTitles.js";
import {
  markSubscriptionSyncFailed,
  markSubscriptionSyncPending,
  markSubscriptionSynced,
} from "./subscriptionSyncService.js";
import {
  registerSymbolsForLivePrices,
  startLivePriceTracker,
} from "./livePriceTracker.js";
import {
  shouldSkipMasterFillCopy,
  shouldSuppressMasterRestCopy,
} from "./masterNoCopyOrders.js";
import { MasterFillDedup } from "./masterFillDedup.js";
import {
  buildClientOrderId,
  buildStableCopyClientOrderId,
  closeTradePositionsForLeg,
  listOpenFollowerBotLegs,
  recordTradePositionOpen,
  tradePositionSymbolsAlign,
} from "./tradePositionService.js";

/** Re-exported live mark cache (updated by {@link startLivePriceTracker} + public WS). */
export { liveMarkPrices } from "./liveMarkPriceCache.js";

async function isStrategyCopyEnabled(
  prisma: PrismaClient,
  strategyId: string,
): Promise<boolean> {
  const row = await prisma.strategy.findUnique({
    where: { id: strategyId },
    select: STRATEGY_SELECT_IS_ACTIVE,
  });
  return row?.isActive !== false;
}

/** Delta Exchange India private WebSocket (see Delta WebSocket docs). */
const DELTA_INDIA_PRIVATE_WS = "wss://socket.india.delta.exchange";

const WS_AUTH_PATH = "/live";
const HEARTBEAT_WATCHDOG_MS = 35_000;
const MIN_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 60_000;
/** How often to (re)attach private WS for strategies with active subs + master keys. */
const ROSTER_SYNC_MS = 8_000;
/** How often to reconcile DB OPEN trades against master REST positions (safety net). */
const SAFETY_RECONCILE_MS = 30_000;
/** Poll master total unrealized PnL vs strategy auto-exit thresholds. */
const AUTO_EXIT_CHECK_MS = 1_000;
/** Align follower contract counts with master × multiplier (REST safety net). */
const POSITION_QTY_RECONCILE_MS = 60_000;
/** REST reconciliation interval — live copy is WS-driven (orders / user_trades). */
const MASTER_REST_POLL_MS = 30_000;
/** Require a leg to be absent from REST for this long before closing followers (WS/REST lag). */
const MASTER_FLAT_CONFIRM_MS = 4_000;
/** Debounce immediate REST poll triggered by WS position deltas. */
const MASTER_REST_IMMEDIATE_DEBOUNCE_MS = 350;
/** Do not re-trigger REST force-copy for the same master leg within this window. */
const REST_FORCE_COPY_COOLDOWN_MS = 20_000;

const restForceCopyLastAttempt = new Map<string, number>();

function restForceCopyCooldownKey(
  strategyId: string,
  symbol: string,
  side: TradeSide,
): string {
  return `${strategyId}|${symbol}|${side}`;
}

function restForceCopyOnCooldown(
  strategyId: string,
  symbol: string,
  side: TradeSide,
): boolean {
  const key = restForceCopyCooldownKey(strategyId, symbol, side);
  const last = restForceCopyLastAttempt.get(key) ?? 0;
  return Date.now() - last < REST_FORCE_COPY_COOLDOWN_MS;
}

function markRestForceCopyAttempt(
  strategyId: string,
  symbol: string,
  side: TradeSide,
): void {
  restForceCopyLastAttempt.set(
    restForceCopyCooldownKey(strategyId, symbol, side),
    Date.now(),
  );
}

let masterRestPollDebounce: ReturnType<typeof setTimeout> | null = null;
let masterRestPollContext: {
  prisma: PrismaClient;
  tracker: MasterPositionTracker;
  cancelled: { value: boolean };
} | null = null;

function requestImmediateMasterRestPoll(reason: string): void {
  const ctx = masterRestPollContext;
  if (!ctx || ctx.cancelled.value) return;

  if (masterRestPollDebounce != null) {
    clearTimeout(masterRestPollDebounce);
  }

  masterRestPollDebounce = setTimeout(() => {
    masterRestPollDebounce = null;
    const active = masterRestPollContext;
    if (!active || active.cancelled.value) return;
    console.log(`[MASTER-REST-SYNC] immediate poll (${reason})`);
    scheduleMasterRestPoll(active.prisma, active.tracker, active.cancelled);
  }, MASTER_REST_IMMEDIATE_DEBOUNCE_MS);
}

function wsAuthSignature(secretPlain: string, timestampSec: string): string {
  const prehash = `GET${timestampSec}${WS_AUTH_PATH}`;
  return createHmac("sha256", secretPlain).update(prehash).digest("hex");
}

function percentSlippage(entry: number, market: number): number {
  if (entry <= 0) return Number.POSITIVE_INFINITY;
  return (Math.abs(market - entry) / entry) * 100;
}

/**
 * Whether copy execution should be blocked by slippage. Options are exempt: premiums
 * move in large % vs bid/ask, which false-triggers perp-style thresholds.
 */
function slippageBlocksCopy(
  symbol: string,
  entry: number,
  market: number,
  strategySlippagePct: number,
): boolean {
  if (isDeltaOptionProductId(symbol)) return false;
  return percentSlippage(entry, market) > strategySlippagePct;
}

/** Delta India CCXT market orders use contract/lot count; enforce integer follower size. */
function followerContractsFromMaster(
  masterContracts: number,
  multiplier: number,
): number {
  return followerLotsFromMaster(masterContracts, { multiplier });
}

/** True when Delta private WS auth succeeded (API key handshake variants). */
function isDeltaPrivateWsAuthSuccess(msg: Record<string, unknown>): boolean {
  const type = String(msg.type ?? "").toLowerCase();
  if (type === "key-auth" || type === "key_auth") {
    return (
      msg.success === true ||
      String(msg.message ?? "").toLowerCase().includes("success")
    );
  }
  if (type === "success" || type === "authenticated" || type === "auth") {
    const m = String(msg.message ?? "").toLowerCase();
    return (
      m.includes("authenticated") ||
      m.includes("success") ||
      msg.success === true
    );
  }
  return false;
}

function classifyMasterWsEvent(msg: Record<string, unknown>): string {
  const type = String(msg.type ?? "").toLowerCase();
  if (type === "orders" || type === "order") return "orders";
  if (type === "positions" || type === "position") return "positions";
  if (
    type === "user_trades" ||
    type === "user_trade" ||
    type === "fills" ||
    type === "fill"
  ) {
    return "fills";
  }
  return type;
}

function masterWsSubscribePayload(): {
  type: string;
  payload: { channels: Array<{ name: string; symbols: string[] }> };
} {
  return {
    type: "subscribe",
    payload: {
      channels: [
        { name: "orders", symbols: ["all"] },
        { name: "positions", symbols: ["all"] },
        { name: "user_trades", symbols: ["all"] },
      ],
    },
  };
}

async function triggerMasterOpenCopy(
  prisma: PrismaClient,
  strategyId: string,
  args: {
    symbol: string;
    side: TradeSide;
    masterContracts: number;
    avgPrice: number | null;
    masterFillKey: string;
    source: "orders" | "positions" | "fills" | "rest";
    forceRestSync?: boolean;
    adminForceSync?: boolean;
    masterOpenedAt?: Date | null;
    locallyFirstSeenAt?: Date | null;
    restPreExistingUnknown?: boolean;
    skipFollowerCopy?: boolean;
    /** When true, do not bump session tracker (deduped duplicate WS event). */
    skipTrackerUpdate?: boolean;
  },
  tracker?: MasterPositionTracker,
): Promise<void> {
  if (args.masterContracts <= 0) return;

  const isLiveMasterFill = args.source !== "rest";

  const canonicalSymbol = await canonicalizeCopySymbol(args.symbol, {
    liveFast: isLiveMasterFill,
  });
  if (!canonicalSymbol) {
    return;
  }
  if (canonicalSymbol !== args.symbol.trim()) {
    args = { ...args, symbol: canonicalSymbol };
  }
  const logTag = args.source === "rest" ? "[MASTER-REST-SYNC]" : "[MASTER-WS]";
  const skipCopy = args.skipFollowerCopy === true;

  if (skipCopy) {
    console.log(
      `${logTag} Master fill (no-copy) ${args.symbol} ${args.side} qty=${args.masterContracts} — skipping follower fan-out`,
    );
  } else {
    console.log(
      `${logTag} Detected fill on master (API or UI), triggering follower copy for symbol: ${args.symbol} ` +
        `(source=${args.source} side=${args.side} qty=${args.masterContracts})`,
    );
  }

  const entryPrice = await resolveMasterCopyEntryPrice(
    args.symbol,
    args.avgPrice,
  );
  if (entryPrice == null) {
    console.warn(
      `${logTag} skip ${skipCopy ? "tracker" : "copy"} ${args.symbol} — could not resolve entry/mark price`,
    );
    if (!skipCopy) return;
  }

  const futureHedgeId = await resolveFutureHedgeStrategyId(prisma);
  if (!skipCopy) {
    console.log(
      `${logTag} Future Hedge strategyId=${futureHedgeId ?? "none"} socketStrategyId=${strategyId}`,
    );
  }

  const forceRestSync =
    !skipCopy && (args.forceRestSync === true || args.source === "rest");

  if (forceRestSync) {
    console.log(
      "[FORCE-SYNC] Forcing market open order synchronization for followers on symbol:",
      args.symbol,
    );
  }

  if (!skipCopy && entryPrice != null) {
    await copyMasterFillToSubscribers(prisma, strategyId, {
    symbol: args.symbol,
    side: args.side,
    masterContracts: args.masterContracts,
    avgPrice: entryPrice,
    masterFillKey: args.masterFillKey,
    ...(forceRestSync ? { forceRestSync: true } : {}),
    ...(args.adminForceSync ? { adminForceSync: true } : {}),
    ...(isLiveMasterFill ? { liveMasterFill: true } : {}),
    ...(args.masterOpenedAt !== undefined
      ? { masterOpenedAt: args.masterOpenedAt }
      : {}),
    ...(args.locallyFirstSeenAt !== undefined
      ? { locallyFirstSeenAt: args.locallyFirstSeenAt }
      : {}),
    ...(args.restPreExistingUnknown
      ? { restPreExistingUnknown: true }
      : {}),
    });
  }

  if (
    tracker &&
    entryPrice != null &&
    args.skipTrackerUpdate !== true
  ) {
    if (isLiveMasterFill) {
      const isNewLeg = tracker.isNewLegThisSession(args.symbol, args.side);
      tracker.noteLegObserved(args.symbol, args.side, null, isNewLeg);
    }
    const prev = tracker.maxContractsForSymbolSide(args.symbol, args.side);
    tracker.applyMasterLeg({
      symbol: args.symbol,
      side: args.side,
      contracts: prev + args.masterContracts,
      avgEntry: entryPrice,
    });
  }
}

/** True when at least one eligible follower is under-allocated vs master × multiplier. */
async function followersMissingOpenLeg(
  prisma: PrismaClient,
  strategyId: string,
  symbol: string,
  side: TradeSide,
  masterLots: number,
  masterOpenedAt: Date | null,
  locallyFirstSeenAt: Date | null,
  restPreExistingUnknown: boolean,
): Promise<boolean> {
  const subscribers = await findActiveFutureHedgeCopySubscribers(prisma);
  if (subscribers.length === 0) return false;

  const openSide = side === "BUY" ? "BUY" : "SELL";

  for (const sub of subscribers) {
    if (
      !followerEligibleForMasterLegCopy({
        joinedDate: sub.joinedDate,
        masterOpenedAt,
        locallyFirstSeenAt,
        restPreExistingUnknown,
      })
    ) {
      continue;
    }

    const expectedLots = followerLotsFromMaster(masterLots, sub);
    const creds = resolveSubscriptionCreds(sub);
    const deficitLots = await followerBotOpenDeficitLots(prisma, {
      strategyId,
      userId: sub.userId,
      symbol,
      side: openSide,
      targetLots: expectedLots,
      ...(creds
        ? { apiKey: creds.apiKey, apiSecret: creds.apiSecret }
        : {}),
    });
    if (deficitLots > 0) {
      console.log(
        `[MASTER-REST-SYNC] follower user=${sub.userId} needs +${deficitLots} lots on ${symbol} ${openSide} ` +
          `(target=${expectedLots} masterLots=${masterLots})`,
      );
      return true;
    }
  }
  return false;
}

function scheduleMasterRestPoll(
  prisma: PrismaClient,
  tracker: MasterPositionTracker,
  cancelled: { value: boolean },
): void {
  void pollMasterPositionsFallback(prisma, tracker, cancelled).catch((err) => {
    console.error(
      "[MASTER-REST-SYNC] initial poll unhandled rejection:",
      err instanceof Error ? err.message : err,
    );
  });
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

function symbolAliasSet(raw: string): Set<string> {
  const u = raw.trim().toUpperCase();
  const out = new Set<string>();
  if (!u) return out;
  out.add(u);
  // Delta options (C-… / P-…) use product ids as-is — no USDT/USD alias pairs.
  if (u.startsWith("C-") || u.startsWith("P-")) return out;
  if (u.endsWith("USDT")) out.add(`${u.slice(0, -4)}USD`);
  if (u.endsWith("USD") && !u.endsWith("USDT")) out.add(`${u.slice(0, -3)}USDT`);
  return out;
}

function compactSymbolKey(s: string): string {
  return s.replace(/[/:]/g, "").toUpperCase();
}

function deltaPairBase(compactNoSlash: string): string | null {
  const u = compactNoSlash.toUpperCase();
  if (u.endsWith("USDT")) return u.slice(0, -4);
  if (u.endsWith("USD") && !u.endsWith("USDT")) return u.slice(0, -3);
  return null;
}

function positionSymbolsAlign(tradeSymbol: string, positionKey: string): boolean {
  const a = tradeSymbol.trim();
  const b = positionKey.trim();
  if (isDeltaOptionProductId(a) || isDeltaOptionProductId(b)) {
    return a.toUpperCase() === b.toUpperCase();
  }
  const ca = compactSymbolKey(a);
  const cb = compactSymbolKey(b);
  if (ca === cb || ca.endsWith(cb) || cb.endsWith(ca)) return true;
  const ba = deltaPairBase(ca);
  const bb = deltaPairBase(cb);
  return ba != null && bb != null && ba === bb;
}

function findFollowerLeg(
  positions: DeltaLivePosition[],
  masterSymbol: string,
  side: TradeSide,
): DeltaLivePosition | undefined {
  return positions.find(
    (p) => positionSymbolsAlign(masterSymbol, p.symbolKey) && p.side === side,
  );
}

type SubscriberCreds = { apiKey: string; apiSecret: string };

function resolveSubscriptionCreds(sub: {
  exchangeAccount: { apiKey: string; apiSecret: string } | null;
  user: {
    exchangeAccounts: { apiKey: string; apiSecret: string }[];
    deltaApiKeys: { apiKey: string; apiSecret: string }[];
  };
}): SubscriberCreds | null {
  if (sub.exchangeAccount != null) {
    return {
      apiKey: sub.exchangeAccount.apiKey,
      apiSecret: sub.exchangeAccount.apiSecret,
    };
  }
  if (sub.user.exchangeAccounts[0] != null) {
    return {
      apiKey: sub.user.exchangeAccounts[0]!.apiKey,
      apiSecret: sub.user.exchangeAccounts[0]!.apiSecret,
    };
  }
  if (sub.user.deltaApiKeys[0] != null) {
    return {
      apiKey: sub.user.deltaApiKeys[0]!.apiKey,
      apiSecret: sub.user.deltaApiKeys[0]!.apiSecret,
    };
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
  for (const layerKey of ["payload", "data"]) {
    const inner = asRecord(base[layerKey]);
    if (inner) {
      for (const [k, v] of Object.entries(inner)) {
        if (!(k in out)) out[k] = v;
      }
    }
  }
  return out;
}

/** Delta product id from WS / REST payloads (perps and options). */
function extractDeltaProductSymbol(o: Record<string, unknown>): string {
  return extractDeltaProductSymbolFromPayload(o);
}

async function canonicalizeCopySymbol(
  symbol: string,
  options?: { liveFast?: boolean },
): Promise<string | null> {
  const raw = symbol.trim();
  if (!raw) return null;

  if (
    options?.liveFast === true &&
    isValidDeltaOptionProductSymbol(raw)
  ) {
    return raw;
  }

  if (isDeltaOptionProductId(raw) || /^\d+$/.test(raw)) {
    const resolved = await resolveCanonicalDeltaProductId(raw);
    if (!resolved) {
      console.error(
        `[copy] refuse to copy — exact option product resolve failed for "${raw}"`,
      );
      return null;
    }
    if (!marketIdMatchesOption(raw, resolved.productId)) {
      console.warn(
        `[copy] option symbol canonicalized "${raw}" → "${resolved.productId}"`,
      );
    }
    return resolved.productId;
  }

  return raw;
}

function marketIdMatchesOption(a: string, b: string): boolean {
  return a.trim().toUpperCase() === b.trim().toUpperCase();
}

function orderStateIndicatesFill(state: string): boolean {
  const u = state.toLowerCase().trim();
  if (!u) return false;
  return (
    u.includes("fill") ||
    u === "closed" ||
    u === "completed" ||
    u === "done" ||
    u === "filled" ||
    u === "executed"
  );
}

/** Master copy entry — REST mark fallback when WS omits avg fill price (common on manual UI orders). */
async function resolveMasterCopyEntryPrice(
  symbol: string,
  avgFromPayload: number | null | undefined,
): Promise<number | null> {
  if (
    avgFromPayload != null &&
    Number.isFinite(avgFromPayload) &&
    avgFromPayload > 0
  ) {
    return avgFromPayload;
  }
  try {
    const tick = await fetchDeltaTicker(symbol);
    if (tick.last != null && Number.isFinite(tick.last) && tick.last > 0) {
      return tick.last;
    }
  } catch {
    /* fallback exhausted */
  }
  return null;
}

function buildMasterFillKey(parts: string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32);
}

function extractClientOrderIdFromPayload(raw: unknown): string {
  const o = mergePayloadLayers(raw);
  return String(o.client_order_id ?? o.clientOrderId ?? "").trim();
}

/**
 * Derives a copy signal from an `orders` channel message (schema varies by contract type).
 * Accepts manual UI / non-API orders — never filters on client_order_id format.
 */
function extractOrderFillSignal(
  raw: unknown,
): {
  symbol: string;
  side: TradeSide;
  contracts: number;
  exchangeCumulative: number;
  orderId: string;
  avgPrice: number | null;
  reduceOnly: boolean;
  clientOrderId: string;
  /** Stable key for follower dedup (master order id or fill fingerprint). */
  fillKey: string;
} | null {
  const o = mergePayloadLayers(raw);
  const state = String(o.state ?? o.order_state ?? o.status ?? "")
    .toLowerCase()
    .trim();

  const symbol = extractDeltaProductSymbol(o);
  if (!symbol) return null;

  const side = normalizeSide(o.side ?? o.order_side);
  if (!side) return null;

  const reduceOnly = Boolean(o.reduce_only ?? o.reduceOnly);

  const incrementalFill =
    num(o.fill_qty) ??
    num(o.last_fill_qty) ??
    num(o.trade_qty) ??
    num(o.exec_qty);
  const cumulativeFilled =
    num(o.filled_qty) ??
    num(o.filled_size) ??
    num(o.cum_fill_qty) ??
    num(o.cumulative_fill_qty);

  let contracts: number | null = null;
  if (incrementalFill != null && incrementalFill > 0) {
    contracts = incrementalFill;
  } else if (cumulativeFilled != null && cumulativeFilled > 0) {
    contracts = cumulativeFilled;
  } else if (orderStateIndicatesFill(state) || state === "closed") {
    contracts = num(o.size) ?? num(o.order_qty) ?? num(o.quantity);
  } else if (state === "open" || state === "pending") {
    const partial =
      num(o.filled_qty) ?? num(o.filled_size) ?? num(o.cum_fill_qty);
    if (partial != null && partial > 0) contracts = partial;
  }

  if (contracts == null || contracts <= 0) return null;

  const exchangeCumulative =
    cumulativeFilled != null && cumulativeFilled > 0
      ? cumulativeFilled
      : contracts;

  const avgPrice =
    num(o.average_fill_price) ??
    num(o.avg_fill_price) ??
    num(o.fill_avg_price) ??
    num(o.average_price) ??
    num(o.price) ??
    num(o.limit_price) ??
    num(o.mark_price);

  const orderIdRaw = o.id ?? o.order_id;
  const orderId =
    orderIdRaw != null ? String(orderIdRaw).trim() : "";
  const clientOrderId = String(
    o.client_order_id ?? o.clientOrderId ?? "",
  ).trim();
  const fillKey =
    orderId ||
    buildMasterFillKey([
      symbol,
      side,
      String(contracts),
      String(avgPrice ?? 0),
      state || "fill",
    ]);

  return {
    symbol,
    side,
    contracts,
    exchangeCumulative,
    orderId,
    avgPrice,
    reduceOnly,
    clientOrderId,
    fillKey,
  };
}

/** `user_trades` / fill stream — common for manual UI market orders. */
function extractUserTradeFillSignal(
  raw: unknown,
): {
  symbol: string;
  side: TradeSide;
  contracts: number;
  avgPrice: number | null;
  clientOrderId: string;
  tradeId: string;
  orderId: string;
  fillKey: string;
} | null {
  const o = mergePayloadLayers(raw);
  const symbol = extractDeltaProductSymbol(o);
  if (!symbol) return null;

  const side = normalizeSide(o.side ?? o.order_side ?? o.direction);
  if (!side) return null;

  const contracts =
    num(o.size) ??
    num(o.qty) ??
    num(o.quantity) ??
    num(o.fill_qty) ??
    num(o.trade_qty);
  if (contracts == null || contracts <= 0) return null;

  const avgPrice =
    num(o.price) ??
    num(o.fill_price) ??
    num(o.average_fill_price) ??
    num(o.avg_fill_price);

  const tradeIdRaw = o.id ?? o.trade_id ?? o.fill_id;
  const tradeId =
    tradeIdRaw != null ? String(tradeIdRaw).trim() : "";
  const orderIdRaw = o.order_id ?? o.orderId;
  const orderId =
    orderIdRaw != null ? String(orderIdRaw).trim() : "";
  const clientOrderId = String(
    o.client_order_id ?? o.clientOrderId ?? "",
  ).trim();
  const fillKey = tradeId
    ? `trade:${tradeId}`
    : buildMasterFillKey([
        "user_trade",
        symbol,
        side,
        String(contracts),
        String(avgPrice ?? 0),
      ]);

  return {
    symbol,
    side,
    contracts,
    avgPrice,
    clientOrderId,
    tradeId,
    orderId,
    fillKey,
  };
}

async function processMasterOrderFillRecords(
  prisma: PrismaClient,
  strategyId: string,
  records: unknown[],
  tracker?: MasterPositionTracker,
): Promise<void> {
  const dedup = tracker?.copyDedup;
  await Promise.all(
    records.map(async (r) => {
      const sig = extractOrderFillSignal(r);
      if (!sig) return;
      const clientOrderId =
        sig.clientOrderId || extractClientOrderIdFromPayload(r);
      if (sig.reduceOnly) {
        if (shouldSkipMasterFillCopy({ clientOrderId })) {
          console.log(
            `[MASTER-WS] NC_ reduce-only fill ignored for copy ${sig.symbol} clientOrderId=${clientOrderId}`,
          );
        }
        return;
      }
      registerSymbolsForLivePrices([sig.symbol]);
      const ncSkip = shouldSkipMasterFillCopy({ clientOrderId });

      const orderId = sig.orderId || null;
      const copyPlan =
        !ncSkip && dedup
          ? dedup.resolveOrdersChannelCopy({
              orderId,
              exchangeCumulative: sig.exchangeCumulative,
              fallbackIncrement: sig.contracts,
            })
          : ncSkip
            ? null
            : {
                qty: sig.contracts,
                masterFillKey: sig.fillKey,
              };

      const fanOut = !ncSkip && copyPlan != null;
      if (!fanOut && dedup && orderId) {
        console.log(
          `[MASTER-WS] orders dedup skip copy ${sig.symbol} orderId=${orderId} ` +
            `(fills-first or delta=0 cumulative=${sig.exchangeCumulative})`,
        );
      }

      const copyTask = triggerMasterOpenCopy(
        prisma,
        strategyId,
        {
          symbol: sig.symbol,
          side: sig.side,
          masterContracts: fanOut ? copyPlan!.qty : sig.contracts,
          avgPrice: sig.avgPrice,
          masterFillKey: fanOut ? copyPlan!.masterFillKey : sig.fillKey,
          source: "orders",
          skipFollowerCopy: ncSkip || !fanOut,
          skipTrackerUpdate: !fanOut,
        },
        tracker,
      );

      if (fanOut) {
        void copyTask.catch((err) => {
          console.error(
            `[MASTER-WS] orders fan-out failed ${sig.symbol}:`,
            err instanceof Error ? err.message : err,
          );
        });
      } else {
        await copyTask;
      }

      if (fanOut && copyPlan && dedup) {
        dedup.recordOrdersChannelCopy({
          orderId,
          qty: copyPlan.qty,
          exchangeCumulative: sig.exchangeCumulative,
        });
      }
    }),
  );
}

async function processMasterUserTradeFillRecords(
  prisma: PrismaClient,
  strategyId: string,
  records: unknown[],
  tracker?: MasterPositionTracker,
): Promise<void> {
  const dedup = tracker?.copyDedup;
  await Promise.all(
    records.map(async (r) => {
      const sig = extractUserTradeFillSignal(r);
      if (!sig) return;
      const clientOrderId =
        sig.clientOrderId || extractClientOrderIdFromPayload(r);
      registerSymbolsForLivePrices([sig.symbol]);
      const ncSkip = shouldSkipMasterFillCopy({ clientOrderId });

      const orderId = sig.orderId || null;
      const tradeId = sig.tradeId || sig.fillKey;
      const dedupSkip =
        !ncSkip &&
        dedup != null &&
        dedup.shouldSkipFillsChannelCopy({ tradeId, orderId });

      if (dedupSkip) {
        console.log(
          `[MASTER-WS] fills dedup skip copy ${sig.symbol} tradeId=${tradeId} orderId=${orderId ?? "none"} ` +
            `(orders-first or duplicate trade)`,
        );
      }

      const fanOut = !ncSkip && !dedupSkip;
      const copyTask = triggerMasterOpenCopy(
        prisma,
        strategyId,
        {
          symbol: sig.symbol,
          side: sig.side,
          masterContracts: sig.contracts,
          avgPrice: sig.avgPrice,
          masterFillKey: sig.fillKey,
          source: "fills",
          skipFollowerCopy: ncSkip || !fanOut,
          skipTrackerUpdate: !fanOut,
        },
        tracker,
      );

      if (fanOut) {
        void copyTask.catch((err) => {
          console.error(
            `[MASTER-WS] user_trades fan-out failed ${sig.symbol}:`,
            err instanceof Error ? err.message : err,
          );
        });
      } else {
        await copyTask;
      }

      if (fanOut && dedup) {
        dedup.recordFillsChannelCopy({
          tradeId,
          orderId,
          qty: sig.contracts,
        });
      }
    }),
  );
}

/** Collect row objects from Delta WS channel payloads (orders, fills, etc.). */
function collectWsChannelRecords(
  msg: Record<string, unknown>,
  fallback: unknown,
): unknown[] {
  const records: unknown[] = [];
  if (Array.isArray(msg.data)) {
    records.push(...msg.data);
  }
  const data = asRecord(msg.data);
  if (data) {
    for (const key of [
      "open",
      "closed",
      "orders",
      "order",
      "trades",
      "user_trades",
      "fills",
    ]) {
      const arr = data[key];
      if (Array.isArray(arr)) records.push(...arr);
    }
    if (records.length === 0) records.push(msg.data);
  }
  const payload = asRecord(msg.payload);
  if (records.length === 0 && payload) {
    records.push(payload);
  }
  if (records.length === 0) records.push(fallback);
  return records;
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
  const symbol = extractDeltaProductSymbol(o);
  const productKey = String(o.product_id ?? symbol).trim();
  if (!symbol && !productKey) return null;

  const rawSize =
    num(o.size) ?? num(o.position_size) ?? num(o.contracts) ?? null;
  const contracts =
    rawSize !== null && Number.isFinite(rawSize) ? Math.abs(rawSize) : 0;

  // Signed raw size is authoritative on Delta India (+ = BUY/long, − = SELL/short).
  let side: TradeSide;
  if (rawSize !== null && Number.isFinite(rawSize) && rawSize !== 0) {
    side = tradeSideFromSignedSize(rawSize);
  } else {
    side = normalizeSide(o.side ?? o.position_side ?? o.direction) ?? "BUY";
  }

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
    tradingFee?: number;
    exitReason?: ExitReasonValue | null;
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
      ...(args.tradingFee != null ? { tradingFee: args.tradingFee } : {}),
      ...(args.exitReason ? { exitReason: args.exitReason } : {}),
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
    exitFee: number;
    exitReason?: ExitReasonValue | null;
  },
): Promise<void> {
  await settleOpenCopyTradesForLeg(prisma, {
    userId: args.userId,
    strategyId: args.strategyId,
    symbol: args.symbol,
    side: args.side,
    exitPrice: args.exitPrice,
    exitFee: args.exitFee,
    exitReason: args.exitReason,
    masterEntryPrice: args.masterEntryPrice,
    closeAllMatching: true,
  });
}

/** Closes every OPEN DB leg for a user/strategy/symbol/side after an admin manual close. */
export async function closeOpenTradesForManualAdmin(
  prisma: PrismaClient,
  args: {
    userId: string;
    strategyId: string;
    symbol: string;
    side: TradeSide;
    exitPrice: number;
    exitFee: number;
  },
): Promise<number> {
  return settleOpenCopyTradesForLeg(prisma, {
    userId: args.userId,
    strategyId: args.strategyId,
    symbol: args.symbol,
    side: args.side,
    exitPrice: args.exitPrice,
    exitFee: args.exitFee,
    exitReason: EXIT_REASON.ADMIN_PANEL,
    closeAllMatching: true,
  });
}

function failedReasonFromExecutionError(error?: string): ExitReasonValue {
  if (error && isHardExecutionError(error)) {
    return EXIT_REASON.INSUFFICIENT_MARGIN;
  }
  return EXIT_REASON.EXECUTION_FAILED;
}

/** Leader snapshot for late-join REST sync — sizes are **contracts (lots)**, not base currency. */
export type MasterLedTrade = {
  id: string;
  deltaSymbol: string;
  side: TradeSide;
  entryPrice: number;
  masterContracts: number;
  /** Master leg open time from Delta margined REST (`created_at` / entryTime). */
  openedAt: Date | null;
};

function masterLegOpenOnRest(
  meta: { symbol: string; side: TradeSide },
  masters: MasterLedTrade[],
): boolean {
  return masters.some(
    (m) =>
      m.masterContracts > 0 &&
      m.side === meta.side &&
      positionSymbolsAlign(meta.symbol, m.deltaSymbol),
  );
}

function deltaPositionsToMasterLed(
  positions: DeltaLivePosition[],
): MasterLedTrade[] {
  const out: MasterLedTrade[] = [];
  for (const p of positions) {
    const masterContracts = Math.abs(p.contracts);
    if (!Number.isFinite(masterContracts) || masterContracts < 1e-12) continue;
    const entry =
      p.entryPrice != null && Number.isFinite(p.entryPrice)
        ? p.entryPrice
        : p.markPrice != null && Number.isFinite(p.markPrice)
          ? p.markPrice
          : 0;
    // Side comes from signed raw REST size via fetchDeltaOpenPositions — replicate verbatim.
    const side: TradeSide = p.side === "SELL" ? "SELL" : "BUY";
    out.push({
      id: `${p.symbolKey}:${side}`,
      deltaSymbol: p.symbolKey,
      side,
      entryPrice: entry,
      masterContracts,
      openedAt: parseMasterLegOpenedAt(p.entryTime),
    });
  }
  return out;
}

/** Leader opens via Delta REST margined + realtime overlay (Delta India master keys). */
export async function fetchMasterOpenPositions(
  apiKey: string,
  apiSecret: string,
  options?: { skipCache?: boolean },
): Promise<MasterLedTrade[]> {
  // Debug: confirm the master key decrypted from the database matches the
  // value pasted into the admin panel. If the masked prefix does NOT match
  // the real key, the row in `Strategy.masterApiKey` is stale, encrypted
  // with a different `PROCESS_ENCRYPTION_KEY`, or the admin panel write
  // never landed.
  const decryptedKey = decryptDeltaSecretOrPlain(apiKey);
  const maskedKey =
    decryptedKey.length > 5
      ? decryptedKey.substring(0, 5) + "***"
      : "INVALID_LENGTH";
  console.log(
    `[DEBUG_AUTH] fetchMasterOpenPositions decrypted master key starts with: ${maskedKey}`,
  );

  const raw = await fetchDeltaOpenPositions(apiKey, apiSecret, {
    lite: true,
    skipCache: options?.skipCache === true,
  });
  return deltaPositionsToMasterLed(raw);
}

export async function lateJoinMirrorOpenPositionsForSubscriber(
  prisma: PrismaClient,
  args: { strategyId: string; userId: string; force?: boolean },
): Promise<void> {
  const strategy = await prisma.strategy.findUnique({
    where: { id: args.strategyId },
    select: STRATEGY_SELECT_LATE_JOIN,
  });
  if (!strategy) return;
  if (!strategy.isActive) return;
  if (!args.force && !strategy.syncActiveTrades) return;

  const sub = await findActiveCopySubscriptionForUser(prisma, {
    strategyId: args.strategyId,
    userId: args.userId,
  });
  if (!sub) {
    return;
  }

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
    if (
      !args.force &&
      !followerEligibleForMasterLegCopy({
        joinedDate: sub.joinedDate,
        masterOpenedAt: leader.openedAt,
        restPreExistingUnknown: !leader.openedAt,
      })
    ) {
      console.log(
        `[late-join] skip user=${args.userId} ${leader.deltaSymbol} ${leader.side} — ` +
          `master leg predates subscription`,
      );
      continue;
    }

    const tickLj = await fetchDeltaTicker(leader.deltaSymbol);
    const marketPrice =
      tickLj.last != null && Number.isFinite(tickLj.last)
        ? tickLj.last
        : undefined;

    const followerContracts = followerContractsFromMaster(
      leader.masterContracts,
      subscriptionMultiplier(sub),
    );

    if (
      marketPrice !== undefined &&
      slippageBlocksCopy(
        leader.deltaSymbol,
        leader.entryPrice,
        marketPrice,
        strategy.slippage,
      )
    ) {
      console.log(
        `[EXECUTION] Late-join skip (slippage) user ${sub.userId} — ${leader.deltaSymbol} ${leader.side} — would place ${followerContracts} contracts`,
      );
      await recordTrade(prisma, {
        userId: sub.userId,
        strategyId: strategy.id,
        symbol: leader.deltaSymbol,
        side: leader.side,
        size: followerContracts,
        entryPrice: leader.entryPrice,
        status: TradeStatus.FAILED,
        exitReason: EXIT_REASON.SLIPPAGE_EXCEEDED,
      });
      continue;
    }

    const creds =
      sub.exchangeAccount != null
        ? {
            apiKey: sub.exchangeAccount.apiKey,
            apiSecret: sub.exchangeAccount.apiSecret,
          }
        : sub.user.exchangeAccounts?.[0] != null
          ? {
              apiKey: sub.user.exchangeAccounts[0]!.apiKey,
              apiSecret: sub.user.exchangeAccounts[0]!.apiSecret,
            }
          : sub.user.deltaApiKeys[0] != null
            ? {
                apiKey: sub.user.deltaApiKeys[0]!.apiKey,
                apiSecret: sub.user.deltaApiKeys[0]!.apiSecret,
              }
            : null;

    if (!creds) {
      console.log(
        `[EXECUTION] Late-join skip (no follower creds) user ${sub.userId} — ${leader.deltaSymbol} — ${followerContracts} contracts`,
      );
      await recordTrade(prisma, {
        userId: sub.userId,
        strategyId: strategy.id,
        symbol: leader.deltaSymbol,
        side: leader.side,
        size: followerContracts,
        entryPrice: leader.entryPrice,
        status: TradeStatus.FAILED,
        exitReason: EXIT_REASON.NO_API_CREDENTIALS,
      });
      continue;
    }

    console.log(
      `[EXECUTION] Placing order for user ${sub.userId} — Size: ${followerContracts} contracts (master ${leader.masterContracts} × ${subscriptionMultiplier(sub)}) — ${leader.deltaSymbol} ${leader.side}`,
    );

    const result = await executeFollowerTradeWithVerification(prisma, {
      strategyId: strategy.id,
      userId: sub.userId,
      apiKey: creds.apiKey,
      apiSecret: creds.apiSecret,
      symbol: leader.deltaSymbol,
      side: leader.side,
      size: followerContracts,
    });

    if (!result.success) {
      const ccxtSym = normalizeDeltaPerpSymbolForCcxt(leader.deltaSymbol);
      console.error(
        `[late-join] follower execution failed userId=${sub.userId} strategyId=${strategy.id} deltaSymbol=${leader.deltaSymbol} ccxtSymbol=${ccxtSym} side=${leader.side} contracts=${followerContracts} attempts=${result.attempts}: ${result.error ?? "unknown"}`,
      );
    }

    await recordTrade(prisma, {
      userId: sub.userId,
      strategyId: strategy.id,
      symbol: leader.deltaSymbol,
      side: leader.side,
      size: followerContracts,
      entryPrice: leader.entryPrice,
      status: result.success && result.verified ? TradeStatus.OPEN : TradeStatus.FAILED,
      tradingFee: result.success ? (result.feeCost ?? 0) : 0,
      ...(!result.success || !result.verified
        ? {
            exitReason: failedReasonFromExecutionError(result.error),
          }
        : {}),
    });
  }
}

export async function lateJoinMirrorForAllActiveSubscribers(
  prisma: PrismaClient,
  strategyId: string,
): Promise<void> {
  const strategy = await prisma.strategy.findUnique({
    where: { id: strategyId },
    select: { syncActiveTrades: true, isActive: true },
  });
  if (!strategy?.isActive || !strategy.syncActiveTrades) return;

  const subs = await findActiveCopySubscribersForStrategy(prisma, strategyId);

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

/**
 * Admin: mirror the master’s open Delta positions for every ACTIVE subscriber at market,
 * even when `syncActiveTrades` is false. Uses the same `executeTrade` path as late-join.
 */
export async function forceMirrorOpenPositionsForAllSubscribers(
  prisma: PrismaClient,
  strategyId: string,
): Promise<{
  masterOpenLegs: number;
  activeSubscribers: number;
}> {
  const strategy = await prisma.strategy.findUnique({
    where: { id: strategyId },
    select: {
      masterApiKey: true,
      masterApiSecret: true,
      isActive: true,
    },
  });

  if (!strategy?.isActive) {
    throw new Error("Strategy is paused (isActive is false).");
  }

  const keyOk = Boolean(strategy?.masterApiKey?.trim());
  const secretOk = Boolean(strategy?.masterApiSecret?.trim());
  if (!strategy || !keyOk || !secretOk) {
    throw new Error(
      "Master Delta API key and secret must be set on this strategy.",
    );
  }

  let masterOpenLegs = 0;
  try {
    const legs = await fetchMasterOpenPositions(
      strategy.masterApiKey,
      strategy.masterApiSecret,
    );
    masterOpenLegs = legs.length;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to fetch master open positions: ${msg}`);
  }

  const subs = await findActiveCopySubscribersForStrategy(prisma, strategyId);

  for (const row of subs) {
    try {
      await lateJoinMirrorOpenPositionsForSubscriber(prisma, {
        strategyId,
        userId: row.userId,
        force: true,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[force-sync] strategyId=${strategyId} userId=${row.userId}:`,
        msg,
      );
    }
  }

  return {
    masterOpenLegs,
    activeSubscribers: subs.length,
  };
}

export type SyncFollowerUserResult = {
  ok: boolean;
  strategyId: string;
  userId: string;
  masterLegs: number;
  adjustmentsMade: number;
  syncStatus: string;
  syncError: string | null;
  error?: string;
};

/**
 * Admin: mirror one follower's Delta legs to the master's open book at market,
 * scaled by subscription multiplier. Resets sync state on full success.
 */
export async function syncFollowerUserToMasterPositions(
  prisma: PrismaClient,
  strategyId: string,
  userId: string,
): Promise<SyncFollowerUserResult> {
  const strategy = await prisma.strategy.findUnique({
    where: { id: strategyId },
    select: {
      id: true,
      masterApiKey: true,
      masterApiSecret: true,
    },
  });

  const keyOk = Boolean(strategy?.masterApiKey?.trim());
  const secretOk = Boolean(strategy?.masterApiSecret?.trim());
  if (!strategy || !keyOk || !secretOk) {
    throw new Error(
      "Master Delta API key and secret must be set on this strategy.",
    );
  }

  const sub = await findCopySubscriptionForUser(prisma, { strategyId, userId });
  if (!sub) {
    throw new Error("User is not subscribed to this strategy.");
  }
  if (!sub.isActive) {
    throw new Error("User copy subscription is inactive (isActive is false).");
  }

  const creds = resolveSubscriptionCreds(sub);
  if (!creds) {
    throw new Error("Follower has no Delta API credentials configured.");
  }

  let masterLegs: MasterLedTrade[];
  try {
    masterLegs = await fetchMasterOpenPositions(
      strategy.masterApiKey,
      strategy.masterApiSecret,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to fetch master open positions: ${msg}`);
  }

  await markSubscriptionSyncPending(prisma, { userId, strategyId });

  let followerPositions: DeltaLivePosition[];
  try {
    followerPositions = await fetchDeltaOpenPositions(
      creds.apiKey,
      creds.apiSecret,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await markSubscriptionSyncFailed(prisma, {
      userId,
      strategyId,
      error: `Failed to fetch follower positions: ${msg}`,
    });
    return {
      ok: false,
      strategyId,
      userId,
      masterLegs: masterLegs.length,
      adjustmentsMade: 0,
      syncStatus: "FAILED",
      syncError: msg,
      error: msg,
    };
  }

  let adjustmentsMade = 0;
  const errors: string[] = [];

  for (const master of masterLegs) {
    const expectedContracts = followerContractsFromMaster(
      master.masterContracts,
      subscriptionMultiplier(sub),
    );
    const leg = findFollowerLeg(
      followerPositions,
      master.deltaSymbol,
      master.side,
    );
    const actualContracts = leg
      ? Math.max(0, Math.floor(Math.abs(leg.contracts)))
      : 0;

    if (actualContracts === expectedContracts) continue;

    if (actualContracts < expectedContracts) {
      const diff = expectedContracts - actualContracts;
      console.log(
        `[manual-sync] user=${userId} ${master.deltaSymbol} catch-up +${diff} (${master.side})`,
      );
      const result = await executeFollowerTradeWithVerification(prisma, {
        strategyId,
        userId,
        apiKey: creds.apiKey,
        apiSecret: creds.apiSecret,
        symbol: master.deltaSymbol,
        side: master.side,
        size: diff,
        entryPrice: master.entryPrice,
      });
      if (!result.success || !result.verified) {
        errors.push(
          `${master.deltaSymbol} open: ${result.error ?? "execution failed"}`,
        );
        break;
      }
      adjustmentsMade += 1;
      continue;
    }

    const diff = actualContracts - expectedContracts;
    const trimSide: TradeSide = master.side === "BUY" ? "SELL" : "BUY";
    console.log(
      `[manual-sync] user=${userId} ${master.deltaSymbol} trim -${diff} (${trimSide})`,
    );
    const closeClientOrderId = buildClientOrderId({
      strategyId,
      userId,
      symbol: master.deltaSymbol,
    });
    const trimResult = await executeFollowerTradeWithVerification(prisma, {
      strategyId,
      userId,
      apiKey: creds.apiKey,
      apiSecret: creds.apiSecret,
      symbol: master.deltaSymbol,
      side: trimSide,
      size: diff,
      reduceOnly: true,
      clientOrderId: closeClientOrderId,
      adminForceSync: true,
    });
    if (!trimResult.success) {
      errors.push(
        `${master.deltaSymbol} trim: ${trimResult.error ?? "execution failed"}`,
      );
      break;
    }
    adjustmentsMade += 1;
  }

  if (errors.length > 0) {
    const errorMsg = errors.join("; ");
    await markSubscriptionSyncFailed(prisma, {
      userId,
      strategyId,
      error: errorMsg,
    });
    const row = await prisma.userStrategySubscription.findUnique({
      where: { userId_strategyId: { userId, strategyId } },
      select: { syncStatus: true, syncError: true },
    });
    return {
      ok: false,
      strategyId,
      userId,
      masterLegs: masterLegs.length,
      adjustmentsMade,
      syncStatus: row?.syncStatus ?? "FAILED",
      syncError: row?.syncError ?? errorMsg,
      error: errorMsg,
    };
  }

  await markSubscriptionSynced(prisma, { userId, strategyId });
  return {
    ok: true,
    strategyId,
    userId,
    masterLegs: masterLegs.length,
    adjustmentsMade,
    syncStatus: "SYNCED",
    syncError: null,
  };
}

async function copyMasterFillToSubscribers(
  prisma: PrismaClient,
  _strategyId: string,
  args: {
    symbol: string;
    side: TradeSide;
    masterContracts: number;
    avgPrice: number;
    masterFillKey: string;
    forceRestSync?: boolean;
    adminForceSync?: boolean;
    masterOpenedAt?: Date | null;
    locallyFirstSeenAt?: Date | null;
    liveMasterFill?: boolean;
    restPreExistingUnknown?: boolean;
  },
): Promise<void> {
  const futureHedgeId = await resolveFutureHedgeStrategyId(prisma);
  if (!futureHedgeId) {
    console.log(
      "[tradeEngine] No active Future Hedge strategy — skip master fill copy",
    );
    return;
  }

  if (!(await assertStrategyActiveForCopy(prisma, futureHedgeId))) {
    return;
  }

  console.log(
    `[copy] master fill → followers ${args.symbol} ${args.side} lots=${args.masterContracts} ` +
      `forceRestSync=${args.forceRestSync === true}`,
  );

  await syncMasterOpenFillToFutureHedgeFollowers(prisma, {
    symbol: args.symbol,
    side: args.side,
    masterLots: args.masterContracts,
    avgPrice: args.avgPrice,
    masterFillKey: args.masterFillKey,
    ...(args.forceRestSync ? { forceRestSync: true } : {}),
    ...(args.adminForceSync ? { adminForceSync: true } : {}),
    ...(args.liveMasterFill ? { liveMasterFill: true } : {}),
    ...(args.masterOpenedAt !== undefined
      ? { masterOpenedAt: args.masterOpenedAt }
      : {}),
    ...(args.locallyFirstSeenAt !== undefined
      ? { locallyFirstSeenAt: args.locallyFirstSeenAt }
      : {}),
    ...(args.restPreExistingUnknown
      ? { restPreExistingUnknown: true }
      : {}),
  });
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
  options?: { exitReason?: ExitReasonValue },
): Promise<boolean> {
  // Sole entry point for follower closes — call only from pollMasterPositionsFallback.
  if (!(await assertStrategyActiveForCopy(prisma, strategyId))) {
    return false;
  }

  const futureHedgeId = await resolveFutureHedgeStrategyId(prisma);
  if (!futureHedgeId || strategyId !== futureHedgeId) {
    console.log(
      `[tradeEngine] Ignoring master flat for non-Future-Hedge strategyId=${strategyId}`,
    );
    return false;
  }

  const closureOrigin = resolveClosureOrigin(
    strategyId,
    snap.symbol,
    options?.exitReason,
  );

  console.log(
    `[EXECUTION] notifyMasterFlat enter strategyId=${strategyId} ${snap.symbol} ${snap.side} contracts=${snap.masterContracts} entry=${snap.masterEntryPrice} origin="${closureOrigin}"`,
  );

  try {
    const result = await syncMasterCloseToFutureHedgeFollowers(
      prisma,
      {
        symbol: snap.symbol,
        side: snap.side,
        masterLots: snap.masterContracts,
        masterEntryPrice: snap.masterEntryPrice,
      },
      async (closed) => {
        await closeFollowerTradeAndRecordPnl(prisma, {
          userId: closed.userId,
          strategyId: closed.strategyId,
          symbol: closed.symbol,
          side: closed.side,
          masterEntryPrice: closed.masterEntryPrice,
          sizedPosition: closed.sizedPosition,
          exitPrice: closed.exitPrice,
          exitFee: closed.exitFee,
          exitReason: closureOrigin,
        });
      },
      { exitReason: closureOrigin },
    );
    if (!result) return false;
    if (result.remainingExchangeLots > 0) {
      console.warn(
        `[EXECUTION] notifyMasterFlat ${snap.symbol} ${snap.side} — ` +
          `${result.remainingExchangeLots} follower lot(s) still open on exchange; will retry`,
      );
      return false;
    }
    return true;
  } finally {
    consumeBotInitiatedCloseReason(strategyId, snap.symbol);
  }
}

/** Close all follower books after master auto-exit or manual flat burst. */
export async function fanOutMasterFlatCloses(
  prisma: PrismaClient,
  strategyId: string,
  legs: Array<{
    symbolKey: string;
    side: TradeSide;
    contracts: number;
    entryPrice: number;
  }>,
  exitReason: ExitReasonValue,
): Promise<void> {
  for (const leg of legs) {
    try {
      await notifyMasterFlat(
        prisma,
        strategyId,
        {
          symbol: leg.symbolKey,
          side: leg.side,
          masterEntryPrice: leg.entryPrice,
          masterContracts: leg.contracts,
        },
        { exitReason },
      );
    } catch (err) {
      console.error(
        `[tradeEngine] fanOutMasterFlatCloses failed ${leg.symbolKey} ${leg.side}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

type LastOpenMeta = {
  symbol: string;
  side: TradeSide;
  contracts: number;
  avgEntry: number;
};

function masterLegKey(symbol: string, side: TradeSide): string {
  return `${compactSymbolKey(symbol)}:${side}`;
}

/** Shared master position snapshot — WS handlers and REST poll read/write the same maps. */
class MasterPositionTracker {
  readonly lastPositionContracts = new Map<string, number>();
  readonly lastOpenMeta = new Map<string, LastOpenMeta>();
  /** legKey → first REST poll time the leg was missing (flat confirmation gate). */
  readonly pendingFlatSince = new Map<string, number>();
  /** legKey present at REST baseline seed — pre-existing session legs. */
  readonly legsAtBaseline = new Set<string>();
  /** legKey → ms when bot first observed open time (exchange or local first-seen). */
  readonly legOpenedAtMs = new Map<string, number>();
  /** Cross-channel master fill dedup for live follower fan-out. */
  readonly copyDedup = new MasterFillDedup();
  private restBaselineSeeded = false;

  aliasesForSnap(snap: {
    symbol: string;
    side: TradeSide;
    productKey: string;
  }): string[] {
    const out = new Set<string>();
    for (const a of symbolAliasSet(snap.symbol)) out.add(a);
    if (snap.productKey) {
      out.add(snap.productKey);
      out.add(snap.productKey.toUpperCase());
    }
    out.add(masterLegKey(snap.symbol, snap.side));
    return Array.from(out).filter(Boolean);
  }

  maxContractsForSymbolSide(symbol: string, side: TradeSide): number {
    let prev = 0;
    for (const a of symbolAliasSet(symbol)) {
      const m = this.lastOpenMeta.get(a);
      if (m && m.side === side) {
        prev = Math.max(
          prev,
          this.lastPositionContracts.get(a) ?? m.contracts,
        );
      }
    }
    const legK = masterLegKey(symbol, side);
    const legMeta = this.lastOpenMeta.get(legK);
    if (legMeta?.side === side) {
      prev = Math.max(
        prev,
        this.lastPositionContracts.get(legK) ?? legMeta.contracts,
      );
    }
    return prev;
  }

  writeTracked(
    snap: {
      symbol: string;
      side: TradeSide;
      contracts: number;
      avgEntry: number | null;
      productKey: string;
    },
    contracts: number,
  ): void {
    const aliases = this.aliasesForSnap(snap);
    for (const k of aliases) {
      const prev = this.lastOpenMeta.get(k);
      this.lastPositionContracts.set(k, contracts);
      this.lastOpenMeta.set(k, {
        symbol: snap.symbol,
        side: snap.side,
        contracts,
        avgEntry: Number.isFinite(snap.avgEntry ?? NaN)
          ? (snap.avgEntry as number)
          : prev?.avgEntry ?? 0,
      });
    }
  }

  applyMasterLeg(leg: {
    symbol: string;
    side: TradeSide;
    contracts: number;
    avgEntry: number;
  }): void {
    const snap = {
      symbol: leg.symbol,
      side: leg.side,
      contracts: leg.contracts,
      avgEntry: leg.avgEntry,
      productKey: leg.symbol,
    };
    this.writeTracked(snap, leg.contracts);
  }

  clearLegKeys(keys: Iterable<string>): void {
    for (const k of keys) {
      this.lastPositionContracts.delete(k);
      this.lastOpenMeta.delete(k);
    }
  }

  clearPendingFlat(legKey: string): void {
    this.pendingFlatSince.delete(legKey);
  }

  isRestBaselineSeeded(): boolean {
    return this.restBaselineSeeded;
  }

  markRestBaselineSeeded(): void {
    this.restBaselineSeeded = true;
  }

  markBaselineLeg(symbol: string, side: TradeSide): void {
    this.legsAtBaseline.add(masterLegKey(symbol, side));
  }

  isNewLegThisSession(symbol: string, side: TradeSide): boolean {
    if (!this.restBaselineSeeded) return true;
    return !this.legsAtBaseline.has(masterLegKey(symbol, side));
  }

  noteLegObserved(
    symbol: string,
    side: TradeSide,
    exchangeOpenedAt: Date | null,
    isNewLeg: boolean,
  ): void {
    const lk = masterLegKey(symbol, side);
    if (exchangeOpenedAt) {
      const ms = exchangeOpenedAt.getTime();
      const prev = this.legOpenedAtMs.get(lk);
      if (prev == null || ms < prev) {
        this.legOpenedAtMs.set(lk, ms);
      }
      return;
    }
    if (isNewLeg && !this.legOpenedAtMs.has(lk)) {
      this.legOpenedAtMs.set(lk, Date.now());
    }
  }

  resolveLegOpenedAt(
    symbol: string,
    side: TradeSide,
    exchangeOpenedAt: Date | null,
  ): Date | null {
    if (exchangeOpenedAt) return exchangeOpenedAt;
    const ms = this.legOpenedAtMs.get(masterLegKey(symbol, side));
    return ms != null && Number.isFinite(ms) ? new Date(ms) : null;
  }
}

/**
 * Safety net: OPEN Trade rows while the follower exchange book is flat → book PnL.
 */
async function reconcileStaleOpenCopyTrades(
  prisma: PrismaClient,
  strategyId: string,
  cancelled: { value: boolean },
): Promise<void> {
  const subs = await findActiveFutureHedgeCopySubscribers(prisma);
  for (const sub of subs) {
    if (cancelled.value) return;

    const creds = resolveSubscriptionCreds(sub);
    if (!creds) continue;

    const openTrades = await prisma.trade.findMany({
      where: {
        userId: sub.userId,
        strategyId,
        status: TradeStatus.OPEN,
      },
    });
    if (openTrades.length === 0) continue;

    let exchangeOpen: DeltaLivePosition[] = [];
    try {
      exchangeOpen = await fetchDeltaOpenPositions(
        creds.apiKey,
        creds.apiSecret,
        { lite: true, skipCache: true },
      );
    } catch (err) {
      console.warn(
        `[trade-settlement] stale reconcile fetch failed user=${sub.userId}:`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }

    for (const trade of openTrades) {
      if (cancelled.value) return;
      const side: TradeSide = trade.side.toUpperCase() === "SELL" ? "SELL" : "BUY";
      const stillOpen = exchangeOpen.some(
        (p) =>
          p.side === side &&
          tradePositionSymbolsAlign(trade.symbol, p.symbolKey) &&
          Math.abs(p.contracts) >= 1e-12,
      );
      if (stillOpen) continue;

      let exitPrice = 0;
      try {
        const tick = await fetchDeltaTicker(trade.symbol);
        if (tick.last != null && Number.isFinite(tick.last)) {
          exitPrice = tick.last;
        }
      } catch {
        /* optional */
      }
      if (exitPrice <= 0 && trade.entryPrice > 0) {
        exitPrice = trade.entryPrice;
      }

      const settled = await settleOpenCopyTradesForLeg(prisma, {
        userId: sub.userId,
        strategyId,
        symbol: trade.symbol,
        side,
        exitPrice,
        exitFee: 0,
        exitReason: EXIT_REASON.MASTER_CLOSED,
        closeAllMatching: true,
      });
      if (settled > 0) {
        console.log(
          `[trade-settlement] stale OPEN trade booked user=${sub.userId} ${trade.symbol} ${side}`,
        );
      }
    }
  }
}

/**
 * REST fallback: poll master exchange positions — force-sync opens and confirm
 * closes only when REST shows the master leg is flat/missing.
 */
async function pollMasterPositionsFallback(
  prisma: PrismaClient,
  tracker: MasterPositionTracker,
  cancelled: { value: boolean },
): Promise<void> {
  if (cancelled.value) return;

  try {
    const futureHedgeId = await resolveFutureHedgeStrategyId(prisma);
    if (!futureHedgeId) return;

    const strat = await prisma.strategy.findFirst({
      where: {
        id: futureHedgeId,
        ...STRATEGY_WHERE_COPY_ENABLED,
      },
      select: {
        id: true,
        isActive: true,
        masterApiKey: true,
        masterApiSecret: true,
      },
    });
    if (!strat?.isActive) return;
    if (!strat.masterApiKey?.trim() || !strat.masterApiSecret?.trim()) {
      return;
    }

    const subs = await findActiveFutureHedgeCopySubscribers(prisma);
    if (subs.length === 0) return;

    if (!(await assertStrategyActiveForCopy(prisma, strat.id))) return;

    let masters: MasterLedTrade[];
    try {
      masters = await fetchMasterOpenPositions(
        strat.masterApiKey,
        strat.masterApiSecret,
        { skipCache: true },
      );
    } catch (err) {
      console.warn(
        "[MASTER-REST-SYNC] fetch positions failed:",
        err instanceof Error ? err.message : err,
      );
      return;
    }

    registerSymbolsForLivePrices(masters.map((m) => m.deltaSymbol));

    const wasBaselineSeeded = tracker.isRestBaselineSeeded();

    if (!wasBaselineSeeded) {
      for (const m of masters) {
        tracker.applyMasterLeg({
          symbol: m.deltaSymbol,
          side: m.side,
          contracts: m.masterContracts,
          avgEntry: Number.isFinite(m.entryPrice) ? m.entryPrice : 0,
        });
        tracker.markBaselineLeg(m.deltaSymbol, m.side);
        tracker.noteLegObserved(m.deltaSymbol, m.side, m.openedAt, false);
      }
      tracker.markRestBaselineSeeded();
      console.log(
        `[MASTER-REST-SYNC] baseline seeded ${masters.length} open master leg(s)`,
      );
    }

    for (const m of masters) {
      if (cancelled.value) return;
      if (m.masterContracts <= 0) continue;

      tracker.clearPendingFlat(masterLegKey(m.deltaSymbol, m.side));

      if (wasBaselineSeeded) {
        const isNewLeg = tracker.isNewLegThisSession(m.deltaSymbol, m.side);
        tracker.noteLegObserved(m.deltaSymbol, m.side, m.openedAt, isNewLeg);
        const locallyFirstSeenAt = tracker.resolveLegOpenedAt(
          m.deltaSymbol,
          m.side,
          m.openedAt,
        );
        const restPreExistingUnknown = masterLegRestPreExistingUnknown({
          isNewLegThisSession: isNewLeg,
          exchangeOpenedAt: m.openedAt,
          locallyFirstSeenAt,
        });

        if (
          !isMasterLegFreshForRestCatchup(
            m.openedAt,
            locallyFirstSeenAt,
            isNewLeg,
          )
        ) {
          continue;
        }

        if (
          shouldSuppressMasterRestCopy({
            strategyId: strat.id,
            symbol: m.deltaSymbol,
            openSide: m.side,
          })
        ) {
          tracker.applyMasterLeg({
            symbol: m.deltaSymbol,
            side: m.side,
            contracts: m.masterContracts,
            avgEntry: Number.isFinite(m.entryPrice) ? m.entryPrice : 0,
          });
          console.log(
            `[MASTER-REST-SYNC] NC_/no-copy suppress — tracker synced ${m.deltaSymbol} ${m.side} qty=${m.masterContracts}, skip follower fan-out`,
          );
          continue;
        }

        const missingOnFollowers = await followersMissingOpenLeg(
          prisma,
          strat.id,
          m.deltaSymbol,
          m.side,
          m.masterContracts,
          m.openedAt,
          locallyFirstSeenAt,
          restPreExistingUnknown,
        );

        if (missingOnFollowers) {
          if (
            restForceCopyOnCooldown(strat.id, m.deltaSymbol, m.side)
          ) {
            continue;
          }
          markRestForceCopyAttempt(strat.id, m.deltaSymbol, m.side);

          const legKey = masterLegKey(m.deltaSymbol, m.side);
          const fillKey = `force-rest:${buildMasterFillKey([
            m.deltaSymbol,
            m.side,
            String(m.masterContracts),
            legKey,
          ])}`;
          try {
            await triggerMasterOpenCopy(prisma, strat.id, {
              symbol: m.deltaSymbol,
              side: m.side,
              masterContracts: m.masterContracts,
              avgPrice: Number.isFinite(m.entryPrice) ? m.entryPrice : null,
              masterFillKey: fillKey,
              source: "rest",
              forceRestSync: true,
              masterOpenedAt: m.openedAt,
              locallyFirstSeenAt,
              restPreExistingUnknown,
            });
          } catch (copyErr) {
            console.error(
              `[MASTER-REST-SYNC] force copy failed ${m.deltaSymbol} ${m.side}:`,
              copyErr instanceof Error ? copyErr.message : copyErr,
            );
          }
        }
      }

      tracker.applyMasterLeg({
        symbol: m.deltaSymbol,
        side: m.side,
        contracts: m.masterContracts,
        avgEntry: Number.isFinite(m.entryPrice) ? m.entryPrice : 0,
      });
    }

    if (wasBaselineSeeded) {
      const trackedLegs = new Map<string, LastOpenMeta>();
      for (const meta of tracker.lastOpenMeta.values()) {
        const lk = masterLegKey(meta.symbol, meta.side);
        if (trackedLegs.has(lk)) continue;
        const cur = tracker.maxContractsForSymbolSide(meta.symbol, meta.side);
        if (cur > 0) trackedLegs.set(lk, meta);
      }

      for (const [lk, meta] of trackedLegs) {
        if (cancelled.value) return;

        if (masterLegOpenOnRest(meta, masters)) {
          tracker.clearPendingFlat(lk);
          continue;
        }

        const lastContracts = tracker.maxContractsForSymbolSide(
          meta.symbol,
          meta.side,
        );
        if (lastContracts <= 0) continue;

        const now = Date.now();
        const firstMissing = tracker.pendingFlatSince.get(lk);
        if (firstMissing === undefined) {
          tracker.pendingFlatSince.set(lk, now);
          console.log(
            `[MASTER-REST-SYNC] leg missing from REST ${meta.symbol} ${meta.side} — ` +
              `awaiting ${MASTER_FLAT_CONFIRM_MS / 1000}s confirmation before follower close.`,
          );
          continue;
        }
        if (now - firstMissing < MASTER_FLAT_CONFIRM_MS) {
          continue;
        }

        console.log(
          `[MASTER-REST-SYNC] Master flat confirmed via REST ${meta.symbol} ${meta.side} ` +
            `(${lastContracts} contracts, missing ${Math.round((now - firstMissing) / 1000)}s) — closing followers.`,
        );
        tracker.clearPendingFlat(lk);

        try {
          const flatOk = await notifyMasterFlat(prisma, strat.id, {
            symbol: meta.symbol,
            side: meta.side,
            masterEntryPrice:
              Number.isFinite(meta.avgEntry) && meta.avgEntry > 0
                ? meta.avgEntry
                : 0,
            masterContracts: lastContracts,
          });
          if (!flatOk) {
            console.warn(
              `[MASTER-REST-SYNC] follower close incomplete for ${meta.symbol} ${meta.side} — will retry next poll`,
            );
            continue;
          }
        } catch (closeErr) {
          console.error(
            `[MASTER-REST-SYNC] notifyMasterFlat failed ${meta.symbol} ${meta.side}:`,
            closeErr instanceof Error ? closeErr.message : closeErr,
          );
          continue;
        }

        tracker.clearLegKeys(
          tracker.aliasesForSnap({
            symbol: meta.symbol,
            side: meta.side,
            productKey: meta.symbol,
          }),
        );
      }

      if (masters.length === 0) {
        try {
          const reconciled = await reconcileFollowersToEmptyMasterBook(
            prisma,
            async (closed) => {
              await closeFollowerTradeAndRecordPnl(prisma, {
                userId: closed.userId,
                strategyId: closed.strategyId,
                symbol: closed.symbol,
                side: closed.side,
                masterEntryPrice: closed.masterEntryPrice,
                sizedPosition: closed.sizedPosition,
                exitPrice: closed.exitPrice,
                exitFee: closed.exitFee,
                exitReason: closed.exitReason ?? EXIT_REASON.MASTER_CLOSED,
              });
            },
            { exitReason: EXIT_REASON.MASTER_CLOSED },
          );
          if (reconciled > 0) {
            console.log(
              `[MASTER-REST-SYNC] reconciled ${reconciled} orphan follower leg(s) while master book empty`,
            );
          }
        } catch (reconcileErr) {
          console.error(
            "[MASTER-REST-SYNC] orphan follower reconcile failed:",
            reconcileErr instanceof Error ? reconcileErr.message : reconcileErr,
          );
        }
      }
    }

    await reconcileStaleOpenCopyTrades(prisma, strat.id, cancelled);
  } catch (err) {
    console.error(
      "[MASTER-REST-SYNC] poll failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

class StrategyMasterSocket {
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private destroyed = false;
  /** Serializes WS handlers so fills/closes for this strategy never overlap. */
  private messageChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly prisma: PrismaClient,
    readonly strategyId: string,
    private readonly tracker: MasterPositionTracker,
  ) {}

  private enqueueMessage(handler: () => Promise<void>): void {
    this.messageChain = this.messageChain
      .then(handler)
      .catch((err) => {
        console.error(
          `[tradeEngine WS] queued handler failed strategyId=${this.strategyId}:`,
          err instanceof Error ? err.message : err,
        );
      });
  }

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

  private async seedPositionMapsFromRest(): Promise<void> {
    try {
      const strat = await this.prisma.strategy.findUnique({
        where: { id: this.strategyId },
        select: STRATEGY_SELECT_WS_CREDS,
      });
      if (!strat) return;
      const key = strat.masterApiKey?.trim();
      const secret = strat.masterApiSecret?.trim();
      if (!key || !secret) return;

      const masters = await fetchMasterOpenPositions(
        strat.masterApiKey,
        strat.masterApiSecret,
      );
      registerSymbolsForLivePrices(masters.map((m) => m.deltaSymbol));
      for (const m of masters) {
        this.tracker.applyMasterLeg({
          symbol: m.deltaSymbol,
          side: m.side,
          contracts: m.masterContracts,
          avgEntry: Number.isFinite(m.entryPrice) ? m.entryPrice : 0,
        });
      }
      console.log(
        `[tradeEngine] seeded ${masters.length} master open positions strategyId=${this.strategyId} keys=${JSON.stringify(
          Array.from(this.tracker.lastOpenMeta.keys()),
        )}`,
      );
      this.tracker.markRestBaselineSeeded();
    } catch (err) {
      console.warn(
        `[tradeEngine] seedPositionMapsFromRest failed strategyId=${this.strategyId}:`,
        err,
      );
    }
  }

  private connect(): void {
    if (this.destroyed) return;
    this.tearDownSocket();

    void this.prisma.strategy
      .findUnique({
        where: { id: this.strategyId },
        select: STRATEGY_SELECT_WS_CREDS,
      })
      .then((s) => {
        if (this.destroyed) return;
        if (!s) {
          this.scheduleReconnect();
          return;
        }
        if (!s.isActive) {
          this.destroy();
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
          // Log a concise handshake trace so we can correlate WS auth
          // attempts with Delta's response (which can return type=error
          // for many reasons: bad signature, IP whitelist, missing
          // 'View' / WebSocket permission on the key, time skew, etc).
          const keyPrefix =
            key.length > 5 ? key.substring(0, 5) + "***" : "INVALID_LENGTH";
          console.log(
            `[tradeEngine WS] auth attempt strategyId=${this.strategyId} keyPrefix=${keyPrefix} ts=${ts} sig=${signature.substring(0, 12)}...`,
          );
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
          this.enqueueMessage(() => this.onMessage(data));
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

    console.log(
      `[tradeEngine WS] strategyId=${this.strategyId} type=${type} action=${String(msg.action ?? "?")}`,
    );

    // Dump the full payload for `type=error` (and warnings). Delta India
    // returns the actual rejection reason in `payload`/`message`/`error`
    // fields — without this we can't tell whether the handshake failure is
    // a bad signature, an IP whitelist miss, a missing key permission, a
    // time skew, or a malformed subscribe.
    if (type === "error" || type === "warning") {
      let dump: string;
      try {
        dump = JSON.stringify(msg);
      } catch {
        dump = String(msg);
      }
      console.error(
        `[tradeEngine WS] ${type.toUpperCase()} payload strategyId=${this.strategyId}: ${dump}`,
      );
    }

    if (isDeltaPrivateWsAuthSuccess(msg)) {
      this.ws?.send(JSON.stringify(masterWsSubscribePayload()));
      console.log(
        `[tradeEngine WS] authenticated — subscribed orders/positions/user_trades strategyId=${this.strategyId}`,
      );
      void this.seedPositionMapsFromRest();
      requestImmediateMasterRestPoll("ws-auth-ready");
      return;
    }

    const eventKind = classifyMasterWsEvent(msg);

    if (eventKind === "orders") {
      const orderAction = String(msg.action ?? "").toLowerCase();
      if (orderAction === "delete" || orderAction === "closed") {
        console.warn(
          `[tradeEngine WS] orders ${orderAction} strategyId=${this.strategyId} — scheduling immediate REST flat check`,
        );
        requestImmediateMasterRestPoll(`ws-order-${orderAction}`);
        return;
      }

      if (!(await assertStrategyActiveForCopy(this.prisma, this.strategyId))) {
        return;
      }

      const records = collectWsChannelRecords(msg, parsed);
      await processMasterOrderFillRecords(
        this.prisma,
        this.strategyId,
        records,
        this.tracker,
      );
      return;
    }

    if (eventKind === "fills") {
      if (!(await assertStrategyActiveForCopy(this.prisma, this.strategyId))) {
        return;
      }

      const records = collectWsChannelRecords(msg, parsed);
      await processMasterUserTradeFillRecords(
        this.prisma,
        this.strategyId,
        records,
        this.tracker,
      );
      return;
    }

    if (eventKind === "positions") {
      const merged = mergePayloadLayers(parsed);
      const action = String(msg.action ?? "").toLowerCase();

      const copyEnabled = await assertStrategyActiveForCopy(
        this.prisma,
        this.strategyId,
      );

      const collectRows = (): unknown[] => {
        const rows: unknown[] = [];
        const dataLayer = asRecord(msg.data);
        if (Array.isArray(msg.data)) rows.push(...msg.data);
        else if (dataLayer) {
          if (Array.isArray(dataLayer.positions))
            rows.push(...(dataLayer.positions as unknown[]));
          if (Array.isArray(dataLayer.open))
            rows.push(...(dataLayer.open as unknown[]));
          if (Array.isArray(dataLayer.closed))
            rows.push(...(dataLayer.closed as unknown[]));
          if (rows.length === 0) rows.push(msg.data);
        }
        if (rows.length === 0) rows.push(merged);
        return rows;
      };

      if (action === "snapshot") {
        const rows = collectRows();
        let n = 0;
        for (const r of rows) {
          const snap = extractPositionSnapshot(r);
          if (!snap) continue;
          if (snap.contracts <= 0) continue;
          this.tracker.writeTracked(snap, snap.contracts);
          n += 1;
        }
        console.log(
          `[tradeEngine WS] positions snapshot processed ${n} rows strategyId=${this.strategyId} keys=${JSON.stringify(
            Array.from(this.tracker.lastOpenMeta.keys()),
          )}`,
        );
        return;
      }

      // WS delete/close events — schedule immediate REST poll (faster than waiting for interval).
      if (action === "delete" || action === "closed") {
        console.warn(
          `[tradeEngine WS] positions ${action} strategyId=${this.strategyId} — scheduling immediate REST flat check`,
        );
        requestImmediateMasterRestPoll(`ws-position-${action}`);
        return;
      }

      // ---- CREATE / UPDATE / GENERIC POSITION ROW ----
      const rows = collectRows();
      for (const r of rows) {
        const snap = extractPositionSnapshot(r);
        if (!snap) continue;

        const aliases = this.tracker.aliasesForSnap(snap);
        let prev = 0;
        let meta: LastOpenMeta | undefined;
        for (const k of aliases) {
          const c = this.tracker.lastPositionContracts.get(k) ?? 0;
          if (c > prev) prev = c;
          const m = this.tracker.lastOpenMeta.get(k);
          if (!meta && m) meta = m;
        }
        const next = snap.contracts;

        if (next <= 0 && prev > 0) {
          console.warn(
            `[tradeEngine WS] positions update size→0 ${snap.symbol} ${snap.side} (${prev} contracts) strategyId=${this.strategyId} — scheduling immediate REST flat check`,
          );
          requestImmediateMasterRestPoll("ws-position-flat-hint");
          continue;
        }

        if (next > 0) {
          registerSymbolsForLivePrices([snap.symbol]);
          this.tracker.writeTracked(snap, next);
          console.log(
            `[tradeEngine WS] tracked ${snap.symbol} ${snap.side} ${next} contracts (keys=${JSON.stringify(aliases)})`,
          );

          if (copyEnabled && next > prev) {
            console.log(
              `[tradeEngine WS] positions +${next - prev} ${snap.symbol} ${snap.side} — scheduling immediate REST copy sync`,
            );
            requestImmediateMasterRestPoll("ws-position-increase");
          }
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
  const stopLivePriceTracker = startLivePriceTracker(prisma);
  const masterPositionTracker = new MasterPositionTracker();
  const sockets = new Map<string, StrategyMasterSocket>();
  let rosterTimeout: ReturnType<typeof setTimeout> | null = null;
  let reconcileTimeout: ReturnType<typeof setTimeout> | null = null;
  let qtyReconcileTimeout: ReturnType<typeof setTimeout> | null = null;
  let autoExitTimeout: ReturnType<typeof setTimeout> | null = null;
  let masterRestPollInterval: ReturnType<typeof setInterval> | null = null;

  async function syncRoster(): Promise<void> {
    if (cancelled.value) return;
    try {
      const fh = await prisma.strategy.findFirst({
        where: { title: FUTURE_HEDGE_STRATEGY_TITLE },
        select: {
          id: true,
          isActive: true,
          masterApiKey: true,
          masterApiSecret: true,
        },
      });

      const want = new Set<string>();

      if (fh) {
        const subs = fh.isActive
          ? await findActiveCopySubscribersForStrategy(prisma, fh.id)
          : [];

        if (
          fh.isActive &&
          fh.masterApiKey?.trim() &&
          fh.masterApiSecret?.trim() &&
          subs.length > 0
        ) {
          want.add(fh.id);
        }
      }

      for (const id of sockets.keys()) {
        if (!want.has(id)) {
          sockets.get(id)?.destroy();
          sockets.delete(id);
          console.log(
            `[tradeEngine] Future Hedge copy WS stopped strategyId=${id} (paused or no subscribers)`,
          );
        }
      }

      for (const id of want) {
        if (!sockets.has(id)) {
          const conn = new StrategyMasterSocket(prisma, id, masterPositionTracker);
          sockets.set(id, conn);
          conn.start();
          console.log(
            `[tradeEngine] Future Hedge copy WS started strategyId=${id} (${FUTURE_HEDGE_STRATEGY_TITLE})`,
          );
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

  /**
   * DISABLED — 30s ghost reconcile caused false-positive follower closes.
   * Follower exits are centralized in {@link pollMasterPositionsFallback} (5s REST).
   */
  async function reconcileGhostExits(): Promise<void> {
    if (cancelled.value) return;
  }

  /**
   * Every {@link POSITION_QTY_RECONCILE_MS}, open missing bot-managed lots only.
   * Trims/closes are disabled — follower exits via {@link pollMasterPositionsFallback}.
   */
  async function reconcilePositionQuantities(): Promise<void> {
    if (cancelled.value) return;
    try {
      const futureHedgeId = await resolveFutureHedgeStrategyId(prisma);
      if (!futureHedgeId) return;

      const strat = await prisma.strategy.findFirst({
        where: {
          id: futureHedgeId,
          ...STRATEGY_WHERE_COPY_ENABLED,
        },
        select: {
          id: true,
          masterApiKey: true,
          masterApiSecret: true,
        },
      });
      if (!strat?.masterApiKey?.trim() || !strat.masterApiSecret?.trim()) {
        return;
      }

      let masterLegs: MasterLedTrade[];
      try {
        masterLegs = await fetchMasterOpenPositions(
          strat.masterApiKey,
          strat.masterApiSecret,
        );
      } catch (err) {
        console.warn(
          `[RECONCILE] master REST failed strategyId=${strat.id}:`,
          err instanceof Error ? err.message : err,
        );
        return;
      }

      const subs = await findActiveFutureHedgeCopySubscribers(prisma);

      for (const sub of subs) {
          if (cancelled.value) return;

          const creds = resolveSubscriptionCreds(sub);
          if (!creds) {
            console.warn(
              `[RECONCILE] skip userId=${sub.userId} strategyId=${strat.id} — no API credentials`,
            );
            continue;
          }

          const botLegs = await listOpenFollowerBotLegs(
            prisma,
            strat.id,
            sub.userId,
          );

          for (const botLeg of botLegs) {
            if (cancelled.value) return;

            const master = masterLegs.find(
              (m) =>
                m.side === botLeg.side &&
                tradePositionSymbolsAlign(botLeg.symbol, m.deltaSymbol),
            );
            const expectedContracts = master
              ? followerContractsFromMaster(
                  master.masterContracts,
                  subscriptionMultiplier(sub),
                )
              : 0;
            const dbQty = Math.max(0, Math.floor(botLeg.quantity));

            if (dbQty === expectedContracts) continue;

            if (dbQty < expectedContracts) {
              const masterOpenedAt = master?.openedAt ?? null;
              const isNewLeg = master
                ? masterPositionTracker.isNewLegThisSession(
                    master.deltaSymbol,
                    master.side,
                  )
                : false;
              if (master) {
                masterPositionTracker.noteLegObserved(
                  master.deltaSymbol,
                  master.side,
                  master.openedAt,
                  isNewLeg,
                );
              }
              const locallyFirstSeenAt = master
                ? masterPositionTracker.resolveLegOpenedAt(
                    master.deltaSymbol,
                    master.side,
                    master.openedAt,
                  )
                : null;
              const restPreExistingUnknown = master
                ? masterLegRestPreExistingUnknown({
                    isNewLegThisSession: isNewLeg,
                    exchangeOpenedAt: master.openedAt,
                    locallyFirstSeenAt,
                  })
                : true;
              if (
                !master ||
                !isMasterLegFreshForRestCatchup(
                  masterOpenedAt,
                  locallyFirstSeenAt,
                  isNewLeg,
                ) ||
                !followerEligibleForMasterLegCopy({
                  joinedDate: sub.joinedDate,
                  masterOpenedAt,
                  locallyFirstSeenAt,
                  restPreExistingUnknown,
                })
              ) {
                console.log(
                  `[RECONCILE] skip catch-up user ${sub.userId} ${botLeg.symbol} — ` +
                    `late-join guard (fresh=${isMasterLegFreshForRestCatchup(
                      masterOpenedAt,
                      locallyFirstSeenAt,
                      isNewLeg,
                    )})`,
                );
                continue;
              }

              const diff = expectedContracts - dbQty;
              console.log(
                `[RECONCILE] Bot leg catch-up user ${sub.userId} ${botLeg.symbol}: DB ${dbQty} → expected ${expectedContracts} (+${diff})`,
              );
              let px =
                master != null &&
                Number.isFinite(master.entryPrice) &&
                master.entryPrice > 0
                  ? master.entryPrice
                  : 0;
              if (px <= 0) {
                try {
                  const tick = await fetchDeltaTicker(botLeg.symbol);
                  if (tick.last != null && Number.isFinite(tick.last)) {
                    px = tick.last;
                  }
                } catch {
                  /* entry required for verified execution */
                }
              }
              if (px <= 0) {
                console.warn(
                  `[RECONCILE] skip catch-up user ${sub.userId} ${botLeg.symbol} — no entry price`,
                );
                continue;
              }

              const reconcileFillKey = `reconcile:${sub.userId}:${botLeg.symbol}:${botLeg.side}:${expectedContracts}`;
              const clientOrderId = buildStableCopyClientOrderId({
                strategyId: strat.id,
                userId: sub.userId,
                masterFillKey: reconcileFillKey,
                symbol: botLeg.symbol,
                side: botLeg.side as TradeSide,
                leg: "open",
              });

              const result = await executeFollowerTradeWithVerification(prisma, {
                strategyId: strat.id,
                userId: sub.userId,
                apiKey: creds.apiKey,
                apiSecret: creds.apiSecret,
                symbol: botLeg.symbol,
                side: botLeg.side as TradeSide,
                size: diff,
                entryPrice: px,
                clientOrderId,
                forceRestSync: true,
              });
              if (!result.success || !result.verified) {
                console.error(
                  `[RECONCILE] catch-up failed userId=${sub.userId} symbol=${botLeg.symbol} diff=${diff}: ${result.error ?? "not verified"}`,
                );
                await markSubscriptionSyncFailed(prisma, {
                  userId: sub.userId,
                  strategyId: strat.id,
                  error: result.error ?? "Reconcile catch-up failed",
                });
              } else {
                const recordedLots = result.verifiedQty ?? diff;
                await recordTradePositionOpen(prisma, {
                  strategyId: strat.id,
                  userId: sub.userId,
                  symbol: botLeg.symbol,
                  side: botLeg.side,
                  quantity: recordedLots,
                  entryPrice: px,
                  clientOrderId,
                  ...(result.orderId ? { exchangeOrderId: result.orderId } : {}),
                });
                await markSubscriptionSynced(prisma, {
                  userId: sub.userId,
                  strategyId: strat.id,
                });
              }
              continue;
            }

            // Over-allocation / master-flat trim disabled — closes only via 5s REST poll.
            console.log(
              `[RECONCILE] skip trim user ${sub.userId} ${botLeg.symbol}: DB ${dbQty} > expected ${expectedContracts} — ` +
                `follower closes only via MASTER-REST-SYNC`,
            );
          }
        }
    } catch (err) {
      console.error("[RECONCILE] position quantity pass failed:", err);
    }
  }

  function scheduleReconcile(): void {
    reconcileTimeout = setTimeout(() => {
      void reconcileGhostExits().finally(() => {
        if (!cancelled.value) scheduleReconcile();
      });
    }, SAFETY_RECONCILE_MS);
  }

  function scheduleQtyReconcile(): void {
    qtyReconcileTimeout = setTimeout(() => {
      void reconcilePositionQuantities().finally(() => {
        if (!cancelled.value) scheduleQtyReconcile();
      });
    }, POSITION_QTY_RECONCILE_MS);
  }

  async function runAutoExitPass(): Promise<void> {
    if (cancelled.value) return;
    try {
      await runAllStrategyAutoExitChecks(prisma);
    } catch (err) {
      console.error("[tradeEngine] auto-exit pass failed:", err);
    }
  }

  function scheduleAutoExit(): void {
    autoExitTimeout = setTimeout(() => {
      void runAutoExitPass().finally(() => {
        if (!cancelled.value) scheduleAutoExit();
      });
    }, AUTO_EXIT_CHECK_MS);
  }

  void syncRoster().finally(() => {
    if (!cancelled.value) scheduleRoster();
  });
  void reconcileGhostExits().finally(() => {
    if (!cancelled.value) scheduleReconcile();
  });
  void reconcilePositionQuantities().finally(() => {
    if (!cancelled.value) scheduleQtyReconcile();
  });
  void runAutoExitPass().finally(() => {
    if (!cancelled.value) scheduleAutoExit();
  });

  masterRestPollContext = {
    prisma,
    tracker: masterPositionTracker,
    cancelled,
  };

  masterRestPollInterval = setInterval(() => {
    try {
      void pollMasterPositionsFallback(
        prisma,
        masterPositionTracker,
        cancelled,
      ).catch((err) => {
        console.error(
          "[MASTER-REST-SYNC] interval poll unhandled rejection:",
          err instanceof Error ? err.message : err,
        );
      });
    } catch (err) {
      console.error(
        "[MASTER-REST-SYNC] interval callback error:",
        err instanceof Error ? err.message : err,
      );
    }
  }, MASTER_REST_POLL_MS);
  scheduleMasterRestPoll(prisma, masterPositionTracker, cancelled);

  return () => {
    cancelled.value = true;
    masterRestPollContext = null;
    if (masterRestPollDebounce != null) {
      clearTimeout(masterRestPollDebounce);
      masterRestPollDebounce = null;
    }
    stopLivePriceTracker();
    if (masterRestPollInterval != null) {
      clearInterval(masterRestPollInterval);
      masterRestPollInterval = null;
    }
    if (rosterTimeout != null) {
      clearTimeout(rosterTimeout);
      rosterTimeout = null;
    }
    if (reconcileTimeout != null) {
      clearTimeout(reconcileTimeout);
      reconcileTimeout = null;
    }
    if (autoExitTimeout != null) {
      clearTimeout(autoExitTimeout);
      autoExitTimeout = null;
    }
    if (qtyReconcileTimeout != null) {
      clearTimeout(qtyReconcileTimeout);
      qtyReconcileTimeout = null;
    }
    for (const s of sockets.values()) {
      s.destroy();
    }
    sockets.clear();
  };
}
