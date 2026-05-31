import {
  type PrismaClient,
  SubscriptionStatus,
  UserStatus,
} from "@prisma/client";
import {
  fetchDeltaMarkPrice,
  fetchDeltaMarginedPositionSnapshot,
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
/** Master poll budget — lite snapshot avoids per-option tickers; keep headroom for many legs. */
const MASTER_LIVE_TRADES_FETCH_TIMEOUT_MS = 45_000;

/** Successful REST polls before evicting a master leg (explicit flat or missing from snapshot). */
const MASTER_EXPLICIT_FLAT_POLLS_REQUIRED = 3;
/** Faster eviction when the master book is completely empty on a successful REST read. */
const MASTER_EMPTY_BOOK_EVICT_POLLS = 1;

function legSideFromKey(key: string): string {
  const idx = key.lastIndexOf(":");
  return idx >= 0 ? key.slice(idx + 1).toUpperCase() : "";
}

function legSymbolFromKey(key: string): string {
  const idx = key.lastIndexOf(":");
  return idx >= 0 ? key.slice(0, idx) : key;
}

function liveLegKeysAlign(a: string, b: string): boolean {
  if (a === b) return true;
  const sideA = legSideFromKey(a);
  const sideB = legSideFromKey(b);
  if (sideA !== sideB) return false;
  const symA = legSymbolFromKey(a);
  const symB = legSymbolFromKey(b);
  const ca = symA.replace(/[/:]/g, "").toUpperCase();
  const cb = symB.replace(/[/:]/g, "").toUpperCase();
  if (ca === cb || ca.endsWith(cb) || cb.endsWith(ca)) return true;
  return false;
}

function cacheKeyMatchesExplicitFlat(
  cacheKey: string,
  explicitFlatLegKeys: string[],
): boolean {
  return explicitFlatLegKeys.some((flatKey) =>
    liveLegKeysAlign(cacheKey, flatKey),
  );
}

type MasterLegCacheEntry = {
  row: LiveTradeRow;
  explicitFlatStreak: number;
};

/** strategyId → (legKey → cached row + flat-eviction streak) */
type MasterStrategyLegCache = Map<string, MasterLegCacheEntry>;

/**
 * Persistent in-memory master legs for admin live-trades UI.
 * Never time-expires — only evicts after {@link MASTER_EXPLICIT_FLAT_POLLS_REQUIRED}
 * consecutive successful REST polls with explicit size/contracts === 0.
 */
export const lastKnownMasterPositions = new Map<string, MasterStrategyLegCache>();

function masterLegKeyFromRow(row: LiveTradeRow): string {
  return `${row.token}:${row.side}`;
}

function sortMasterCachedRows(cache: MasterStrategyLegCache): LiveTradeRow[] {
  return [...cache.values()]
    .map((e) => e.row)
    .sort((a, b) => (b.entryTime ?? "").localeCompare(a.entryTime ?? ""));
}

function masterCachedPositions(strategyId: string): LiveTradeRow[] {
  const cache = lastKnownMasterPositions.get(strategyId);
  if (!cache || cache.size === 0) return [];
  return sortMasterCachedRows(cache);
}

type MasterLiveFetchOpts = {
  /** No client timeout — used for background refresh and cold-start retry. */
  background?: boolean;
};

/**
 * Merge a successful (or failed) master REST snapshot into {@link lastKnownMasterPositions}.
 * - Fetch error/timeout → keep cache unchanged.
 * - Empty open array → keep cache unchanged (missing ≠ flat).
 * - Open legs → upsert and reset flat streak.
 * - explicitFlatLegKeys → increment streak; remove only after 3 consecutive successful flat reads.
 */
function mergeMasterLiveTradesCache(
  strategyId: string,
  fetched: LiveTradeRow[] | null,
  explicitFlatLegKeys: string[],
): LiveTradeRow[] {
  let cache = lastKnownMasterPositions.get(strategyId);
  if (!cache) {
    cache = new Map();
    lastKnownMasterPositions.set(strategyId, cache);
  }

  if (fetched === null) {
    console.log(
      `[live-trades] master cache hold (fetch failed) strategyId=${strategyId} legs=${cache.size}`,
    );
    return sortMasterCachedRows(cache);
  }

  const fetchedKeys = new Set<string>();
  for (const row of fetched) {
    const key = masterLegKeyFromRow(row);
    fetchedKeys.add(key);
    cache.set(key, { row, explicitFlatStreak: 0 });
  }

  const flatSet = new Set(explicitFlatLegKeys);
  const pollsRequired =
    fetched.length === 0
      ? MASTER_EMPTY_BOOK_EVICT_POLLS
      : MASTER_EXPLICIT_FLAT_POLLS_REQUIRED;

  for (const [key, entry] of [...cache.entries()]) {
    if (fetchedKeys.has(key)) continue;

    const isFlat =
      flatSet.has(key) || cacheKeyMatchesExplicitFlat(key, explicitFlatLegKeys);

    const streak = entry.explicitFlatStreak + 1;
    if (streak >= pollsRequired) {
      cache.delete(key);
      console.log(
        `[live-trades] master leg removed after ${streak} flat/missing REST poll(s): ${key}` +
          (isFlat ? " (explicit flat)" : " (absent from snapshot)"),
      );
    } else {
      cache.set(key, { row: entry.row, explicitFlatStreak: streak });
      console.log(
        `[live-trades] master leg flat/missing ${key} streak=${streak}/${pollsRequired}`,
      );
    }
  }

  return sortMasterCachedRows(cache);
}

async function fetchAndMergeMasterLiveTrades(
  strategyId: string,
  apiKey: string,
  apiSecret: string,
  label: string,
  opts?: MasterLiveFetchOpts,
): Promise<{ positions: LiveTradeRow[]; fetchException?: string }> {
  const runOnce = async (timeoutMs: number | null) => {
    const promise = fetchDeltaMarginedPositionSnapshot(apiKey, apiSecret, {
      lite: true,
      skipCache: opts?.background === true,
    });
    const snapshot =
      timeoutMs != null
        ? await withDeltaFetchTimeout(promise, label, timeoutMs)
        : await promise;
    const rows = snapshot.open.map((pos) => deltaToRow(pos));
    const positions = mergeMasterLiveTradesCache(
      strategyId,
      rows,
      snapshot.explicitFlatLegKeys,
    );
    console.log(
      `[live-trades] master snapshot ok strategyId=${strategyId} open=${snapshot.open.length} cached=${positions.length}` +
        (opts?.background ? " (background)" : ""),
    );
    return positions;
  };

  try {
    const timeoutMs = opts?.background ? null : MASTER_LIVE_TRADES_FETCH_TIMEOUT_MS;
    const positions = await runOnce(timeoutMs);
    return { positions };
  } catch (err) {
    const fetchException =
      err instanceof Error ? err.message : String(err ?? "fetch failed");
    const hadCachedLegs = masterCachedPositions(strategyId).length > 0;

    if (!opts?.background && !hadCachedLegs) {
      try {
        console.warn(
          `[live-trades] master snapshot slow retry strategyId=${strategyId} after: ${fetchException}`,
        );
        const positions = await runOnce(null);
        return { positions };
      } catch (retryErr) {
        const retryMsg =
          retryErr instanceof Error
            ? retryErr.message
            : String(retryErr ?? "fetch failed");
        const positions = mergeMasterLiveTradesCache(strategyId, null, []);
        return { positions, fetchException: retryMsg };
      }
    }

    const positions = mergeMasterLiveTradesCache(strategyId, null, []);
    if (positions.length > 0) {
      return { positions };
    }
    return { positions, fetchException };
  }
}

type UserLiveTradesSticky = {
  positions: LiveTradeRow[];
  firstEmptyAt: number | null;
};

const userLiveTradesSticky = new Map<string, UserLiveTradesSticky>();

/** Per user+strategy — short hold when user Delta fetch fails (master uses {@link lastKnownMasterPositions}). */
const USER_LIVE_TRADES_FLAT_CONFIRM_MS = 10_000;

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
  if (now - firstEmpty < USER_LIVE_TRADES_FLAT_CONFIRM_MS) {
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

function withDeltaFetchTimeout<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs: number = DELTA_LIVE_TRADES_FETCH_TIMEOUT_MS,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `${label} timed out after ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
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

    let positions: LiveTradeRow[] = [];
    let fetchException: string | undefined;
    if (credentialsPresent) {
      const merged = await fetchAndMergeMasterLiveTrades(
        strat.id,
        strat.masterApiKey,
        strat.masterApiSecret,
        `master snapshot strategy=${strat.id}`,
      );
      positions = merged.positions;
      fetchException = merged.fetchException;
    }

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
      const merged = await fetchAndMergeMasterLiveTrades(
        sub.strategyId,
        sub.strategy.masterApiKey!,
        sub.strategy.masterApiSecret!,
        `master snapshot strategyId=${sub.strategyId}`,
      );
      masterOpenCount = merged.positions.length;
      if (merged.fetchException) {
        console.warn(
          `[live-trades] master snapshot failed strategyId=${sub.strategyId}:`,
          merged.fetchException,
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

      const masterMergedPromise = credentialsPresent
        ? fetchAndMergeMasterLiveTrades(
            strat.id,
            strat.masterApiKey!,
            strat.masterApiSecret!,
            `master positions strategy=${strat.id}`,
          )
        : Promise.resolve({
            positions: [] as LiveTradeRow[],
            fetchException: undefined,
          });

      const [subs, masterMerged] = await Promise.all([
        subsPromise,
        masterMergedPromise,
      ]);

      if (masterMerged.fetchException) {
        console.error(
          `[live-trades] Master Delta positions threw for "${strat.title}" (${strat.id}):`,
          masterMerged.fetchException,
        );
      }

      const masterMeta = {
        credentialsPresent,
        ...(masterMerged.fetchException !== undefined
          ? { fetchException: masterMerged.fetchException }
          : {}),
      };

      const masterPositions = masterMerged.positions;

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
