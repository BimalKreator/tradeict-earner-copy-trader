import { type PrismaClient } from "@prisma/client";
import {
  EXIT_REASON,
  markBotInitiatedClose,
  setPendingStrategyExitReason,
} from "../constants/exitReasons.js";
import {
  executeTrade,
  fetchDeltaOpenPositions,
  type DeltaLivePosition,
  type TradeSide,
} from "./exchangeService.js";
import {
  findActiveCopySubscribersForStrategy,
  normalizeFutureHedgeStrategyId,
  resolveCopySubscriptionCreds,
} from "./strategySubscriptionService.js";
import {
  closeOpenTradesForManualAdmin,
  syncFollowerUserToMasterPositions,
} from "./tradeEngine.js";
import { closeTradePositionsForLeg } from "./tradePositionService.js";
import {
  reconcileStaleOpenTradesForUser,
  settlementFromExecuteResult,
} from "./tradeSettlementService.js";

function oppositeSide(side: TradeSide): TradeSide {
  return side === "BUY" ? "SELL" : "BUY";
}

async function closeLiveLegsOnExchange(
  prisma: PrismaClient,
  args: {
    strategyId: string;
    apiKey: string;
    apiSecret: string;
    positions: DeltaLivePosition[];
    isMaster: boolean;
    userId?: string;
  },
): Promise<{ closed: number; errors: string[] }> {
  const errors: string[] = [];
  let closed = 0;

  for (const pos of args.positions) {
    const openSide: TradeSide = pos.side === "SELL" ? "SELL" : "BUY";
    const lots = Math.floor(Math.abs(pos.contracts));
    if (lots <= 0) continue;

    if (args.isMaster) {
      markBotInitiatedClose(args.strategyId, pos.symbolKey, EXIT_REASON.ADMIN_PANEL);
      setPendingStrategyExitReason(args.strategyId, EXIT_REASON.ADMIN_PANEL);
    }

    const result = await executeTrade(
      args.apiKey,
      args.apiSecret,
      pos.symbolKey,
      oppositeSide(openSide),
      lots,
      { reduceOnly: true },
    );

    if (!result.success) {
      errors.push(
        `${args.isMaster ? "master" : `user=${args.userId}`} ${pos.symbolKey} ${openSide}: ${result.error ?? "close failed"}`,
      );
      continue;
    }

    closed += 1;

    await closeTradePositionsForLeg(prisma, {
      strategyId: args.strategyId,
      symbol: pos.symbolKey,
      side: openSide,
      ...(args.isMaster ? { isMaster: true } : { userId: args.userId! }),
    });

    if (!args.isMaster && args.userId) {
      const settlement = settlementFromExecuteResult(result);
      if (!settlement) {
        errors.push(
          `user=${args.userId} ${pos.symbolKey} ${openSide}: missing Delta close settlement`,
        );
        continue;
      }
      await closeOpenTradesForManualAdmin(prisma, {
        userId: args.userId,
        strategyId: args.strategyId,
        symbol: pos.symbolKey,
        side: openSide,
        settlement,
      });
    }
  }

  return { closed, errors };
}

export type AdminCloseAllLiveResult = {
  ok: boolean;
  strategyId: string;
  masterLegsClosed: number;
  followerLegsClosed: number;
  usersProcessed: number;
  dbTradesReconciled: number;
  errors: string[];
};

