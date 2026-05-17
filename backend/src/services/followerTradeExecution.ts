import type { PrismaClient } from "@prisma/client";
import {
  executeTrade,
  fetchDeltaOpenPositions,
  type ExecuteTradeResult,
  type TradeSide,
} from "./exchangeService.js";
import { logUserActivity } from "./userActivityService.js";

const VERIFY_DELAY_MS = 1_000;
const RETRY_COOLDOWN_MS = 1_500;
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
 * Place a follower market order, verify the open leg on Delta, and retry up to 3 times.
 * Skips verification for reduce-only closes (caller should use {@link executeTrade}).
 */
export async function executeFollowerTradeWithVerification(
  prisma: PrismaClient,
  args: {
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

  if (args.reduceOnly === true) {
    const single = await executeTrade(apiKey, apiSecret, symbol, side, targetContracts, {
      reduceOnly: true,
    });
    return { ...single, attempts: 1, verified: single.success };
  }

  let totalFee = 0;
  let lastResult: ExecuteTradeResult = {
    success: false,
    error: "no execution attempt",
  };
  let attempts = 0;

  for (let retry = 0; retry <= MAX_RETRIES; retry += 1) {
    if (retry > 0) {
      console.log(
        `[RETRY_LOOP] Trade not found. Attempting retry ${retry}/${MAX_RETRIES} for user ${userId} on ${symbol}...`,
      );
      await sleep(RETRY_COOLDOWN_MS);
    }

    const existing = await followerLegContracts(apiKey, apiSecret, symbol, side);
    const minFilled = targetContracts * 0.9;
    if (existing >= minFilled) {
      console.log(
        `[RETRY_LOOP] Trade successfully verified on attempt ${retry + 1} (existing ${existing} contracts).`,
      );
      return {
        success: true,
        feeCost: totalFee,
        attempts: retry + 1,
        verified: true,
      };
    }

    const orderSize =
      existing > 0 && existing < targetContracts
        ? Math.max(1, targetContracts - Math.floor(existing))
        : targetContracts;

    attempts += 1;
    lastResult = await executeTrade(apiKey, apiSecret, symbol, side, orderSize);

    if (lastResult.feeCost != null && Number.isFinite(lastResult.feeCost)) {
      totalFee += lastResult.feeCost;
    }

    if (!lastResult.success) {
      const err = lastResult.error ?? "unknown";
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
      `[RETRY_LOOP] Verifying trade for user ${userId} on ${symbol}...`,
    );
    await sleep(VERIFY_DELAY_MS);

    const filled = await followerLegContracts(apiKey, apiSecret, symbol, side);
    if (filled >= minFilled) {
      const attemptLabel = retry > 0 ? retry + 1 : 1;
      if (retry > 0) {
        console.log(
          `[RETRY_LOOP] Trade successfully verified on attempt ${attemptLabel}.`,
        );
      }
      return {
        success: true,
        ...(lastResult.orderId != null ? { orderId: lastResult.orderId } : {}),
        feeCost: totalFee,
        ...(lastResult.raw !== undefined ? { raw: lastResult.raw } : {}),
        attempts,
        verified: true,
      };
    }
  }

  const finalContracts = await followerLegContracts(
    apiKey,
    apiSecret,
    symbol,
    side,
  );
  if (finalContracts >= targetContracts * 0.9) {
    return {
      success: true,
      feeCost: totalFee,
      attempts,
      verified: true,
    };
  }

  const failMsg =
    lastResult.error ??
    `Position not verified after ${MAX_RETRIES} retries (${finalContracts}/${targetContracts} contracts)`;
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
