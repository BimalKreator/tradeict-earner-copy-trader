import type { PrismaClient } from "@prisma/client";
import {
  COPY_FLAT_CONFIRM_MS,
  COPY_FLAT_MISS_POLLS_REQUIRED,
  masterLegCloseHasActiveWsHint,
} from "./copySyncPolicy.js";
import {
  fetchDeltaOpenPositions,
  type TradeSide,
} from "./exchangeService.js";
import { syncMasterPartialTrimToFollowers } from "./followerTradeExecution.js";
import { isLegClosingBlocked, isMasterLegCloseInProgress } from "./subscriptionSyncService.js";
import { tradePositionSymbolsAlign } from "./tradePositionService.js";

export type MasterRestLeg = {
  deltaSymbol: string;
  side: TradeSide;
  masterContracts: number;
  entryPrice: number;
};

export type MasterSyncLegMeta = {
  symbol: string;
  side: TradeSide;
  contracts: number;
  avgEntry: number;
};

/** Tracker surface used by priority flat verification (implemented by MasterPositionTracker). */
export type MasterSyncTracker = {
  maxContractsForSymbolSide(symbol: string, side: TradeSide): number;
  markWsFlatHint(symbol: string, side: TradeSide): void;
  clearPendingFlat(legKey: string): void;
  clearWsFlatHint(symbol: string, side: TradeSide): void;
  clearLegKeys(keys: Iterable<string>): void;
  lastRestContractsByLeg: Map<string, number>;
  aliasesForSnap(snap: {
    symbol: string;
    side: TradeSide;
    productKey: string;
  }): string[];
  applyMasterLeg(leg: {
    symbol: string;
    side: TradeSide;
    contracts: number;
    avgEntry: number;
  }): void;
  isFlatDetectionSuppressed(symbol: string, refMs?: number): boolean;
  wsFlatHintAgeMs(symbol: string, side: TradeSide, refMs?: number): number | null;
  lastOpenMeta: Map<string, MasterSyncLegMeta>;
  markPriorityFlatVerified(legKey: string, refMs?: number): void;
};

export type NotifyMasterFlatFn = (
  prisma: PrismaClient,
  strategyId: string,
  snap: {
    symbol: string;
    side: TradeSide;
    masterEntryPrice: number;
    masterContracts: number;
  },
) => Promise<boolean>;

export type MasterSyncDeps = {
  notifyMasterFlat: NotifyMasterFlatFn;
  legKey: (symbol: string, side: TradeSide) => string;
  resolveLegMeta: (
    tracker: MasterSyncTracker,
    symbol: string,
    side: TradeSide,
  ) => MasterSyncLegMeta | null;
  buildTrimFillKey: (parts: string[]) => string;
};

export async function fetchMasterRestLegs(
  apiKey: string,
  apiSecret: string,
): Promise<MasterRestLeg[]> {
  const raw = await fetchDeltaOpenPositions(apiKey, apiSecret, {
    lite: true,
    skipCache: true,
  });
  const out: MasterRestLeg[] = [];
  for (const p of raw) {
    const masterContracts = Math.abs(p.contracts);
    if (!Number.isFinite(masterContracts) || masterContracts < 1e-12) continue;
    const entry =
      p.entryPrice != null && Number.isFinite(p.entryPrice)
        ? p.entryPrice
        : p.markPrice != null && Number.isFinite(p.markPrice)
          ? p.markPrice
          : 0;
    out.push({
      deltaSymbol: p.symbolKey,
      side: p.side === "SELL" ? "SELL" : "BUY",
      masterContracts,
      entryPrice: entry,
    });
  }
  return out;
}

function masterLegOpenOnRest(
  meta: { symbol: string; side: TradeSide },
  masters: MasterRestLeg[],
): boolean {
  return masters.some(
    (m) =>
      m.masterContracts > 0 &&
      m.side === meta.side &&
      tradePositionSymbolsAlign(meta.symbol, m.deltaSymbol),
  );
}