/** Close every open Delta leg on master + all active followers for a strategy. */
export async function adminCloseAllLivePositions(
  prisma: PrismaClient,
  rawStrategyId: string,
): Promise<AdminCloseAllLiveResult> {
  const strategyId = await normalizeFutureHedgeStrategyId(prisma, rawStrategyId);
  const strategy = await prisma.strategy.findUnique({
    where: { id: strategyId },
    select: { id: true, masterApiKey: true, masterApiSecret: true },
  });
  if (!strategy) {
    throw new Error("Strategy not found");
  }

  const errors: string[] = [];
  let masterLegsClosed = 0;
  let followerLegsClosed = 0;
  let dbTradesReconciled = 0;

  const masterKey = strategy.masterApiKey?.trim() ?? "";
  const masterSecret = strategy.masterApiSecret?.trim() ?? "";
  if (masterKey && masterSecret) {
    try {
      const masterPositions = await fetchDeltaOpenPositions(masterKey, masterSecret, {
        lite: true,
        skipCache: true,
      });
      const masterResult = await closeLiveLegsOnExchange(prisma, {
        strategyId,
        apiKey: masterKey,
        apiSecret: masterSecret,
        positions: masterPositions,
        isMaster: true,
      });
      masterLegsClosed = masterResult.closed;
      errors.push(...masterResult.errors);
    } catch (err) {
      errors.push(
        `master fetch: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const subs = await findActiveCopySubscribersForStrategy(prisma, strategyId);
  for (const sub of subs) {
    const creds = resolveCopySubscriptionCreds(sub);
    if (!creds) {
      errors.push(`user ${sub.user.email}: no Delta API credentials`);
      continue;
    }

    try {
      const followerPositions = await fetchDeltaOpenPositions(
        creds.apiKey,
        creds.apiSecret,
        { lite: true, skipCache: true },
      );
      const followerResult = await closeLiveLegsOnExchange(prisma, {
        strategyId,
        apiKey: creds.apiKey,
        apiSecret: creds.apiSecret,
        positions: followerPositions,
        isMaster: false,
        userId: sub.userId,
      });
      followerLegsClosed += followerResult.closed;
      errors.push(...followerResult.errors);

      const reconciled = await reconcileStaleOpenTradesForUser(prisma, {
        userId: sub.userId,
        apiKey: creds.apiKey,
        apiSecret: creds.apiSecret,
      });
      dbTradesReconciled += reconciled.settled + reconciled.voided;
    } catch (err) {
      errors.push(
        `user ${sub.user.email}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    ok: errors.length === 0,
    strategyId,
    masterLegsClosed,
    followerLegsClosed,
    usersProcessed: subs.length,
    dbTradesReconciled,
    errors,
  };
}

export type AdminSyncAllFollowersResult = {
  ok: boolean;
  strategyId: string;
  usersAttempted: number;
  usersSynced: number;
  totalAdjustments: number;
  results: Array<{
    userId: string;
    userEmail: string;
    ok: boolean;
    adjustmentsMade: number;
    syncStatus: string;
    syncError: string | null;
    error?: string;
  }>;
};

/** Align every active follower book to master (multiplier-scaled) + close orphan legs. */
export async function adminSyncAllFollowersToMaster(
  prisma: PrismaClient,
  rawStrategyId: string,
): Promise<AdminSyncAllFollowersResult> {
  const strategyId = await normalizeFutureHedgeStrategyId(prisma, rawStrategyId);
  const subs = await findActiveCopySubscribersForStrategy(prisma, strategyId);

  const results: AdminSyncAllFollowersResult["results"] = [];
  let usersSynced = 0;
  let totalAdjustments = 0;

  for (const sub of subs) {
    try {
      const sync = await syncFollowerUserToMasterPositions(
        prisma,
        strategyId,
        sub.userId,
      );
      if (sync.ok) usersSynced += 1;
      totalAdjustments += sync.adjustmentsMade;
      results.push({
        userId: sub.userId,
        userEmail: sub.user.email,
        ok: sync.ok,
        adjustmentsMade: sync.adjustmentsMade,
        syncStatus: sync.syncStatus,
        syncError: sync.syncError,
        ...(sync.error ? { error: sync.error } : {}),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({
        userId: sub.userId,
        userEmail: sub.user.email,
        ok: false,
        adjustmentsMade: 0,
        syncStatus: "FAILED",
        syncError: msg,
        error: msg,
      });
    }
  }

  return {
    ok: results.every((r) => r.ok),
    strategyId,
    usersAttempted: subs.length,
    usersSynced,
    totalAdjustments,
    results,
  };
}
