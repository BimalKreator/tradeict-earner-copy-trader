import type { PrismaClient } from "@prisma/client";
import { initializeDeltaClient } from "./exchangeService.js";

const BOT_BASE_URL = "http://127.0.0.1:8000";
const BOT_TIMEOUT_MS = 10_000;

/** Why Delta / bot key validation rejected a connect attempt. */
export type DeltaKeyFailureReason =
  | "bad_key"
  | "ip_not_whitelisted"
  | "read_only"
  | "unreachable"
  | "unknown";

export type DeltaKeyValidationResult =
  | { ok: true }
  | {
      ok: false;
      reason: DeltaKeyFailureReason;
      error: string;
      status: number;
    };

/**
 * Harness-only overrides so scenarios can mock the bot without live Delta calls.
 * Production code paths leave this empty.
 */
export type BotBridgeHarnessHooks = {
  validateDeltaKeysForTrading?: (
    apiKey: string,
    apiSecret: string,
  ) => Promise<DeltaKeyValidationResult>;
  pauseUserOnBot?: (args: { botSlaveId: number }) => Promise<BotSlaveResult>;
  resumeUserOnBot?: (args: { botSlaveId: number }) => Promise<BotSlaveResult>;
  updateUserCapitalOnBot?: (args: {
    botSlaveId: number;
    userAllocatedCapitalUsd: number;
  }) => Promise<BotSlaveResult>;
  closeSlaveStructure?: (args: {
    botSlaveId: number;
    userId: string;
    reason: string;
  }) => Promise<CloseSlaveStructureResult>;
  ensureBotSlaveForSubscription?: (args: {
    userId: string;
    strategyId: string;
    subscriptionId: string;
    apiKey: string;
    apiSecret: string;
    userAllocatedCapitalUsd: number;
  }) => Promise<number | null>;
};

let harnessHooks: BotBridgeHarnessHooks = {};

export function installBotBridgeHarnessHooks(
  hooks: BotBridgeHarnessHooks,
): void {
  harnessHooks = { ...hooks };
}

export function resetBotBridgeHarnessHooks(): void {
  harnessHooks = {};
}

export function classifyDeltaKeyFailure(message: string): DeltaKeyFailureReason {
  const lower = message.toLowerCase();
  if (
    lower.includes("ip_not_whitelisted") ||
    lower.includes("ip_blocked") ||
    lower.includes("ip whitelist") ||
    lower.includes("not whitelisted")
  ) {
    return "ip_not_whitelisted";
  }
  if (
    lower.includes("invalid_api_key") ||
    lower.includes("invalid api key") ||
    lower.includes("authentication") ||
    lower.includes("signature")
  ) {
    return "bad_key";
  }
  if (
    lower.includes("read only") ||
    lower.includes("read-only") ||
    lower.includes("readonly") ||
    lower.includes("trading permission") ||
    lower.includes("permission") ||
    lower.includes("not authorized") ||
    lower.includes("forbidden") ||
    lower.includes("unauthorized")
  ) {
    return "read_only";
  }
  return "unknown";
}

export function userFacingDeltaKeyError(reason: DeltaKeyFailureReason): string {
  switch (reason) {
    case "bad_key":
      return "Invalid Delta API key or secret.";
    case "ip_not_whitelisted":
      return "This server IP is not whitelisted for your Delta API key.";
    case "read_only":
      return "Delta API key is read-only — enable Trading permission.";
    case "unreachable":
      return "Could not reach Delta Exchange to validate API keys.";
    default:
      return "Delta API key validation failed.";
  }
}

function isTradingCapabilityError(message: string): boolean {
  const reason = classifyDeltaKeyFailure(message);
  return (
    reason === "bad_key" ||
    reason === "ip_not_whitelisted" ||
    reason === "read_only"
  );
}

/**
 * Auth + trading probe against Delta India.
 * Read-only keys that can fetch balances still fail the order probe.
 */
