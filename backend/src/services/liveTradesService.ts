import {
  type PrismaClient,
  SubscriptionStatus,
  UserStatus,
} from "@prisma/client";
import {
  fetchDeltaMarkPrice,
  fetchDeltaOpenPositions,
  isDeltaOptionProductId,
  type DeltaLivePosition,
  type TradeSide,
} from "./exchangeService.js";
import { resolveLiveMarkPrice } from "./liveMarkPriceCache.js";
import { registerSymbolsForLivePrices } from "./livePriceTracker.js";
import {
  COPY_SUBSCRIPTION_INCLUDE,
  resolveCopySubscriptionCreds,
  type CopySubscriptionRow,
} from "./strategySubscriptionService.js";
import { FUTURE_HEDGE_STRATEGY_TITLE } from "../constants/strategyTitles.js";

/** Per-account Delta fetch budget — avoids nginx 502 from long sequential CCXT loadMarkets. */
const DELTA_LIVE_TRADES_FETCH_TIMEOUT_MS = 25_000;
/** Hold master legs on the live-trades panel until REST reports flat for this long. */
const MASTER_LIVE_TRADES_FLAT_CONFIRM_MS = 10_000;

type MasterLiveTradesSticky = {
  positions: LiveTradeRow[];
  firstEmptyAt: number | null;
};

/** In-memory sticky master rows — avoids flicker when Delta REST briefly omits open legs. */
const masterLiveTradesSticky = new Map<string, MasterLiveTradesSticky>();

type UserLiveTradesSticky = {
  positions: LiveTradeRow[];
  firstEmptyAt: number | null;
};

/** Per user+strategy — same 10s gate as master sticky. */
const userLiveTradesSticky = new Map<string, UserLiveTradesSticky>();

function userLiveTradesStickyKey(userId: string, strategyId: string): string {
  return `${userId}:${strategyId}`;
}

function applyUserLiveTradesSticky(
  userId: string,
  strategyId: string,
  fetched: LiveTradeRow[],
  fetchSucceeded: boolean,
): LiveTradeRow[] {
  const key = userLiveTradesStickyKey(userId, strategyId);
  if (!fetchSucceeded) {
    const prev = userLiveTradesSticky.get(key);
    return prev?.positions ?? [];
  }

  const now = Date.now();
  if (fetched.length > 0) {
    userLiveTradesSticky.set(key, { positions: fetched, firstEmptyAt: null });
    return fetched;
  }

  const prev = userLiveTradesSticky.get(key);
  if (!prev || prev.positions.length === 0) {
    userLiveTradesSticky.set(key, { positions: [], firstEmptyAt: now });
    return [];
  }

  const firstEmpty = prev.firstEmptyAt ?? now;
  if (now - firstEmpty < MASTER_LIVE_TRADES_FLAT_CONFIRM_MS) {
    userLiveTradesSticky.set(key, {
      positions: prev.positions,
      firstEmptyAt: firstEmpty,
    });
    console.log(
      `[live-trades] user sticky hold userId=${userId} strategyId=${strategyId} ` +
        `(${prev.positions.length} leg(s))`,
    );
    return prev.positions;
  }

  userLiveTradesSticky.set(key, { positions: [], firstEmptyAt: firstEmpty });
  return [];
}

function applyMasterLiveTradesSticky(
  strategyId: string,
  fetched: LiveTradeRow[],
  fetchSucceeded: boolean,
): LiveTradeRow[] {
  if (!fetchSucceeded) {
    const prev = masterLiveTradesSticky.get(strategyId);
    return prev?.positions ?? [];
  }

  const now = Date.now();
  if (fetched.length > 0) {
    masterLiveTradesSticky.set(strategyId, {
      positions: fetched,
      firstEmptyAt: null,
    });
    return fetched;
  }

  const prev = masterLiveTradesSticky.get(strategyId);
  if (!prev || prev.positions.length === 0) {
    masterLiveTradesSticky.set(strategyId, { positions: [], firstEmptyAt: now });
    return [];
  }

  const firstEmpty = prev.firstEmptyAt ?? now;
  if (now - firstEmpty < MASTER_LIVE_TRADES_FLAT_CONFIRM_MS) {
    masterLiveTradesSticky.set(strategyId, {
      positions: prev.positions,
      firstEmptyAt: firstEmpty,
    });
    console.log(
      `[live-trades] master sticky hold strategyId=${strategyId} ` +
        `(${prev.positions.length} leg(s), empty ${Math.round((now - firstEmpty) / 1000)}s / ${MASTER_LIVE_TRADES_FLAT_CONFIRM_MS / 1000}s)`,
    );
    return prev.positions;
  }

  masterLiveTradesSticky.set(strategyId, {
    positions: [],
    firstEmptyAt: firstEmpty,
  });
  return [];
}

