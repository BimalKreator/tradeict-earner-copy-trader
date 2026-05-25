import type { PrismaClient } from "@prisma/client";
import {
  executeTrade,
  fetchDeltaOpenPositions,
  type ExecuteTradeResult,
  type TradeSide,
} from "./exchangeService.js";
import { STRATEGY_SELECT_IS_ACTIVE } from "../prisma/strategySelect.js";
import { logUserActivity } from "./userActivityService.js";

/** Wait after each successful order before re-checking positions. */
const POST_ORDER_VERIFY_WAIT_MS = 3_000;
const MAX_RETRIES = 3;

const HARD_ERROR_PATTERNS = [
  "INSUFFICIENT_MARGIN",
  "INSUFFICIENT_BALANCE",
  "INSUFFICIENT_FUNDS",
  "NOT_ENOUGH_MARGIN",
  "NOT_ENOUGH_BALANCE",
  "ACCOUNT_FROZEN",
  "ACCOUNT_SUSPENDED",
  "MARGIN_CALL",
  "insufficient_margin",
  "insufficient balance",
  "insufficient_balance",
  "account_frozen",
  "account is frozen",
  "frozen account",
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isHardExecutionError(message: string): boolean {
  const u = message.toUpperCase();
  return HARD_ERROR_PATTERNS.some((p) => u.includes(p.toUpperCase()));
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

function symbolsAlign(tradeSymbol: string, positionKey: string): boolean {
  const a = compactSymbolKey(tradeSymbol);
  const b = compactSymbolKey(positionKey);
  if (a === b || a.endsWith(b) || b.endsWith(a)) return true;
  const ba = deltaPairBase(a);
  const bb = deltaPairBase(b);
  return ba != null && bb != null && ba === bb;
}

/** Open leg size in exchange **contract lots** (must match {@link executeTrade} amount). */
async function followerLegContracts(
  apiKeyStored: string,
  apiSecretStored: string,
  symbol: string,
  side: TradeSide,
): Promise<number> {
  const positions = await fetchDeltaOpenPositions(apiKeyStored, apiSecretStored);
  let max = 0;
  for (const p of positions) {
    if (!symbolsAlign(symbol, p.symbolKey)) continue;
    if (p.side !== side) continue;
    const lots = Math.abs(p.contracts);
    if (Number.isFinite(lots) && lots > max) max = lots;
  }
  return max;
}

async function notifyFollowerHardFailure(
  prisma: PrismaClient,
  userId: string,
  symbol: string,
  reason: string,
): Promise<void> {
  console.error(
    `[RETRY_LOOP] Hard error for user ${userId} on ${symbol}: ${reason}`,
  );
  await logUserActivity(prisma, {
    userId,
    kind: "TRADE_EXECUTION_FAILED",
    message: `Copy trade failed for ${symbol}: ${reason}`,
  });
}

export type FollowerExecuteResult = ExecuteTradeResult & {
  attempts: number;
  verified: boolean;
};

/**
 * Execute → wait 3s → verify → retry (up to {@link MAX_RETRIES}).
 * Skips verification for reduce-only closes (caller should use {@link executeTrade}).
 */
export async function executeFollowerTradeWithVerification(
  prisma: PrismaClient,
  args: {
    strategyId?: string;
    userId: string;
    apiKey: string;
    apiSecret: string;
    symbol: string;
    side: TradeSide;
    size: number;
    reduceOnly?: boolean;
  },
): Promise<FollowerExecuteResult> {
  const { userId, apiKey, apiSecret, symbol, side } = args;
  const targetContracts = Math.max(1, Math.floor(args.size));

  if (args.strategyId) {
    const strat = await prisma.strategy.findUnique({
      where: { id: args.strategyId },
      select: STRATEGY_SELECT_IS_ACTIVE,
    });
    if (!strat?.isActive) {
      return {
        success: false,
        error: "Strategy is paused",
        attempts: 0,
        verified: false,
      };
    }
  }

  if (args.reduceOnly === true) {
    const single = await executeTrade(apiKey, apiSecret, symbol, side, targetContracts, {
      reduceOnly: true,
    });
    return { ...single, attempts: 1, verified: single.success };
  }

  const minFilled = targetContracts * 0.9;
  let totalFee = 0;
  let lastResult: ExecuteTradeResult = {
    success: false,
    error: "no execution attempt",
  };
  let attempts = 0;

  for (let retry = 0; retry < MAX_RETRIES; retry += 1) {
    const existingBefore = await followerLegContracts(
      apiKey,
      apiSecret,
      symbol,
      side,
    );
    if (existingBefore >= minFilled) {
      console.log(
        `[RETRY_LOOP] Already filled (${existingBefore}/${targetContracts} contracts) before attempt ${retry + 1}.`,
      );
      return {
        success: true,
        ...(lastResult.orderId != null ? { orderId: lastResult.orderId } : {}),
        feeCost: totalFee,
        ...(lastResult.raw !== undefined ? { raw: lastResult.raw } : {}),
        attempts: Math.max(attempts, 1),
        verified: true,
      };
    }

    const orderSize = Math.max(
      1,
      targetContracts - Math.floor(existingBefore),
    );

    attempts += 1;
    console.log(
      `[RETRY_LOOP] Execute attempt ${retry + 1}/${MAX_RETRIES} user ${userId} ${symbol} — orderSize=${orderSize} (existing=${existingBefore}, target=${targetContracts})`,
    );

    lastResult = await executeTrade(apiKey, apiSecret, symbol, side, orderSize);

    if (lastResult.feeCost != null && Number.isFinite(lastResult.feeCost)) {
      totalFee += lastResult.feeCost;
    }

    if (!lastResult.success) {
      const err = lastResult.error ?? "unknown";
      console.warn(
        `[RETRY_LOOP] executeTrade failed attempt ${retry + 1}/${MAX_RETRIES}: ${err}`,
      );
      if (isHardExecutionError(err)) {
        await notifyFollowerHardFailure(prisma, userId, symbol, err);
        return {
          ...lastResult,
          feeCost: totalFee,
          attempts,
          verified: false,
        };
      }
      continue;
    }

    console.log(
      `[RETRY_LOOP] Order accepted; waiting ${POST_ORDER_VERIFY_WAIT_MS}ms before verify (user ${userId}, ${symbol})`,
    );
    await sleep(POST_ORDER_VERIFY_WAIT_MS);

    const existingAfter = await followerLegContracts(
      apiKey,
      apiSecret,
      symbol,
      side,
    );
    if (existingAfter >= minFilled) {
      console.log(
        `[RETRY_LOOP] Verified after wait (${existingAfter}/${targetContracts} contracts) on attempt ${retry + 1}.`,
      );
      return {
        success: true,
        ...(lastResult.orderId != null ? { orderId: lastResult.orderId } : {}),
        feeCost: totalFee,
        ...(lastResult.raw !== undefined ? { raw: lastResult.raw } : {}),
        attempts,
        verified: true,
      };
    }

    console.log(
      `[RETRY_LOOP] Position not visible yet (${existingAfter}/${targetContracts} contracts) after ${POST_ORDER_VERIFY_WAIT_MS}ms — will retry if attempts remain.`,
    );
  }

  const finalContracts = await followerLegContracts(
    apiKey,
    apiSecret,
    symbol,
    side,
  );
  if (finalContracts >= minFilled) {
    return {
      success: true,
      ...(lastResult.orderId != null ? { orderId: lastResult.orderId } : {}),
      feeCost: totalFee,
      ...(lastResult.raw !== undefined ? { raw: lastResult.raw } : {}),
      attempts,
      verified: true,
    };
  }

  const failMsg =
    lastResult.error ??
    `Position not verified after ${MAX_RETRIES} execute→wait→verify cycles (${finalContracts}/${targetContracts} contracts)`;
  console.error(
    `[RETRY_LOOP] Exhausted retries for user ${userId} on ${symbol}: ${failMsg}`,
  );
  await logUserActivity(prisma, {
    userId,
    kind: "TRADE_EXECUTION_FAILED",
    message: `Copy trade for ${symbol} could not be verified: ${failMsg}`,
  });

  return {
    success: false,
    error: failMsg,
    feeCost: totalFee,
    attempts,
    verified: false,
  };
}
