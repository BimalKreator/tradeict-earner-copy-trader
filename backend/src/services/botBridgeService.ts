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