function withDeltaFetchTimeout<T>(
  promise: Promise<T>,
  label: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `${label} timed out after ${DELTA_LIVE_TRADES_FETCH_TIMEOUT_MS}ms`,
        ),
      );
    }, DELTA_LIVE_TRADES_FETCH_TIMEOUT_MS);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function followerCredsCacheKey(sub: CopySubscriptionRow): string | null {
  if (sub.exchangeAccount != null) return `ex:${sub.exchangeAccount.id}`;
  const ex = sub.user.exchangeAccounts[0];
  if (ex != null) return `ex:${ex.id}`;
  const dk = sub.user.deltaApiKeys[0];
  if (dk != null) return `dk:${dk.id}`;
  return null;
}

export type LiveTradeRow = {
  entryTime: string | null;
  token: string;
  size: number | null;
  entryPrice: number | null;
  stopLoss: number | null;
  target: number | null;
  livePnl: number | null;
  markPrice: number | null;
  side: string;
};

export type UserLiveTradeRow = LiveTradeRow & {
  strategyId: string | null;
  strategyTitle: string;
};

export type AdminFollowerRow = LiveTradeRow & {
  userId: string;
  userEmail: string;
  multiplier: number;
};

export type LiveStrategySummary = {
  id: string;
  title: string;
  isActive: boolean;
  autoExitEnabled: boolean;
  autoExitTarget: number | null;
  autoExitStopLoss: number | null;
};

/** Active subscriber with all open legs on Delta for this strategy mapping. */
export type AdminLiveTradesSubscriber = {
  userId: string;
  userEmail: string;
  userName: string | null;
  multiplier: number;
  syncStatus: string;
  syncError: string | null;
  positions: LiveTradeRow[];
};

/** Admin live-trades payload: one tab per strategy. */
export type AdminLiveTradesGroup = {
  strategy: LiveStrategySummary;
  masterPositions: LiveTradeRow[];
  subscribers: AdminLiveTradesSubscriber[];
  masterMeta: {
    credentialsPresent: boolean;
    fetchException?: string;
  };
};

/** User live-trades payload: one tab per subscribed strategy. */
export type UserLiveTradesGroup = {
  strategy: LiveStrategySummary & { multiplier: number };
  userPositions: LiveTradeRow[];
  /** Master account open leg count (for empty-state when leader is flat). */
  masterOpenCount: number;
};

/** @deprecated Use {@link AdminLiveTradesGroup} — flat shape for legacy callers. */
export type AdminSubscriberUserSection = AdminLiveTradesSubscriber;

/** @deprecated Use {@link AdminLiveTradesGroup}. */
export type AdminStrategyLiveSection = {
  strategyId: string;
  strategyTitle: string;
  autoExitTarget: number | null;
  autoExitStopLoss: number | null;
  masterPositions: LiveTradeRow[];
  subscribers: AdminLiveTradesSubscriber[];
  masterMeta: {
    credentialsPresent: boolean;
    fetchException?: string;
  };
};

export type AdminMasterPositionSnapshot = {
  strategyId: string;
  strategyTitle: string;
  positions: LiveTradeRow[];
  masterMeta: {
    credentialsPresent: boolean;
    fetchException?: string;
  };
};

/** Mark for display — options use exchange mark only (WS cache aliases break option premiums). */
async function resolveMarkForLiveRow(
  pos: DeltaLivePosition,
): Promise<number | null> {
  if (
    pos.markPrice != null &&
    Number.isFinite(pos.markPrice) &&
    pos.markPrice > 0
  ) {
    return pos.markPrice;
  }

  if (isDeltaOptionProductId(pos.symbolKey)) {
    const rest = await fetchDeltaMarkPrice(pos.symbolKey);
    return rest.markPrice;
  }

  const cached = resolveLiveMarkPrice(pos.symbolKey);
  if (cached != null) return cached;

  const rest = await fetchDeltaMarkPrice(pos.symbolKey);
  return rest.markPrice;
}