async function validateDeltaKeysForTradingImpl(
  apiKey: string,
  apiSecret: string,
): Promise<DeltaKeyValidationResult> {
  const key = apiKey.trim();
  const secret = apiSecret.trim();
  if (!key || !secret) {
    return {
      ok: false,
      reason: "bad_key",
      error: userFacingDeltaKeyError("bad_key"),
      status: 400,
    };
  }

  try {
    const exchange = initializeDeltaClient(key, secret);
    await exchange.loadMarkets();
    await exchange.fetchBalance();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err ?? "");
    if (/aborted|econnrefused|enotfound|timed?\s*out|network/i.test(message)) {
      return {
        ok: false,
        reason: "unreachable",
        error: userFacingDeltaKeyError("unreachable"),
        status: 502,
      };
    }
    const reason = classifyDeltaKeyFailure(message);
    return {
      ok: false,
      reason,
      error: userFacingDeltaKeyError(reason),
      status: 400,
    };
  }

  // Orders require Trading permission. A far-from-market limit on a bogus product
  // must not fill; permission errors mean read-only, other rejections mean the key can trade.
  try {
    const exchange = initializeDeltaClient(key, secret);
    const privatePost = (
      exchange as {
        privatePostOrders?: (params: Record<string, unknown>) => Promise<unknown>;
      }
    ).privatePostOrders;
    if (typeof privatePost !== "function") {
      // Fallback: if CCXT path missing, treat balance success as insufficient —
      // refuse rather than accept a key we cannot prove can trade.
      return {
        ok: false,
        reason: "unknown",
        error: "Unable to verify trading permission on this Delta key.",
        status: 400,
      };
    }
    await privatePost.call(exchange, {
      product_id: 1,
      size: 1,
      side: "buy",
      order_type: "limit_order",
      limit_price: "0.0001",
      time_in_force: "gtc",
    });
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err ?? "");
    if (isTradingCapabilityError(message)) {
      const reason = classifyDeltaKeyFailure(message);
      return {
        ok: false,
        reason,
        error: userFacingDeltaKeyError(reason),
        status: 400,
      };
    }
    // invalid product / margin / price / etc. ⇒ trading endpoint accepted the auth
    return { ok: true };
  }
}

export async function validateDeltaKeysForTrading(
  apiKey: string,
  apiSecret: string,
): Promise<DeltaKeyValidationResult> {
  if (harnessHooks.validateDeltaKeysForTrading) {
    return harnessHooks.validateDeltaKeysForTrading(apiKey, apiSecret);
  }
  return validateDeltaKeysForTradingImpl(apiKey, apiSecret);
}

/** Short label from UUID — first 8 chars */
function shortId(id: string): string {
  return id.replace(/-/g, "").slice(0, 8);
}

/** Unique slave name for this earner user+strategy combo */
function slaveName(userId: string, strategyId: string): string {
  return `earner_${shortId(userId)}_${shortId(strategyId)}`;
}