/**
 * Priority REST verification — one fetch; if the leg is missing/flat, close followers
 * immediately (bypasses the 4-poll silent-drop streak).
 */
export async function executeMasterLegCloseAfterRestCheck(
  prisma: PrismaClient,
  strategyId: string,
  tracker: MasterSyncTracker,
  args: {
    symbol: string;
    openSide: TradeSide;
    trackedContracts: number;
    avgEntry: number;
    source: string;
  },
  deps: MasterSyncDeps,
): Promise<boolean> {
  if (args.trackedContracts <= 0) return false;
  if (tracker.isFlatDetectionSuppressed(args.symbol)) return false;

  const strat = await prisma.strategy.findUnique({
    where: { id: strategyId },
    select: { masterApiKey: true, masterApiSecret: true, isActive: true },
  });
  if (!strat?.isActive) return false;
  const key = strat.masterApiKey?.trim();
  const secret = strat.masterApiSecret?.trim();
  if (!key || !secret) return false;

  let masters: MasterRestLeg[];
  try {
    masters = await fetchMasterRestLegs(key, secret);
  } catch (err) {
    console.warn(
      `[MASTER-REST-SYNC] priority verify REST failed ${args.symbol} ${args.openSide}:`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }

  const meta = { symbol: args.symbol, side: args.openSide };
  const restLeg = masters.find(
    (m) =>
      m.masterContracts > 0 &&
      m.side === args.openSide &&
      tradePositionSymbolsAlign(args.symbol, m.deltaSymbol),
  );
  const restContracts = restLeg?.masterContracts ?? 0;
  const restOpen = masterLegOpenOnRest(meta, masters);

  if (restOpen && restContracts >= args.trackedContracts - 1e-9) {
    return false;
  }

  const legKey = deps.legKey(args.symbol, args.openSide);
  tracker.markPriorityFlatVerified(legKey);

  if (!restOpen || restContracts <= 0) {
    if (
      isLegClosingBlocked(strategyId, args.symbol, args.openSide) ||
      isMasterLegCloseInProgress(strategyId, args.symbol, args.openSide)
    ) {
      console.log(
        `[MASTER-REST-SYNC] defer priority flat ${args.symbol} ${args.openSide} (${args.source}) — close in flight, keep tracker`,
      );
      return false;
    }

    console.log(
      `[MASTER-REST-SYNC] priority verify confirmed flat ${args.symbol} ${args.openSide} (${args.source}) — closing followers`,
    );
    const flatOk = await deps.notifyMasterFlat(prisma, strategyId, {
      symbol: args.symbol,
      side: args.openSide,
      masterEntryPrice:
        Number.isFinite(args.avgEntry) && args.avgEntry > 0 ? args.avgEntry : 0,
      masterContracts: args.trackedContracts,
    });
    if (!flatOk) return false;
    tracker.clearPendingFlat(legKey);
    tracker.clearWsFlatHint(args.symbol, args.openSide);
    tracker.clearLegKeys(
      tracker.aliasesForSnap({
        symbol: args.symbol,
        side: args.openSide,
        productKey: args.symbol,
      }),
    );
    tracker.lastRestContractsByLeg.delete(legKey);
    return true;
  }

  const trimLots = Math.floor(args.trackedContracts - restContracts);
  if (trimLots <= 0) return false;

  console.log(
    `[MASTER-REST-SYNC] priority verify partial trim ${args.symbol} ${args.openSide} -${trimLots} (${args.source})`,
  );
  const trimKey = deps.buildTrimFillKey([
    args.symbol,
    args.openSide,
    String(restContracts),
    String(trimLots),
    args.source,
  ]);
  try {
    await syncMasterPartialTrimToFollowers(prisma, strategyId, {
      symbol: args.symbol,
      side: args.openSide,
      masterTrimLots: trimLots,
      masterFillKey: trimKey,
      masterEntryPrice:
        Number.isFinite(args.avgEntry) && args.avgEntry > 0 ? args.avgEntry : 0,
    });
  } catch (trimErr) {
    console.error(
      `[MASTER-REST-SYNC] priority verify partial trim failed ${args.symbol} ${args.openSide}:`,
      trimErr instanceof Error ? trimErr.message : trimErr,
    );
    return false;
  }

  tracker.applyMasterLeg({
    symbol: args.symbol,
    side: args.openSide,
    contracts: restContracts,
    avgEntry:
      Number.isFinite(restLeg?.entryPrice) && (restLeg?.entryPrice ?? 0) > 0
        ? restLeg!.entryPrice
        : args.avgEntry,
  });
  tracker.lastRestContractsByLeg.set(legKey, restContracts);
  return true;
}

/**
 * WS delete / closing fill / size→0 — immediate priority REST fetch.
 * When REST confirms the leg is gone, streak is treated as fully verified (4) and
 * {@link NotifyMasterFlatFn} runs without waiting for background poll hysteresis.
 */
export async function runPriorityFlatVerificationRestFetch(
  prisma: PrismaClient,
  strategyId: string,
  tracker: MasterSyncTracker,
  args: {
    reason: string;
    targetLegs?: Array<{ symbol: string; side: TradeSide }>;
  },
  deps: MasterSyncDeps,
): Promise<number> {
  console.log(
    `[MASTER-REST-SYNC] priority verification REST fetch (${args.reason})`,
  );

  const legs: Array<{ symbol: string; side: TradeSide }> = [];
  const seen = new Set<string>();

  if (args.targetLegs?.length) {
    for (const leg of args.targetLegs) {
      const lk = deps.legKey(leg.symbol, leg.side);
      if (seen.has(lk)) continue;
      seen.add(lk);
      legs.push(leg);
    }
  } else {
    const now = Date.now();
    for (const meta of tracker.lastOpenMeta.values()) {
      const lk = deps.legKey(meta.symbol, meta.side);
      if (seen.has(lk)) continue;
      if (tracker.maxContractsForSymbolSide(meta.symbol, meta.side) <= 0) {
        continue;
      }
      if (
        !masterLegCloseHasActiveWsHint(
          tracker.wsFlatHintAgeMs(meta.symbol, meta.side, now),
        )
      ) {
        continue;
      }
      seen.add(lk);
      legs.push({ symbol: meta.symbol, side: meta.side });
    }
  }

  const outcomes = await Promise.allSettled(
    legs.map(async (leg) => {
      const tracked = tracker.maxContractsForSymbolSide(leg.symbol, leg.side);
      const meta = deps.resolveLegMeta(tracker, leg.symbol, leg.side);
      if (!meta || tracked <= 0) return false;

      tracker.markWsFlatHint(leg.symbol, leg.side);
      return executeMasterLegCloseAfterRestCheck(
        prisma,
        strategyId,
        tracker,
        {
          symbol: leg.symbol,
          openSide: leg.side,
          trackedContracts: tracked,
          avgEntry: meta.avgEntry,
          source: `priority:${args.reason}`,
        },
        deps,
      );
    }),
  );
  let closed = 0;
  for (const outcome of outcomes) {
    if (outcome.status === "fulfilled" && outcome.value) closed += 1;
  }

  if (closed > 0) {
    console.log(
      `[MASTER-REST-SYNC] priority verification closed ${closed} leg(s) (${args.reason})`,
    );
  }

  return closed;
}

/** Mark flat-close gates satisfied (streak = 4, time gate passed) after WS+REST verify. */
export function markTrackerPriorityFlatVerified(
  tracker: MasterSyncTracker,
  legKey: string,
  refMs = Date.now(),
): void {
  tracker.markPriorityFlatVerified(legKey, refMs);
}

export const PRIORITY_FLAT_VERIFIED_STREAK = COPY_FLAT_MISS_POLLS_REQUIRED;
export const PRIORITY_FLAT_VERIFIED_SINCE_OFFSET_MS = COPY_FLAT_CONFIRM_MS;