/** Mark for display only — UPNL always from exchangeService (Delta unrealized_pnl). */
async function enrichPositionLiveRow(
  pos: DeltaLivePosition,
): Promise<LiveTradeRow> {
  if (!isDeltaOptionProductId(pos.symbolKey)) {
    registerSymbolsForLivePrices([pos.symbolKey]);
  }
  const base = deltaToRow(pos);

  return {
    ...base,
    markPrice: pos.markPrice ?? base.markPrice,
    livePnl: base.livePnl,
  };
}

async function safeEnrichPositionLiveRow(
  pos: DeltaLivePosition,
): Promise<LiveTradeRow> {
  try {
    return await enrichPositionLiveRow(pos);
  } catch (err) {
    console.warn(
      `[live-trades] enrich skipped symbol=${pos.symbolKey}:`,
      err instanceof Error ? err.message : err,
    );
    return deltaToRow(pos);
  }
}

async function enrichPositionsList(
  list: DeltaLivePosition[],
): Promise<LiveTradeRow[]> {
  return Promise.all(list.map((pos) => safeEnrichPositionLiveRow(pos)));
}

/**
 * CCXT snapshots of each strategy master account: {@link fetchDeltaOpenPositions} (`ccxt.delta`, India).
 * Use for admin dashboards that only need leader positions without follower matching.
 */
export async function getAdminMasterPositionSnapshots(
  prisma: PrismaClient,
): Promise<AdminMasterPositionSnapshot[]> {
  const strategies = await prisma.strategy.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      title: true,
      masterApiKey: true,
      masterApiSecret: true,
    },
  });

  const out: AdminMasterPositionSnapshot[] = [];

  for (const strat of strategies) {
    const credentialsPresent = Boolean(
      strat.masterApiKey?.trim() && strat.masterApiSecret?.trim(),
    );

    let masterList: DeltaLivePosition[] = [];
    let fetchException: string | undefined;
    if (credentialsPresent) {
      try {
        masterList = await withDeltaFetchTimeout(
          fetchDeltaOpenPositions(strat.masterApiKey, strat.masterApiSecret),
          `master snapshot strategy=${strat.id}`,
        );
      } catch (err) {
        fetchException =
          err instanceof Error ? err.message : String(err ?? "fetch failed");
        masterList = [];
      }
    }

    const positions = applyMasterLiveTradesSticky(
      strat.id,
      await enrichPositionsList(masterList),
      fetchException === undefined,
    );

    out.push({
      strategyId: strat.id,
      strategyTitle: strat.title,
      positions,
      masterMeta: {
        credentialsPresent,
        ...(fetchException !== undefined ? { fetchException } : {}),
      },
    });
  }

  return out;
}

function deltaToRow(p: DeltaLivePosition): LiveTradeRow {
  return {
    entryTime: p.entryTime,
    token: p.symbolKey,
    size: p.contracts,
    entryPrice: p.entryPrice,
    stopLoss: p.stopLoss,
    target: p.takeProfit,
    livePnl: p.unrealizedPnl,
    markPrice: p.markPrice,
    side: p.side,
  };
}

/**
 * Live trades grouped by strategy for the current user (active subscriptions only).
 */