async function botFetch(
  path: string,
  options: RequestInit = {},
): Promise<{ ok: boolean; status: number; data: unknown }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BOT_TIMEOUT_MS);
    const res = await fetch(`${BOT_BASE_URL}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers ?? {}),
      },
    });
    clearTimeout(timer);
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    console.error(`[BotBridge] fetch ${path} failed:`, err);
    return { ok: false, status: 0, data: null };
  }
}

export type BotSlaveResult = {
  success: boolean;
  botSlaveId?: number | undefined;
  error?: string | undefined;
};

export type CloseSlaveStructureResult = {
  success: boolean;
  status: number;
  blocked?: boolean;
  error?: string;
  failedBaskets?: number[];
  counts?: Record<string, unknown>;
};

function parseFailedBaskets(data: unknown): number[] {
  if (data == null || typeof data !== "object") return [];
  const d = data as Record<string, unknown>;
  const raw = d.failed_baskets ?? d.failedBaskets ?? d.failed_basket_ids;
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is number => typeof x === "number");
}

function parseCloseCounts(data: unknown): Record<string, unknown> | undefined {
  if (data == null || typeof data !== "object") return undefined;
  return data as Record<string, unknown>;
}

/**
 * Register a new Earner user as a slave on the Delta Bot.
 * Called when user subscribes to a bot-type strategy and connects API keys.
 *
 * @param apiKey - User's Delta Exchange API key (decrypted)
 * @param apiSecret - User's Delta Exchange API secret (decrypted)
 * @param userId - Earner user ID
 * @param strategyId - Earner strategy ID
 * @param subscriptionId - Earner subscription ID
 * @param userAllocatedCapitalUsd - Capital user assigned to this strategy (USD)
 */
export async function registerUserWithBot(args: {
  apiKey: string;
  apiSecret: string;
  userId: string;
  strategyId: string;
  subscriptionId: string;
  userAllocatedCapitalUsd: number;
}): Promise<BotSlaveResult> {
  const name = slaveName(args.userId, args.strategyId);

  const payload = {
    name,
    api_key: args.apiKey,
    api_secret: args.apiSecret,
    qty_multiplier: 1.0,           // ignored when capital_based_qty=true
    capital_based_qty: true,
    user_allocated_capital: args.userAllocatedCapitalUsd,
    earner_user_id: args.userId,
    earner_subscription_id: args.subscriptionId,
    is_active: true,
  };

  const result = await botFetch("/api/slave/accounts", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  if (result.ok && result.data && typeof result.data === "object") {
    const d = result.data as Record<string, unknown>;
    const botSlaveId = typeof d.id === "number" ? d.id : undefined;
    console.log(
      `[BotBridge] Registered user=${args.userId} as slave=${name} botSlaveId=${botSlaveId}`,
    );
    return { success: true, botSlaveId };
  }

  const errMsg =
    result.data && typeof result.data === "object"
      ? String((result.data as Record<string, unknown>).detail ?? result.status)
      : String(result.status);

  console.error(`[BotBridge] registerUserWithBot failed: ${errMsg}`);
  return { success: false, error: errMsg };
}

/**
 * Pause copy trading for a user on the bot (subscription paused/cancelled).
 * Idempotent PATCH { is_active: false } — never uses toggle.
 */
async function pauseUserOnBotImpl(args: {
  botSlaveId: number;
}): Promise<BotSlaveResult> {
  const result = await botFetch(`/api/slave/accounts/${args.botSlaveId}`, {
    method: "PATCH",
    body: JSON.stringify({ is_active: false }),
  });

  if (result.ok && result.data && typeof result.data === "object") {
    const d = result.data as Record<string, unknown>;
    if (Boolean(d.is_active) === false) {
      console.log(`[BotBridge] Paused slave botSlaveId=${args.botSlaveId}`);
      return { success: true, botSlaveId: args.botSlaveId };
    }
  }

  if (result.ok) {
    console.log(`[BotBridge] Paused slave botSlaveId=${args.botSlaveId}`);
    return { success: true, botSlaveId: args.botSlaveId };
  }

  console.error(
    `[BotBridge] pauseUserOnBot failed for botSlaveId=${args.botSlaveId}`,
  );
  return { success: false, error: `Pause failed (HTTP ${result.status})` };
}

export async function pauseUserOnBot(args: {
  botSlaveId: number;
}): Promise<BotSlaveResult> {
  if (harnessHooks.pauseUserOnBot) {
    return harnessHooks.pauseUserOnBot(args);
  }
  return pauseUserOnBotImpl(args);
}

/**
 * Resume copy trading for a user on the bot (subscription re-activated).
 * Idempotent PATCH { is_active: true } — never uses toggle.
 */
async function resumeUserOnBotImpl(args: {
  botSlaveId: number;
}): Promise<BotSlaveResult> {
  const result = await botFetch(`/api/slave/accounts/${args.botSlaveId}`, {
    method: "PATCH",
    body: JSON.stringify({ is_active: true }),
  });

  if (result.ok && result.data && typeof result.data === "object") {
    const d = result.data as Record<string, unknown>;
    if (Boolean(d.is_active) === true) {
      console.log(`[BotBridge] Resumed slave botSlaveId=${args.botSlaveId}`);
      return { success: true, botSlaveId: args.botSlaveId };
    }
  }

  if (result.ok) {
    console.log(`[BotBridge] Resumed slave botSlaveId=${args.botSlaveId}`);
    return { success: true, botSlaveId: args.botSlaveId };
  }

  console.error(
    `[BotBridge] resumeUserOnBot failed for botSlaveId=${args.botSlaveId}`,
  );
  return { success: false, error: `Resume failed (HTTP ${result.status})` };
}

export async function resumeUserOnBot(args: {
  botSlaveId: number;
}): Promise<BotSlaveResult> {
  if (harnessHooks.resumeUserOnBot) {
    return harnessHooks.resumeUserOnBot(args);
  }
  return resumeUserOnBotImpl(args);
}

/**
 * Remove a user from the bot entirely (subscription cancelled permanently).
 * Deletes the slave account from bot DB.
 * Bot will reject if active trades exist — caller must handle.
 */
export async function removeUserFromBot(args: {
  botSlaveId: number;
}): Promise<BotSlaveResult> {
  const result = await botFetch(
    `/api/slave/accounts/${args.botSlaveId}`,
    { method: "DELETE" },
  );

  if (result.ok) {
    console.log(`[BotBridge] Removed slave botSlaveId=${args.botSlaveId}`);
    return { success: true };
  }

  const errMsg =
    result.data && typeof result.data === "object"
      ? String((result.data as Record<string, unknown>).detail ?? result.status)
      : String(result.status);

  console.error(`[BotBridge] removeUserFromBot failed: ${errMsg}`);
  return { success: false, error: errMsg };
}

/**
 * Update user's allocated capital on the bot (when user changes deployed capital).
 */
async function updateUserCapitalOnBotImpl(args: {
  botSlaveId: number;
  userAllocatedCapitalUsd: number;
}): Promise<BotSlaveResult> {
  const result = await botFetch(`/api/slave/accounts/${args.botSlaveId}`, {
    method: "PATCH",
    body: JSON.stringify({
      user_allocated_capital: args.userAllocatedCapitalUsd,
    }),
  });

  if (result.ok) {
    console.log(
      `[BotBridge] Updated capital botSlaveId=${args.botSlaveId} capital=$${args.userAllocatedCapitalUsd}`,
    );
    return { success: true, botSlaveId: args.botSlaveId };
  }

  console.error(
    `[BotBridge] updateUserCapitalOnBot failed for botSlaveId=${args.botSlaveId}`,
  );
  return {
    success: false,
    error: `Capital update failed (HTTP ${result.status})`,
  };
}

export async function updateUserCapitalOnBot(args: {
  botSlaveId: number;
  userAllocatedCapitalUsd: number;
}): Promise<BotSlaveResult> {
  if (harnessHooks.updateUserCapitalOnBot) {
    return harnessHooks.updateUserCapitalOnBot(args);
  }
  return updateUserCapitalOnBotImpl(args);
}

/**
 * Lookup bot slave ID for an earner user+strategy combo.
 * Returns null if not found (user not registered on bot yet).
 */
export async function findBotSlaveId(args: {
  userId: string;
  strategyId: string;
}): Promise<number | null> {
  const name = slaveName(args.userId, args.strategyId);
  const result = await botFetch("/api/slave/accounts", { method: "GET" });

  if (result.ok && Array.isArray(result.data)) {
    const slave = (result.data as Array<Record<string, unknown>>).find(
      (s) => s.name === name,
    );
    if (slave && typeof slave.id === "number") {
      return slave.id;
    }
  }
  return null;
}

/**
 * Called after a user successfully subscribes to a bot-type strategy.
 * Registers user as slave on bot and returns botSlaveId.
 * Returns null if registration fails (non-fatal — subscription still created).
 */
export async function onSubscriptionCreated(args: {
  userId: string;
  strategyId: string;
  subscriptionId: string;
  apiKey: string;
  apiSecret: string;
  userAllocatedCapitalUsd: number;
}): Promise<number | null> {
  const result = await registerUserWithBot({
    apiKey: args.apiKey,
    apiSecret: args.apiSecret,
    userId: args.userId,
    strategyId: args.strategyId,
    subscriptionId: args.subscriptionId,
    userAllocatedCapitalUsd: args.userAllocatedCapitalUsd,
  });
  if (result.success && result.botSlaveId != null) {
    console.log(
      `[BotBridge] onSubscriptionCreated: userId=${args.userId} botSlaveId=${result.botSlaveId}`,
    );
    return result.botSlaveId;
  }
  console.error(
    `[BotBridge] onSubscriptionCreated failed: userId=${args.userId} error=${result.error}`,
  );
  return null;
}

/**
 * Ensure a bot slave exists for this user+strategy subscription.
 * - If slave already exists on the bot, returns its id (caller should persist).
 * - Otherwise registers a new slave via onSubscriptionCreated.
 * Returns null on failure (non-fatal).
 */
async function ensureBotSlaveForSubscriptionImpl(args: {
  userId: string;
  strategyId: string;
  subscriptionId: string;
  apiKey: string;
  apiSecret: string;
  userAllocatedCapitalUsd: number;
}): Promise<number | null> {
  try {
    const existingSlaveId = await findBotSlaveId({
      userId: args.userId,
      strategyId: args.strategyId,
    });
    if (existingSlaveId != null) {
      console.log(
        `[BotBridge] Found existing slave botSlaveId=${existingSlaveId} for userId=${args.userId}`,
      );
      return existingSlaveId;
    }

    return await onSubscriptionCreated({
      userId: args.userId,
      strategyId: args.strategyId,
      subscriptionId: args.subscriptionId,
      apiKey: args.apiKey,
      apiSecret: args.apiSecret,
      userAllocatedCapitalUsd: args.userAllocatedCapitalUsd,
    });
  } catch (err) {
    console.error(
      `[BotBridge] ensureBotSlaveForSubscription failed userId=${args.userId}:`,
      err,
    );
    return null;
  }
}

export async function ensureBotSlaveForSubscription(args: {
  userId: string;
  strategyId: string;
  subscriptionId: string;
  apiKey: string;
  apiSecret: string;
  userAllocatedCapitalUsd: number;
}): Promise<number | null> {
  if (harnessHooks.ensureBotSlaveForSubscription) {
    return harnessHooks.ensureBotSlaveForSubscription(args);
  }
  return ensureBotSlaveForSubscriptionImpl(args);
}

/**
 * Called when subscription is paused (funds insufficient, admin pause, etc.)
 */
export async function onSubscriptionPaused(args: {
  botSlaveId: number;
}): Promise<void> {
  await pauseUserOnBot({ botSlaveId: args.botSlaveId });
}

/**
 * Called when subscription is resumed (user paid, admin resume, etc.)
 */
export async function onSubscriptionResumed(args: {
  botSlaveId: number;
}): Promise<void> {
  await resumeUserOnBot({ botSlaveId: args.botSlaveId });
}

/**
 * Called when subscription is cancelled permanently.
 */
export async function onSubscriptionCancelled(args: {
  botSlaveId: number;
}): Promise<void> {
  await removeUserFromBot({ botSlaveId: args.botSlaveId });
}

/**
 * Close all open baskets and the hedge for a slave, then deactivate it.
 * Idempotent — safe to retry on network failure.
 */
async function closeSlaveStructureImpl(args: {
  botSlaveId: number;
  userId: string;
  reason: string;
}): Promise<CloseSlaveStructureResult> {
  const result = await botFetch(
    `/api/slave/${args.botSlaveId}/close-structure`,
    {
      method: "POST",
      body: JSON.stringify({
        reason: args.reason,
        earner_user_id: args.userId,
      }),
    },
  );

  if (result.status === 0) {
    return {
      success: false,
      status: 0,
      error: "Delta Bot is unreachable. Positions were not closed — try again.",
    };
  }

  if (result.status === 409) {
    const failedBaskets = parseFailedBaskets(result.data);
    const errMsg =
      result.data && typeof result.data === "object"
        ? String(
            (result.data as Record<string, unknown>).detail ??
              "One or more baskets failed to close",
          )
        : "One or more baskets failed to close";
    const blocked: CloseSlaveStructureResult = {
      success: false,
      status: 409,
      blocked: true,
      error: errMsg,
      failedBaskets,
    };
    const counts = parseCloseCounts(result.data);
    if (counts) blocked.counts = counts;
    return blocked;
  }

  if (!result.ok) {
    const errMsg =
      result.data && typeof result.data === "object"
        ? String((result.data as Record<string, unknown>).detail ?? result.status)
        : String(result.status);
    return { success: false, status: result.status, error: errMsg };
  }

  console.log(
    `[BotBridge] close-structure slave=${args.botSlaveId} user=${args.userId} reason=${args.reason}`,
  );
  const success: CloseSlaveStructureResult = {
    success: true,
    status: result.status,
  };
  const counts = parseCloseCounts(result.data);
  if (counts) success.counts = counts;
  return success;
}

export async function closeSlaveStructure(args: {
  botSlaveId: number;
  userId: string;
  reason: string;
}): Promise<CloseSlaveStructureResult> {
  if (harnessHooks.closeSlaveStructure) {
    return harnessHooks.closeSlaveStructure(args);
  }
  return closeSlaveStructureImpl(args);
}

export type LiveBotStructureLeg = {
  role: string;
  strike: number | null;
  entry_price: number | null;
  current_price: number | null;
  quantity: number;
  leg_pnl: number | null;
  status: string;
};

export type LiveBotStructurePnl = {
  hedge_net: number | null;
  short_net: number | null;
  wing_net: number | null;
  basket_net: number | null;
  structure_net: number | null;
  computed_at: string | null;
  stale_seconds: number | null;
  /** Optional pass-through from bot — for gross-vs-net card labels. */
  short_gross: number | null;
  wing_gross: number | null;
  hedge_gross: number | null;
  basket_gross: number | null;
  structure_gross: number | null;
  fees: number | null;
  spread: number | null;
};

export type LiveBotStructure = {
  status: string;
  underlying: string | null;
  expiry_date: string | null;
  basket_number: number | null;
  legs: LiveBotStructureLeg[];
  hedge: Record<string, unknown> | null;
  pnl: LiveBotStructurePnl | null;
  /** Gross leg sums by group — computed from legs[].leg_pnl (display only). */
  group_gross: {
    short: number | null;
    protection: number | null;
    hedge: number | null;
  };
};

export type LiveBotStructureResult =
  | { structure: LiveBotStructure }
  | { structure: null }
  | { structure: null; botUnavailable: true };

function numberOrNull(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const n = typeof value === "number" ? value : parseFloat(String(value));
  return Number.isFinite(n) ? n : null;
}

function parseOverviewLeg(raw: Record<string, unknown>): LiveBotStructureLeg | null {
  const role = typeof raw.role === "string" ? raw.role.trim() : "";
  if (!role) return null;
  return {
    role,
    strike: numberOrNull(raw.strike),
    entry_price: numberOrNull(raw.entry_price),
    current_price: numberOrNull(raw.current_price),
    quantity: Math.trunc(numberOrNull(raw.quantity) ?? 0),
    leg_pnl: numberOrNull(raw.leg_pnl),
    status: typeof raw.status === "string" ? raw.status : "open",
  };
}

function firstNumber(
  raw: Record<string, unknown>,
  keys: string[],
): number | null {
  for (const key of keys) {
    const n = numberOrNull(raw[key]);
    if (n != null) return n;
  }
  return null;
}

function parseOverviewPnl(
  raw: Record<string, unknown> | null,
  tradeExtras?: Record<string, unknown> | null,
): LiveBotStructurePnl | null {
  if (raw == null) return null;
  const extras = tradeExtras ?? {};
  return {
    hedge_net: numberOrNull(raw.hedge_net),
    short_net: numberOrNull(raw.short_net),
    wing_net: numberOrNull(raw.wing_net),
    basket_net: numberOrNull(raw.basket_net),
    structure_net: numberOrNull(raw.structure_net),
    computed_at:
      typeof raw.computed_at === "string" && raw.computed_at.trim().length > 0
        ? raw.computed_at.trim()
        : null,
    stale_seconds: numberOrNull(raw.stale_seconds),
    short_gross: firstNumber(raw, ["short_gross"]),
    wing_gross: firstNumber(raw, ["wing_gross"]),
    hedge_gross: firstNumber(raw, ["hedge_gross"]),
    basket_gross: firstNumber(
      { ...extras, ...raw },
      ["basket_gross", "gross_mtm", "gross"],
    ),
    structure_gross: firstNumber(raw, ["structure_gross"]),
    fees: firstNumber(
      { ...extras, ...raw },
      ["fees", "fees_paid", "total_fees", "est_exit_fees"],
    ),
    spread: firstNumber(
      { ...extras, ...raw },
      [
        "spread",
        "expected_exit_spread_usd",
        "exit_spread_usd",
        "entry_spread_usd",
        "slippage",
        "hedge_est_exit_slippage_usd",
      ],
    ),
  };
}

function sumLegGrossByPrefix(
  legs: LiveBotStructureLeg[],
  prefix: string,
): number | null {
  let sum = 0;
  let any = false;
  for (const leg of legs) {
    if (!leg.role.trim().toLowerCase().startsWith(prefix)) continue;
    if (leg.leg_pnl == null || !Number.isFinite(leg.leg_pnl)) continue;
    sum += leg.leg_pnl;
    any = true;
  }
  return any ? Math.round(sum * 10000) / 10000 : null;
}

/**
 * Live bot structure for the Earner Live Trades page — reads /api/slave/overview
 * (same source BotSync polls). Does not touch Trade / billing tables.
 */
export async function fetchBotSlaveStructureForUser(
  earnerUserId: string,
): Promise<LiveBotStructureResult> {
  const result = await botFetch("/api/slave/overview", { method: "GET" });
  if (!result.ok || result.data == null) {
    console.warn(
      `[BotBridge] slave overview unavailable user=${earnerUserId} status=${result.status}`,
    );
    return { structure: null, botUnavailable: true };
  }

  const payload = result.data as Record<string, unknown>;
  const slaves = Array.isArray(payload.slaves)
    ? (payload.slaves as Record<string, unknown>[])
    : [];
  const want = earnerUserId.trim();
  const match = slaves.find((s) => {
    const id = typeof s.earner_user_id === "string" ? s.earner_user_id.trim() : "";
    return id.length > 0 && id === want;
  });

  if (!match) {
    return { structure: null };
  }

  const active =
    match.active_slave_trade != null &&
    typeof match.active_slave_trade === "object"
      ? (match.active_slave_trade as Record<string, unknown>)
      : null;

  if (!active) {
    return { structure: null };
  }

  const legsRaw = Array.isArray(active.legs) ? active.legs : [];
  const legs: LiveBotStructureLeg[] = [];
  for (const item of legsRaw) {
    if (item == null || typeof item !== "object") continue;
    const leg = parseOverviewLeg(item as Record<string, unknown>);
    if (leg) legs.push(leg);
  }

  const hedge =
    active.hedge != null && typeof active.hedge === "object"
      ? (active.hedge as Record<string, unknown>)
      : null;

  const pnl =
    active.pnl != null && typeof active.pnl === "object"
      ? parseOverviewPnl(active.pnl as Record<string, unknown>, active)
      : null;

  // Prefer bot-provided group gross; otherwise sum legs (same numbers the UI shows).
  const group_gross = {
    short: pnl?.short_gross ?? sumLegGrossByPrefix(legs, "short_"),
    protection: pnl?.wing_gross ?? sumLegGrossByPrefix(legs, "wing_"),
    hedge: pnl?.hedge_gross ?? sumLegGrossByPrefix(legs, "hedge_"),
  };

  const basketNumber = numberOrNull(active.basket_number);

  return {
    structure: {
      status: typeof active.status === "string" ? active.status : "active",
      underlying:
        typeof active.underlying === "string" && active.underlying.trim()
          ? active.underlying.trim()
          : null,
      expiry_date:
        typeof active.expiry_date === "string" && active.expiry_date.trim()
          ? active.expiry_date.trim()
          : hedge &&
              typeof hedge.expiry_date === "string" &&
              hedge.expiry_date.trim()
            ? String(hedge.expiry_date).trim()
            : null,
      basket_number: basketNumber != null ? Math.trunc(basketNumber) : null,
      legs,
      hedge,
      pnl,
      group_gross,
    },
  };
}
