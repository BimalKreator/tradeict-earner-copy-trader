import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { decryptDeltaSecretOrPlain } from "../utils/encryption.js";
import { FUTURE_HEDGE_STRATEGY_TITLE } from "./futureHedgeService.js";
import { findActiveFutureHedgeCopySubscribers } from "./strategySubscriptionService.js";

export function masterApiKeyFingerprint(apiKeyPlain: string): string {
  return createHash("sha256")
    .update(apiKeyPlain.trim())
    .digest("hex")
    .slice(0, 24);
}

type PolicyState = {
  masterFingerprints: Set<string>;
  opensAllowed: boolean;
  blockReason: string;
  refreshedAt: number;
};

const state: PolicyState = {
  masterFingerprints: new Set(),
  opensAllowed: false,
  blockReason: "policy not initialized — master opens denied by default",
  refreshedAt: 0,
};

export function isRegisteredMasterApiKey(apiKeyPlain: string): boolean {
  return state.masterFingerprints.has(masterApiKeyFingerprint(apiKeyPlain));
}

/** Last-resort gate inside {@link executeTrade} — blocks master opens unless policy allows. */
export function assertMasterExchangeOpenAllowed(
  apiKeyPlain: string,
  reduceOnly: boolean,
  bypassPolicy?: boolean,
): { ok: true } | { ok: false; error: string } {
  if (reduceOnly) return { ok: true };
  if (bypassPolicy === true) return { ok: true };
  if (!isRegisteredMasterApiKey(apiKeyPlain)) {
    return { ok: true };
  }
  if (!state.opensAllowed) {
    return {
      ok: false,
      error: state.blockReason || "master auto-opens blocked by policy",
    };
  }
  return { ok: true };
}

export function getMasterOrderPolicySnapshot(): Readonly<PolicyState> {
  return state;
}

/**
 * Recompute whether the Future Hedge master account may place non-reduce-only orders.
 * Runs on an interval from server boot — survives any single engine bug/path.
 */
export async function refreshMasterOrderPolicy(
  prisma: PrismaClient,
): Promise<void> {
  const strategy = await prisma.strategy.findFirst({
    where: { title: FUTURE_HEDGE_STRATEGY_TITLE },
    include: { futureHedgeConfig: true },
  });

  state.masterFingerprints.clear();

  const storedKey = strategy?.masterApiKey?.trim() ?? "";
  if (storedKey) {
    try {
      const plain = decryptDeltaSecretOrPlain(storedKey);
      if (plain) {
        state.masterFingerprints.add(masterApiKeyFingerprint(plain));
      }
    } catch {
      /* decrypt failed — no fingerprint registered */
    }
  }

  const subs = await findActiveFutureHedgeCopySubscribers(prisma);
  const config = strategy?.futureHedgeConfig;
  const strategyActive = strategy?.isActive === true;
  const autoEnabled = config?.isAutoEnabled === true;
  const hasSubs = subs.length > 0;

  if (!strategyActive) {
    state.opensAllowed = false;
    state.blockReason = "strategy paused (isActive=false)";
  } else if (!autoEnabled) {
    state.opensAllowed = false;
    state.blockReason = "Future Hedge isAutoEnabled=false";
  } else if (!hasSubs) {
    state.opensAllowed = false;
    state.blockReason = `no active copy subscribers (${subs.length})`;
  } else {
    state.opensAllowed = true;
    state.blockReason = "ok";
  }

  state.refreshedAt = Date.now();

  if (!hasSubs) {
    try {
      const { enforceNoSubscriberMasterSafety } = await import(
        "./futureHedgeEngine.js"
      );
      await enforceNoSubscriberMasterSafety(prisma);
    } catch (err) {
      console.warn(
        "[master-order-policy] no-subscriber safety failed:",
        err instanceof Error ? err.message : err,
      );
    }
  } else if (!state.opensAllowed && config?.currentBatchId) {
    try {
      const { clearFutureHedgeActiveBatch } = await import(
        "./futureHedgeEngine.js"
      );
      await clearFutureHedgeActiveBatch(prisma, `policy:${state.blockReason}`);
    } catch {
      /* best effort */
    }
  }
}

const POLICY_REFRESH_MS = Number(process.env.MASTER_ORDER_POLICY_REFRESH_MS) || 5_000;

/** Start periodic master open policy refresh (call once from server boot). */
export function startMasterOrderPolicyRefresh(prisma: PrismaClient): () => void {
  let stopped = false;

  const run = async (): Promise<void> => {
    if (stopped) return;
    try {
      await refreshMasterOrderPolicy(prisma);
    } catch (err) {
      console.error(
        "[master-order-policy] refresh failed:",
        err instanceof Error ? err.message : err,
      );
    }
  };

  void run();
  const timer = setInterval(() => {
    void run();
  }, POLICY_REFRESH_MS);

  console.log(
    `[master-order-policy] started refresh every ${POLICY_REFRESH_MS}ms (default deny master opens)`,
  );

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