export async function getUserLiveTradesByStrategy(
  prisma: PrismaClient,
  userId: string,
): Promise<UserLiveTradesGroup[]> {
  const subs = await prisma.userStrategySubscription.findMany({
    where: {
      userId,
      isActive: true,
      status: SubscriptionStatus.ACTIVE,
      strategy: { isActive: true, title: FUTURE_HEDGE_STRATEGY_TITLE },
      user: { status: UserStatus.ACTIVE, copyTradingPaused: false },
    },
    orderBy: { joinedDate: "desc" },
    include: {
      strategy: {
        select: {
          id: true,
          title: true,
          isActive: true,
          autoExitEnabled: true,
          autoExitTarget: true,
          autoExitStopLoss: true,
          masterApiKey: true,
          masterApiSecret: true,
        },
      },
      ...COPY_SUBSCRIPTION_INCLUDE,
    },
  });

  const out: UserLiveTradesGroup[] = [];

  for (const sub of subs) {
    const creds = resolveCopySubscriptionCreds(sub);
    let userPositions: LiveTradeRow[] = [];

    if (creds) {
      try {
        const positions = await withDeltaFetchTimeout(
          fetchDeltaOpenPositions(creds.apiKey, creds.apiSecret),
          `user positions userId=${userId} strategyId=${sub.strategyId}`,
        );
        const enriched = await enrichPositionsList(positions);
        userPositions = applyUserLiveTradesSticky(
          userId,
          sub.strategyId,
          enriched,
          true,
        );
        userPositions.sort((a, b) =>
          (b.entryTime ?? "").localeCompare(a.entryTime ?? ""),
        );
      } catch (err) {
        userPositions = applyUserLiveTradesSticky(
          userId,
          sub.strategyId,
          [],
          false,
        );
        console.warn(
          `[live-trades] user strategy fetch failed userId=${userId} strategyId=${sub.strategyId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    let masterOpenCount = 0;
    const masterKey = sub.strategy.masterApiKey?.trim() ?? "";
    const masterSecret = sub.strategy.masterApiSecret?.trim() ?? "";
    if (masterKey && masterSecret) {
      try {
        const masterList = await withDeltaFetchTimeout(
          fetchDeltaOpenPositions(
            sub.strategy.masterApiKey!,
            sub.strategy.masterApiSecret!,
          ),
          `master snapshot strategyId=${sub.strategyId}`,
        );
        const enriched = await enrichPositionsList(masterList);
        masterOpenCount = applyMasterLiveTradesSticky(
          sub.strategyId,
          enriched,
          true,
        ).length;
      } catch (err) {
        const sticky = masterLiveTradesSticky.get(sub.strategyId);
        masterOpenCount = sticky?.positions.length ?? 0;
        console.warn(
          `[live-trades] master snapshot failed strategyId=${sub.strategyId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    out.push({
      strategy: {
        id: sub.strategy.id,
        title: sub.strategy.title,
        isActive: sub.strategy.isActive,
        autoExitEnabled: sub.strategy.autoExitEnabled,
        autoExitTarget: sub.strategy.autoExitTarget,
        autoExitStopLoss: sub.strategy.autoExitStopLoss,
        multiplier: sub.multiplier,
      },
      userPositions,
      masterOpenCount,
    });
  }

  return out;
}

/**
 * Flat list derived from {@link getUserLiveTradesByStrategy} (legacy `/live-trades/me` shape).
 */
export async function getUserLiveTradeRows(
  prisma: PrismaClient,
  userId: string,
): Promise<UserLiveTradeRow[]> {
  const groups = await getUserLiveTradesByStrategy(prisma, userId);
  const rows: UserLiveTradeRow[] = [];
  for (const g of groups) {
    for (const pos of g.userPositions) {
      rows.push({
        ...pos,
        strategyId: g.strategy.id,
        strategyTitle: g.strategy.title,
      });
    }
  }
  return rows;
}

/**
 * Admin live trades: every strategy with master legs and per-subscriber open positions.
 */
export async function getAdminLiveTradesByStrategy(
  prisma: PrismaClient,
): Promise<AdminLiveTradesGroup[]> {
  const strategies = await prisma.strategy.findMany({
    where: { title: FUTURE_HEDGE_STRATEGY_TITLE },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      title: true,
      isActive: true,
      masterApiKey: true,
      masterApiSecret: true,
      autoExitEnabled: true,
      autoExitTarget: true,
      autoExitStopLoss: true,
    },
  });

  if (strategies.length === 0) return [];

  const out: AdminLiveTradesGroup[] = [];
  const followerPositionsCache = new Map<string, DeltaLivePosition[]>();

  async function cachedFollowerPositions(
    cacheKey: string,
    apiKey: string,
    apiSecret: string,
  ): Promise<DeltaLivePosition[]> {
    const hit = followerPositionsCache.get(cacheKey);
    if (hit) return hit;
    try {
      const list = await withDeltaFetchTimeout(
        fetchDeltaOpenPositions(apiKey, apiSecret),
        `follower positions ${cacheKey}`,
      );
      followerPositionsCache.set(cacheKey, list);
      return list;
    } catch (err) {
      console.warn(
        `[live-trades] follower positions failed ${cacheKey}:`,
        err instanceof Error ? err.message : err,
      );
      followerPositionsCache.set(cacheKey, []);
      return [];
    }
  }

  for (const strat of strategies) {
    try {
      const strategy: LiveStrategySummary = {
        id: strat.id,
        title: strat.title,
        isActive: strat.isActive,
        autoExitEnabled: strat.autoExitEnabled,
        autoExitTarget: strat.autoExitTarget,
        autoExitStopLoss: strat.autoExitStopLoss,
      };

      const credentialsPresent = Boolean(
        strat.masterApiKey?.trim() && strat.masterApiSecret?.trim(),
      );

      const subsPromise = prisma.userStrategySubscription.findMany({
        where: {
          strategyId: strat.id,
          isActive: true,
          status: SubscriptionStatus.ACTIVE,
          user: { status: UserStatus.ACTIVE },
        },
        include: {
          exchangeAccount: true,
          user: {
            select: {
              id: true,
              email: true,
              name: true,
              deltaApiKeys: true,
              exchangeAccounts: {
                orderBy: { createdAt: "desc" },
                take: 1,
              },
            },
          },
        },
      });

      const subs = await subsPromise;

      const masterResult = await (async (): Promise<{
        list: DeltaLivePosition[];
        fetchException?: string;
      }> => {
        if (!credentialsPresent) return { list: [] };
        try {
          const list = await withDeltaFetchTimeout(
            fetchDeltaOpenPositions(
              strat.masterApiKey!,
              strat.masterApiSecret!,
            ),
            `master positions strategy=${strat.id}`,
          );
          return { list };
        } catch (err) {
          const fetchException =
            err instanceof Error ? err.message : String(err ?? "fetch failed");
          console.error(
            `[live-trades] Master Delta positions threw for "${strat.title}" (${strat.id}):`,
            fetchException,
          );
          return { list: [], fetchException };
        }
      })();

      const masterMeta = {
        credentialsPresent,
        ...(masterResult.fetchException !== undefined
          ? { fetchException: masterResult.fetchException }
          : {}),
      };

      const masterPositions = applyMasterLiveTradesSticky(
        strat.id,
        await enrichPositionsList(masterResult.list),
        masterResult.fetchException === undefined,
      );

      const subscribers = await Promise.all(
        subs.map(async (sub): Promise<AdminLiveTradesSubscriber> => {
          const positions: LiveTradeRow[] = [];
          const creds = resolveCopySubscriptionCreds(sub as CopySubscriptionRow);
          const cacheKey = followerCredsCacheKey(sub as CopySubscriptionRow);
          if (creds && cacheKey) {
            const deltaList = await cachedFollowerPositions(
              cacheKey,
              creds.apiKey,
              creds.apiSecret,
            );
            positions.push(...(await enrichPositionsList(deltaList)));
            positions.sort((a, b) =>
              (b.entryTime ?? "").localeCompare(a.entryTime ?? ""),
            );
          }

          return {
            userId: sub.userId,
            userEmail: sub.user.email,
            userName: sub.user.name,
            multiplier: sub.multiplier,
            syncStatus: sub.syncStatus,
            syncError: sub.syncError,
            positions,
          };
        }),
      );

      subscribers.sort((a, b) => a.userEmail.localeCompare(b.userEmail));

      out.push({
        strategy,
        masterPositions,
        subscribers,
        masterMeta,
      });
    } catch (err) {
      console.error(
        `[live-trades] strategy section failed strategyId=${strat.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return out;
}

/** @deprecated Alias — returns nested {@link AdminLiveTradesGroup} list. */
export async function getAdminGroupedLiveTrades(
  prisma: PrismaClient,
): Promise<AdminLiveTradesGroup[]> {
  return getAdminLiveTradesByStrategy(prisma);
}

/** Flat legacy sections (strategyId/strategyTitle at top level). */
export async function getAdminGroupedLiveTradesLegacy(
  prisma: PrismaClient,
): Promise<AdminStrategyLiveSection[]> {
  const groups = await getAdminLiveTradesByStrategy(prisma);
  return groups.map((g) => ({
    strategyId: g.strategy.id,
    strategyTitle: g.strategy.title,
    autoExitTarget: g.strategy.autoExitTarget,
    autoExitStopLoss: g.strategy.autoExitStopLoss,
    masterPositions: g.masterPositions,
    subscribers: g.subscribers,
    masterMeta: g.masterMeta,
  }));
}
