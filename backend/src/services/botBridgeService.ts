import type { PrismaClient } from "@prisma/client";

const BOT_BASE_URL = "http://127.0.0.1:8000";
const BOT_TIMEOUT_MS = 10_000;

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
 * Sets is_active=false on the slave account.
 */
export async function pauseUserOnBot(args: {
  botSlaveId: number;
}): Promise<BotSlaveResult> {
  const result = await botFetch(
    `/api/slave/accounts/${args.botSlaveId}/toggle`,
    { method: "POST" },
  );

  // toggle returns current state — check is_active became false
  if (result.ok && result.data && typeof result.data === "object") {
    const d = result.data as Record<string, unknown>;
    const isActive = Boolean(d.is_active);
    if (!isActive) {
      console.log(`[BotBridge] Paused slave botSlaveId=${args.botSlaveId}`);
      return { success: true };
    }
    // Was already paused, toggled back to active — toggle again to re-pause
    const retry = await botFetch(
      `/api/slave/accounts/${args.botSlaveId}/toggle`,
      { method: "POST" },
    );
    if (retry.ok) {
      console.log(`[BotBridge] Re-paused slave botSlaveId=${args.botSlaveId}`);
      return { success: true };
    }
  }

  console.error(`[BotBridge] pauseUserOnBot failed for botSlaveId=${args.botSlaveId}`);
  return { success: false, error: "Toggle failed" };
}

/**
 * Resume copy trading for a user on the bot (subscription re-activated).
 * Sets is_active=true on the slave account.
 */
export async function resumeUserOnBot(args: {
  botSlaveId: number;
}): Promise<BotSlaveResult> {
  // First check current state
  const checkResult = await botFetch("/api/slave/accounts", { method: "GET" });
  if (checkResult.ok && Array.isArray(checkResult.data)) {
    const slave = (checkResult.data as Array<Record<string, unknown>>).find(
      (s) => s.id === args.botSlaveId,
    );
    if (slave && Boolean(slave.is_active) === true) {
      // Already active
      return { success: true };
    }
  }

  const result = await botFetch(
    `/api/slave/accounts/${args.botSlaveId}/toggle`,
    { method: "POST" },
  );

  if (result.ok) {
    console.log(`[BotBridge] Resumed slave botSlaveId=${args.botSlaveId}`);
    return { success: true };
  }

  console.error(`[BotBridge] resumeUserOnBot failed for botSlaveId=${args.botSlaveId}`);
  return { success: false, error: "Toggle failed" };
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
export async function updateUserCapitalOnBot(args: {
  botSlaveId: number;
  userAllocatedCapitalUsd: number;
}): Promise<BotSlaveResult> {
  const result = await botFetch(
    `/api/slave/accounts/${args.botSlaveId}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        user_allocated_capital: args.userAllocatedCapitalUsd,
      }),
    },
  );

  if (result.ok) {
    console.log(
      `[BotBridge] Updated capital botSlaveId=${args.botSlaveId} capital=$${args.userAllocatedCapitalUsd}`,
    );
    return { success: true };
  }

  console.error(`[BotBridge] updateUserCapitalOnBot failed for botSlaveId=${args.botSlaveId}`);
  return { success: false, error: String(result.status) };
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
