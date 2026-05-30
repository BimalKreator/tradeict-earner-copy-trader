import { createHmac, createHash } from "node:crypto";
import WebSocket from "ws";
import { type PrismaClient, TradeStatus } from "@prisma/client";
import {
  executeTrade,
  fetchDeltaOpenPositions,
  fetchDeltaSwapContractSize,
  fetchDeltaTicker,
  isDeltaOptionProductId,
  normalizeDeltaPerpSymbolForCcxt,
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
  STRATEGY_SELECT_IS_ACTIVE,
  STRATEGY_SELECT_LATE_JOIN,
  STRATEGY_SELECT_SLIPPAGE,
  STRATEGY_SELECT_WS_CREDS,
  STRATEGY_WHERE_COPY_ENABLED,
} from "../prisma/strategySelect.js";
import { notifyTradeExecuted } from "./telegramService.js";
import { logUserActivity } from "./userActivityService.js";
import { runAllStrategyAutoExitChecks } from "./autoExitService.js";
import { executeFollowerTradeWithVerification, assertStrategyActiveForCopy, syncMasterCloseToFutureHedgeFollowers, syncMasterOpenFillToFutureHedgeFollowers } from "./followerTradeExecution.js";
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
  subscriptionSyncBlocksReconcile,
} from "./subscriptionSyncService.js";
import {
  registerSymbolsForLivePrices,
  startLivePriceTracker,
} from "./livePriceTracker.js";
import { buildClientOrderId } from "./tradePositionService.js";

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
const ROSTER_SYNC_MS = 15_000;
/** How often to reconcile DB OPEN trades against master REST positions (safety net). */
const SAFETY_RECONCILE_MS = 30_000;
/** Poll master total unrealized PnL vs strategy auto-exit thresholds. */
const AUTO_EXIT_CHECK_MS = 1_000;
/** Align follower contract counts with master × multiplier (REST safety net). */
const POSITION_QTY_RECONCILE_MS = 60_000;

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
  const a = compactSymbolKey(tradeSymbol);
  const b = compactSymbolKey(positionKey);
  if (a === b || a.endsWith(b) || b.endsWith(a)) return true;
  const ba = deltaPairBase(a);
  const bb = deltaPairBase(b);
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
  const product = asRecord(o.product);
  const candidates: unknown[] = [
    o.product_symbol,
    o.symbol,
    o.contract_symbol,
    o.instrument_name,
    o.derivative_symbol,
    product?.symbol,
    product?.product_symbol,
  ];
  for (const c of candidates) {
    const s = String(c ?? "").trim();
    if (s) return s;
  }
  return "";
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
  /** Stable key for follower dedup (master order id or fill fingerprint). */
  fillKey: string;
} | null {
  const o = mergePayloadLayers(raw);
  const state = String(o.state ?? o.order_state ?? o.status ?? "");
  if (!orderStateIndicatesFill(state)) return null;

  const symbol = extractDeltaProductSymbol(o);
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

  const orderIdRaw =
    o.id ?? o.order_id ?? o.client_order_id ?? o.clientOrderId;
  const orderId =
    orderIdRaw != null ? String(orderIdRaw).trim() : "";
  const fillKey =
    orderId ||
    createHash("sha256")
      .update(`${symbol}|${side}|${contracts}|${avgPrice}|${state}`)
      .digest("hex")
      .slice(0, 32);

  return { symbol, side, contracts, avgPrice, reduceOnly, fillKey };
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

  // Side preference order:
  //   1) explicit side / position_side / direction string
  //   2) sign of size (positive => BUY, negative => SELL on Delta India)
  let side = normalizeSide(o.side ?? o.position_side ?? o.direction);
  if (!side && rawSize !== null && Number.isFinite(rawSize) && rawSize !== 0) {
    side = rawSize > 0 ? "BUY" : "SELL";
  }
  // For zero-size rows (a "delete" notification disguised as an update),
  // we still want to track the row so the downstream close-detection branch
  // can fire. Default to BUY; the close path reads the side from the prior
  // tracked meta anyway.
  if (!side) side = "BUY";

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

function deltaContractSizeFallback(symbol: string): number {
  const u = symbol.toUpperCase();
  if (u.includes("BTC")) return 0.001;
  if (u.includes("ETH")) return 0.01;
  return 1;
}

async function realizedPnlUsd(args: {
  symbol: string;
  side: TradeSide;
  entryPrice: number;
  exitPrice: number;
  contracts: number;
}): Promise<number> {
  let contractFactor = deltaContractSizeFallback(args.symbol);
  try {
    contractFactor = await fetchDeltaSwapContractSize(args.symbol);
  } catch {
    /* keep fallback */
  }
  const realBaseSize = Math.abs(args.contracts) * contractFactor;
  const diff = args.exitPrice - args.entryPrice;
  return args.side === "BUY" ? diff * realBaseSize : -diff * realBaseSize;
}

function entryPriceMatches(stored: number, leader: number): boolean {
  const eps = Math.max(1e-8, Math.abs(leader) * 1e-6);
  return Math.abs(stored - leader) <= eps;
}

/**
 * Per-trade revenue-share fee: positive realized PnL × strategy profitShare%.
 * Negative or zero PnL contributes 0 (no fee on losing trades).
 *
 * Note: this is the *per-trade* display value persisted to `Trade.revenueShareAmt`
 * (used by the user trades page "Est. Fee" column). The actual billable amount
 * is computed cumulatively at month end by `generateMonthlyInvoices`, which
 * correctly netts wins against losses across the whole month.
 */
function computeRevenueShareAmt(
  realizedPnl: number,
  profitSharePct: number,
): number {
  if (!Number.isFinite(realizedPnl) || realizedPnl <= 0) return 0;
  if (!Number.isFinite(profitSharePct) || profitSharePct <= 0) return 0;
  return realizedPnl * (profitSharePct / 100);
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
  const exitReason = resolveCloseExitReason(
    args.strategyId,
    args.symbol,
    args.exitReason,
  );
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

  const open =
    candidates.find((t) => entryPriceMatches(t.entryPrice, args.masterEntryPrice)) ??
    candidates[0];

  if (!open) return;

  const grossPnl = await realizedPnlUsd({
    symbol: args.symbol,
    side: args.side,
    entryPrice: open.entryPrice,
    exitPrice: args.exitPrice,
    contracts: args.sizedPosition,
  });
  const totalTradingFee =
    Math.max(0, Number(open.tradingFee ?? 0)) + Math.max(0, Number(args.exitFee ?? 0));
  const netPnl = grossPnl - totalTradingFee;

  // Fetch profitShare for the per-trade revenue-share snapshot. Closes are
  // infrequent so a single extra select is cheap; doing it here keeps every
  // call site of this function (WS handler today, future paths) consistent.
  const strategyMeta = await prisma.strategy.findUnique({
    where: { id: args.strategyId },
    select: { profitShare: true },
  });
  const profitSharePct = strategyMeta?.profitShare ?? 0;
  const revenueShareAmt = computeRevenueShareAmt(netPnl, profitSharePct);

  await prisma.trade.update({
    where: { id: open.id },
    data: {
      exitPrice: args.exitPrice,
      tradingFee: totalTradingFee,
      pnl: netPnl,
      tradePnl: netPnl,
      revenueShareAmt,
      status: TradeStatus.CLOSED,
      exitReason,
    },
  });

  await recordTradePnl(prisma, {
    userId: args.userId,
    strategyId: args.strategyId,
    tradeProfit: netPnl,
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
  const opens = await prisma.trade.findMany({
    where: {
      userId: args.userId,
      strategyId: args.strategyId,
      symbol: args.symbol,
      side: args.side,
      status: TradeStatus.OPEN,
    },
    orderBy: { createdAt: "asc" },
  });
  if (opens.length === 0) return 0;

  const strategyMeta = await prisma.strategy.findUnique({
    where: { id: args.strategyId },
    select: { profitShare: true },
  });
  const profitSharePct = strategyMeta?.profitShare ?? 0;

  let closed = 0;
  for (let i = 0; i < opens.length; i += 1) {
    const open = opens[i]!;
    const legExitFee = i === opens.length - 1 ? Math.max(0, args.exitFee) : 0;
    const grossPnl = await realizedPnlUsd({
      symbol: args.symbol,
      side: args.side,
      entryPrice: open.entryPrice,
      exitPrice: args.exitPrice,
      contracts: open.size,
    });
    const totalTradingFee =
      Math.max(0, Number(open.tradingFee ?? 0)) + legExitFee;
    const netPnl = grossPnl - totalTradingFee;
    const revenueShareAmt = computeRevenueShareAmt(netPnl, profitSharePct);

    await prisma.trade.update({
      where: { id: open.id },
      data: {
        exitPrice: args.exitPrice,
        tradingFee: totalTradingFee,
        pnl: netPnl,
        tradePnl: netPnl,
        revenueShareAmt,
        status: TradeStatus.CLOSED,
        exitReason: EXIT_REASON.ADMIN_PANEL,
      },
    });

    await recordTradePnl(prisma, {
      userId: args.userId,
      strategyId: args.strategyId,
      tradeProfit: netPnl,
    });
    closed += 1;
  }
  return closed;
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
    const masterContracts = Math.abs(p.contracts);
    if (!Number.isFinite(masterContracts) || masterContracts < 1e-12) continue;
    out.push({
      id: `${p.symbolKey}:${p.side}`,
      deltaSymbol: p.symbolKey,
      side: p.side,
      entryPrice: entry,
      masterContracts,
    });
  }
  return out;
}

/** Leader opens via CCXT `fetchDeltaOpenPositions` (Delta India, strategy master keys). */
export async function fetchMasterOpenPositions(
  apiKey: string,
  apiSecret: string,
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

  const raw = await fetchDeltaOpenPositions(apiKey, apiSecret);
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
    const trimResult = await executeTrade(
      creds.apiKey,
      creds.apiSecret,
      master.deltaSymbol,
      trimSide,
      diff,
      { reduceOnly: true, clientOrderId: closeClientOrderId },
    );
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
  strategyId: string,
  args: {
    symbol: string;
    side: TradeSide;
    masterContracts: number;
    avgPrice: number;
    masterFillKey: string;
  },
): Promise<void> {
  if (!(await assertStrategyActiveForCopy(prisma, strategyId))) {
    return;
  }

  const futureHedgeId = await resolveFutureHedgeStrategyId(prisma);
  if (!futureHedgeId || strategyId !== futureHedgeId) {
    console.log(
      `[tradeEngine] Ignoring master open fill for non-Future-Hedge strategyId=${strategyId}`,
    );
    return;
  }

  await syncMasterOpenFillToFutureHedgeFollowers(prisma, {
    symbol: args.symbol,
    side: args.side,
    masterLots: args.masterContracts,
    avgPrice: args.avgPrice,
    masterFillKey: args.masterFillKey,
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
): Promise<void> {
  if (!(await assertStrategyActiveForCopy(prisma, strategyId))) {
    return;
  }

  const futureHedgeId = await resolveFutureHedgeStrategyId(prisma);
  if (!futureHedgeId || strategyId !== futureHedgeId) {
    console.log(
      `[tradeEngine] Ignoring master flat for non-Future-Hedge strategyId=${strategyId}`,
    );
    return;
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
    await syncMasterCloseToFutureHedgeFollowers(
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
  } finally {
    consumeBotInitiatedCloseReason(strategyId, snap.symbol);
  }
}

/** Close all follower books after REST master auto-exit (WS may lag). */
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
    await notifyMasterFlat(
      prisma,
      strategyId,
      {
        symbol: leg.symbolKey,
        side: leg.side,
        masterContracts: leg.contracts,
        masterEntryPrice: leg.entryPrice,
      },
      { exitReason },
    );
  }
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
  /** Serializes WS handlers so fills/closes for this strategy never overlap. */
  private messageChain: Promise<void> = Promise.resolve();
  /** Last non-zero position per product (for closed detection). */
  private readonly lastPositionContracts = new Map<string, number>();
  private readonly lastOpenMeta = new Map<string, LastOpenMeta>();

  constructor(
    private readonly prisma: PrismaClient,
    readonly strategyId: string,
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
        const aliases = symbolAliasSet(m.deltaSymbol);
        for (const k of aliases) {
          this.lastPositionContracts.set(k, m.masterContracts);
          this.lastOpenMeta.set(k, {
            symbol: m.deltaSymbol,
            side: m.side,
            contracts: m.masterContracts,
            avgEntry: Number.isFinite(m.entryPrice) ? m.entryPrice : 0,
          });
        }
      }
      console.log(
        `[tradeEngine] seeded ${masters.length} master open positions strategyId=${this.strategyId} keys=${JSON.stringify(
          Array.from(this.lastOpenMeta.keys()),
        )}`,
      );
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

    if (
      type === "success" &&
      String(msg.message ?? "").toLowerCase().includes("authenticated")
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
      void this.seedPositionMapsFromRest();
      return;
    }

    if (type === "orders") {
      if (!(await assertStrategyActiveForCopy(this.prisma, this.strategyId))) {
        return;
      }

      const records: unknown[] = [];
      const data = asRecord(msg.data);
      if (data) {
        const open = Array.isArray(data.open) ? data.open : [];
        const closed = Array.isArray(data.closed) ? data.closed : [];
        records.push(...open, ...closed);
      }
      if (records.length === 0) records.push(parsed);

      for (const r of records) {
        const sig = extractOrderFillSignal(r);
        if (!sig || sig.reduceOnly) continue;
        registerSymbolsForLivePrices([sig.symbol]);
        await copyMasterFillToSubscribers(this.prisma, this.strategyId, {
          symbol: sig.symbol,
          side: sig.side,
          masterContracts: sig.contracts,
          avgPrice: sig.avgPrice,
          masterFillKey: sig.fillKey,
        });
      }
      return;
    }

    if (type === "positions") {
      const merged = mergePayloadLayers(parsed);
      const action = String(msg.action ?? "").toLowerCase();

      const copyEnabled = await assertStrategyActiveForCopy(
        this.prisma,
        this.strategyId,
      );

      // Build the union of alias keys that should map to a tracked position
      // — both the raw symbol (ETHUSD), the USDT-suffix variant (ETHUSDT)
      // and the numeric `product_id` (so WS deletes that omit the symbol
      // string still resolve a tracked entry).
      const aliasesForSnap = (snap: {
        symbol: string;
        productKey: string;
      }): string[] => {
        const out = new Set<string>();
        for (const a of symbolAliasSet(snap.symbol)) out.add(a);
        if (snap.productKey) {
          out.add(snap.productKey);
          out.add(snap.productKey.toUpperCase());
        }
        return Array.from(out).filter(Boolean);
      };

      const writeTracked = (
        snap: {
          symbol: string;
          side: TradeSide;
          contracts: number;
          avgEntry: number | null;
          productKey: string;
        },
        contracts: number,
      ): void => {
        const aliases = aliasesForSnap(snap);
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
      };

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
          writeTracked(snap, snap.contracts);
          n += 1;
        }
        console.log(
          `[tradeEngine WS] positions snapshot processed ${n} rows strategyId=${this.strategyId} keys=${JSON.stringify(
            Array.from(this.lastOpenMeta.keys()),
          )}`,
        );
        return;
      }

      // ---- DELETE / CLOSE: WS event is authoritative; do NOT depend on REST ----
      if (action === "delete" || action === "closed") {
        if (!copyEnabled) {
          return;
        }

        const rows = collectRows();
        const tryPayloadClose = async (): Promise<boolean> => {
          let closed = 0;
          for (const r of rows) {
            const item = mergePayloadLayers(r);
            const symbol = extractDeltaProductSymbol(item);
            const productKey = String(item.product_id ?? "").trim();

            const candidateKeys = new Set<string>();
            for (const a of symbolAliasSet(symbol)) candidateKeys.add(a);
            if (productKey) {
              candidateKeys.add(productKey);
              candidateKeys.add(productKey.toUpperCase());
            }

            let hitMeta: LastOpenMeta | undefined;
            let hitContracts = 0;
            for (const k of candidateKeys) {
              const m = this.lastOpenMeta.get(k);
              if (m) {
                hitMeta = m;
                hitContracts = Math.max(
                  hitContracts,
                  this.lastPositionContracts.get(k) ?? m.contracts,
                );
              }
            }
            if (!hitMeta || hitContracts <= 0) continue;

            console.log(
              `[EXECUTION] Position delete payload matched ${hitMeta.symbol} (${hitContracts} contracts). Triggering follower exits.`,
            );
            await notifyMasterFlat(this.prisma, this.strategyId, {
              symbol: hitMeta.symbol,
              side: hitMeta.side,
              masterEntryPrice:
                Number.isFinite(hitMeta.avgEntry) && hitMeta.avgEntry > 0
                  ? hitMeta.avgEntry
                  : 0,
              masterContracts: hitContracts,
            });
            // wipe every alias of the closed symbol
            for (const a of symbolAliasSet(hitMeta.symbol)) {
              this.lastPositionContracts.delete(a);
              this.lastOpenMeta.delete(a);
            }
            for (const k of candidateKeys) {
              this.lastPositionContracts.delete(k);
              this.lastOpenMeta.delete(k);
            }
            closed += 1;
          }
          return closed > 0;
        };

        const closeAllTracked = async (
          reason: string,
        ): Promise<void> => {
          // de-dupe by symbol so we don't fire the same close twice when
          // a position is registered under multiple alias keys.
          const fired = new Set<string>();
          const entries = Array.from(this.lastOpenMeta.entries());
          if (entries.length === 0) {
            console.warn(
              `[tradeEngine WS] ${reason} but no tracked positions to close strategyId=${this.strategyId}`,
            );
            return;
          }
          for (const [, meta] of entries) {
            const sigKey = `${meta.symbol}:${meta.side}`;
            if (fired.has(sigKey)) continue;
            fired.add(sigKey);
            const lastContracts = Math.max(
              meta.contracts,
              ...Array.from(symbolAliasSet(meta.symbol)).map(
                (a) => this.lastPositionContracts.get(a) ?? 0,
              ),
            );
            if (lastContracts <= 0) continue;
            console.log(
              `[EXECUTION] ${reason} — forcing close for ${meta.symbol} ${meta.side} (${lastContracts} contracts).`,
            );
            await notifyMasterFlat(this.prisma, this.strategyId, {
              symbol: meta.symbol,
              side: meta.side,
              masterEntryPrice:
                Number.isFinite(meta.avgEntry) && meta.avgEntry > 0
                  ? meta.avgEntry
                  : 0,
              masterContracts: lastContracts,
            });
            for (const a of symbolAliasSet(meta.symbol)) {
              this.lastPositionContracts.delete(a);
              this.lastOpenMeta.delete(a);
            }
          }
        };

        console.log(
          `[tradeEngine WS] positions delete strategyId=${this.strategyId} payload=${JSON.stringify(
            msg.data ?? null,
          )} trackedKeys=${JSON.stringify(Array.from(this.lastOpenMeta.keys()))}`,
        );

        const matched = await tryPayloadClose();
        if (!matched) {
          // WS told us a position was deleted but our payload-key lookup
          // didn't resolve a tracked entry. Treat the WS signal as
          // authoritative and close every locally-tracked position.
          await closeAllTracked(
            "delete signal without payload match",
          );
        }
        return;
      }

      // ---- CREATE / UPDATE / GENERIC POSITION ROW ----
      const rows = collectRows();
      for (const r of rows) {
        const snap = extractPositionSnapshot(r);
        if (!snap) continue;

        const aliases = aliasesForSnap(snap);
        let prev = 0;
        let meta: LastOpenMeta | undefined;
        for (const k of aliases) {
          const c = this.lastPositionContracts.get(k) ?? 0;
          if (c > prev) prev = c;
          const m = this.lastOpenMeta.get(k);
          if (!meta && m) meta = m;
        }
        const next = snap.contracts;

        if (next <= 0 && prev > 0) {
          const closeMeta = meta ?? {
            symbol: snap.symbol,
            side: snap.side,
            contracts: prev,
            avgEntry: snap.avgEntry ?? 0,
          };
          if (copyEnabled) {
            console.log(
              `[EXECUTION] Position update -> 0 detected ${closeMeta.symbol} ${closeMeta.side} (${prev} contracts). Triggering follower exits.`,
            );
            await notifyMasterFlat(this.prisma, this.strategyId, {
              symbol: closeMeta.symbol,
              side: closeMeta.side,
              masterEntryPrice:
                Number.isFinite(closeMeta.avgEntry) && closeMeta.avgEntry > 0
                  ? closeMeta.avgEntry
                  : 0,
              masterContracts: prev,
            });
          }
          for (const a of symbolAliasSet(closeMeta.symbol)) {
            this.lastPositionContracts.delete(a);
            this.lastOpenMeta.delete(a);
          }
          for (const k of aliases) {
            this.lastPositionContracts.delete(k);
            this.lastOpenMeta.delete(k);
          }
          continue;
        }

        if (next > 0) {
          registerSymbolsForLivePrices([snap.symbol]);
          writeTracked(snap, next);
          console.log(
            `[tradeEngine WS] tracked ${snap.symbol} ${snap.side} ${next} contracts (keys=${JSON.stringify(aliases)})`,
          );
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
  const sockets = new Map<string, StrategyMasterSocket>();
  let rosterTimeout: ReturnType<typeof setTimeout> | null = null;
  let reconcileTimeout: ReturnType<typeof setTimeout> | null = null;
  let qtyReconcileTimeout: ReturnType<typeof setTimeout> | null = null;
  let autoExitTimeout: ReturnType<typeof setTimeout> | null = null;

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
          const conn = new StrategyMasterSocket(prisma, id);
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
   * SAFETY-NET reconciliation: every {@link SAFETY_RECONCILE_MS} we fetch
   * each master's open positions via REST and compare them against the
   * subscriber-side `Trade.status = OPEN` rows. Any DB OPEN trade whose
   * symbol no longer appears in the master's positions is force-closed
   * on the follower exchange (reduceOnly market) and marked CLOSED in
   * the DB. This catches every WS delete that was missed (cold start,
   * out-of-order events, transient WS drops, etc.).
   *
   * This deliberately runs even if the WS path is healthy — it is
   * idempotent: trades already CLOSED are skipped, and master positions
   * still open are skipped. If the master REST call itself fails (e.g.
   * `invalid_api_key`), we simply log and move on; we never close trades
   * based on REST failure alone.
   */
  async function reconcileGhostExits(): Promise<void> {
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
          profitShare: true,
        },
      });
      if (!strat) return;

      if (!strat.masterApiKey?.trim() || !strat.masterApiSecret?.trim()) {
        return;
      }

      const activeSubs = await findActiveFutureHedgeCopySubscribers(prisma);
      const activeUserIds = new Set(activeSubs.map((s) => s.userId));

      let masterAliases: Set<string>;
      try {
        const masters = await fetchMasterOpenPositions(
          strat.masterApiKey,
          strat.masterApiSecret,
        );
        masterAliases = new Set<string>();
        for (const m of masters) {
          for (const a of symbolAliasSet(m.deltaSymbol)) {
            masterAliases.add(a);
          }
        }
      } catch (err) {
        console.warn(
          `[reconcile] master REST failed strategyId=${strat.id}; skipping safety-net pass:`,
          err instanceof Error ? err.message : err,
        );
        return;
      }

      const openTrades = await prisma.trade.findMany({
          where: {
            strategyId: strat.id,
            status: TradeStatus.OPEN,
          },
          include: {
            user: {
              include: {
                deltaApiKeys: true,
                exchangeAccounts: {
                  orderBy: { createdAt: "desc" },
                  take: 1,
                },
              },
            },
          },
        });

        for (const trade of openTrades) {
          if (cancelled.value) return;
          if (!activeUserIds.has(trade.userId)) {
            continue;
          }
          const tradeAliases = symbolAliasSet(trade.symbol);
          const stillOpen = Array.from(tradeAliases).some((a) =>
            masterAliases.has(a),
          );
          if (stillOpen) continue;

          const sub = activeSubs.find((s) => s.userId === trade.userId);

          const creds =
            sub?.exchangeAccount != null
              ? {
                  apiKey: sub.exchangeAccount.apiKey,
                  apiSecret: sub.exchangeAccount.apiSecret,
                }
              : trade.user.exchangeAccounts?.[0] != null
                ? {
                    apiKey: trade.user.exchangeAccounts[0]!.apiKey,
                    apiSecret: trade.user.exchangeAccounts[0]!.apiSecret,
                  }
                : trade.user.deltaApiKeys?.[0] != null
                  ? {
                      apiKey: trade.user.deltaApiKeys[0]!.apiKey,
                      apiSecret: trade.user.deltaApiKeys[0]!.apiSecret,
                    }
                  : null;

          const oppositeSide: TradeSide =
            String(trade.side).toUpperCase() === "BUY" ? "SELL" : "BUY";
          const followerContracts = Math.max(1, Math.floor(trade.size));

          if (creds) {
            console.log(
              `[reconcile] master no longer holds ${trade.symbol} but DB has OPEN trade for user ${trade.userId} — firing reduceOnly close ${oppositeSide} ${followerContracts}`,
            );
            const result = await executeTrade(
              creds.apiKey,
              creds.apiSecret,
              trade.symbol,
              oppositeSide,
              followerContracts,
              { reduceOnly: true },
            );
            if (!result.success) {
              console.error(
                `[reconcile] follower close failed userId=${trade.userId} symbol=${trade.symbol}: ${result.error ?? "unknown"}`,
              );
              // still mark CLOSED below — exchange may already be flat
            }
          } else {
            console.warn(
              `[reconcile] no creds to close ghost trade for user ${trade.userId} ${trade.symbol}; marking DB CLOSED only`,
            );
          }

          let exitPrice = trade.entryPrice;
          try {
            const tick = await fetchDeltaTicker(trade.symbol);
            if (tick.last != null && Number.isFinite(tick.last)) {
              exitPrice = tick.last;
            }
          } catch {
            /* keep entryPrice fallback */
          }

          const tradeSide: TradeSide =
            String(trade.side).toUpperCase() === "BUY" ? "BUY" : "SELL";
          const pnl = await realizedPnlUsd({
            symbol: trade.symbol,
            side: tradeSide,
            entryPrice: trade.entryPrice,
            exitPrice,
            contracts: trade.size,
          });
          const totalTradingFee = Math.max(0, Number(trade.tradingFee ?? 0));
          const netPnl = pnl - totalTradingFee;
          const revenueShareAmt = computeRevenueShareAmt(
            netPnl,
            strat.profitShare,
          );

          await prisma.trade.update({
            where: { id: trade.id },
            data: {
              status: TradeStatus.CLOSED,
              exitPrice,
              tradingFee: totalTradingFee,
              pnl: netPnl,
              tradePnl: netPnl,
              revenueShareAmt,
              exitReason: EXIT_REASON.EXTERNAL_DELTA,
            },
          });
        }
    } catch (err) {
      console.error("[reconcile] safety-net pass failed:", err);
    }
  }

  /**
   * Every {@link POSITION_QTY_RECONCILE_MS}, compare each follower's live Delta
   * leg size to `masterContracts × multiplier` and market-adjust the difference.
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

          if (subscriptionSyncBlocksReconcile(sub.syncStatus)) {
            continue;
          }

          const creds = resolveSubscriptionCreds(sub);
          if (!creds) {
            console.warn(
              `[RECONCILE] skip userId=${sub.userId} strategyId=${strat.id} — no API credentials`,
            );
            continue;
          }

          let followerPositions: DeltaLivePosition[];
          try {
            followerPositions = await fetchDeltaOpenPositions(
              creds.apiKey,
              creds.apiSecret,
            );
          } catch (err) {
            console.warn(
              `[RECONCILE] follower REST failed userId=${sub.userId} strategyId=${strat.id}:`,
              err instanceof Error ? err.message : err,
            );
            continue;
          }

          for (const master of masterLegs) {
            if (cancelled.value) return;

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
                `[RECONCILE] Adjusting position for user ${sub.userId} on ${master.deltaSymbol}: expected ${expectedContracts}, actual ${actualContracts}. Diff: +${diff} (${master.side})`,
              );
              const result = await executeTrade(
                creds.apiKey,
                creds.apiSecret,
                master.deltaSymbol,
                master.side,
                diff,
              );
              if (!result.success) {
                console.error(
                  `[RECONCILE] catch-up failed userId=${sub.userId} symbol=${master.deltaSymbol} diff=${diff}: ${result.error ?? "unknown"}`,
                );
                await markSubscriptionSyncFailed(prisma, {
                  userId: sub.userId,
                  strategyId: strat.id,
                  error: result.error ?? "Reconcile catch-up failed",
                });
              }
              continue;
            }

            const diff = actualContracts - expectedContracts;
            const trimSide: TradeSide =
              master.side === "BUY" ? "SELL" : "BUY";
            console.log(
              `[RECONCILE] Adjusting position for user ${sub.userId} on ${master.deltaSymbol}: expected ${expectedContracts}, actual ${actualContracts}. Diff: -${diff} (${trimSide} reduceOnly)`,
            );
            const result = await executeTrade(
              creds.apiKey,
              creds.apiSecret,
              master.deltaSymbol,
              trimSide,
              diff,
              { reduceOnly: true },
            );
            if (!result.success) {
              console.error(
                `[RECONCILE] trim failed userId=${sub.userId} symbol=${master.deltaSymbol} diff=${diff}: ${result.error ?? "unknown"}`,
              );
              await markSubscriptionSyncFailed(prisma, {
                userId: sub.userId,
                strategyId: strat.id,
                error: result.error ?? "Reconcile trim failed",
              });
            }
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

  return () => {
    cancelled.value = true;
    stopLivePriceTracker();
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
