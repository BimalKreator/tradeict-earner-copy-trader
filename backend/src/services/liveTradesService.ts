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
import { COPY_SUBSCRIPTION_INCLUDE } from "./strategySubscriptionService.js";
import { FUTURE_HEDGE_STRATEGY_TITLE } from "../constants/strategyTitles.js";

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
        masterList = await fetchDeltaOpenPositions(
          strat.masterApiKey,
          strat.masterApiSecret,
        );
      } catch (err) {
        fetchException =
          err instanceof Error ? err.message : String(err ?? "fetch failed");
        masterList = [];
      }
    }

    const positions: LiveTradeRow[] = [];
    for (const pos of masterList) {
      positions.push(await enrichPositionLiveRow(pos));
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

type SubscriberCreds = {
  cacheKey: string;
  apiKey: string;
  apiSecret: string;
};

function resolveSubscriberCreds(sub: {
  userId: string;
  exchangeAccount: { id: string; apiKey: string; apiSecret: string } | null;
  user: {
    deltaApiKeys: { id: string; apiKey: string; apiSecret: string }[];
    exchangeAccounts: { id: string; apiKey: string; apiSecret: string }[];
  };
}): SubscriberCreds | null {
  if (sub.exchangeAccount != null) {
    const key = sub.exchangeAccount.apiKey?.trim() ?? "";
    const secret = sub.exchangeAccount.apiSecret?.trim() ?? "";
    if (!key || !secret) return null;
    return {
      cacheKey: `ex:${sub.exchangeAccount.id}`,
      apiKey: sub.exchangeAccount.apiKey,
      apiSecret: sub.exchangeAccount.apiSecret,
    };
  }
  const ex = sub.user.exchangeAccounts[0];
  if (ex != null) {
    const key = ex.apiKey?.trim() ?? "";
    const secret = ex.apiSecret?.trim() ?? "";
    if (!key || !secret) return null;
    return {
      cacheKey: `ex:${ex.id}`,
      apiKey: ex.apiKey,
      apiSecret: ex.apiSecret,
    };
  }
  const dk = sub.user.deltaApiKeys[0];
  if (dk != null) {
    const key = dk.apiKey?.trim() ?? "";
    const secret = dk.apiSecret?.trim() ?? "";
    if (!key || !secret) return null;
    return {
      cacheKey: `dk:${dk.id}`,
      apiKey: dk.apiKey,
      apiSecret: dk.apiSecret,
    };
  }
  return null;
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
    const creds = resolveSubscriberCreds(sub);
    const userPositions: LiveTradeRow[] = [];

    if (creds) {
      try {
        const positions = await fetchDeltaOpenPositions(
          creds.apiKey,
          creds.apiSecret,
        );
        for (const pos of positions) {
          userPositions.push(await enrichPositionLiveRow(pos));
        }
        userPositions.sort((a, b) =>
          (b.entryTime ?? "").localeCompare(a.entryTime ?? ""),
        );
      } catch (err) {
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
        const masterList = await fetchDeltaOpenPositions(
          sub.strategy.masterApiKey!,
          sub.strategy.masterApiSecret!,
        );
        masterOpenCount = masterList.length;
      } catch (err) {
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
      autoExitTarget: true,
      autoExitStopLoss: true,
    },
  });

  if (strategies.length === 0) return [];

  const out: AdminLiveTradesGroup[] = [];
  const followerPositionsCache = new Map<string, DeltaLivePosition[]>();

  async function cachedFollowerPositions(
    creds: SubscriberCreds,
  ): Promise<DeltaLivePosition[]> {
    const hit = followerPositionsCache.get(creds.cacheKey);
    if (hit) return hit;
    try {
      const list = await fetchDeltaOpenPositions(creds.apiKey, creds.apiSecret);
      followerPositionsCache.set(creds.cacheKey, list);
      return list;
    } catch {
      followerPositionsCache.set(creds.cacheKey, []);
      return [];
    }
  }

  for (const strat of strategies) {
    const strategy: LiveStrategySummary = {
      id: strat.id,
      title: strat.title,
      isActive: strat.isActive,
      autoExitTarget: strat.autoExitTarget,
      autoExitStopLoss: strat.autoExitStopLoss,
    };

    const credentialsPresent = Boolean(
      strat.masterApiKey?.trim() && strat.masterApiSecret?.trim(),
    );

    let masterList: DeltaLivePosition[] = [];
    let fetchException: string | undefined;
    if (credentialsPresent) {
      try {
        masterList = await fetchDeltaOpenPositions(
          strat.masterApiKey,
          strat.masterApiSecret,
        );
      } catch (err) {
        fetchException =
          err instanceof Error ? err.message : String(err ?? "fetch failed");
        masterList = [];
        console.error(
          `[live-trades] Master Delta positions threw for "${strat.title}" (${strat.id}):`,
          fetchException,
        );
      }
    }

    const masterMeta = {
      credentialsPresent,
      ...(fetchException !== undefined ? { fetchException } : {}),
    };

    const masterPositions: LiveTradeRow[] = [];
    for (const pos of masterList) {
      masterPositions.push(await enrichPositionLiveRow(pos));
    }

    const subs = await prisma.userStrategySubscription.findMany({
      where: {
        strategyId: strat.id,
        isActive: true,
        status: SubscriptionStatus.ACTIVE,
        user: { status: UserStatus.ACTIVE },
      },
      include: {
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
        exchangeAccount: true,
      },
    });

    const subscribers: AdminLiveTradesSubscriber[] = [];

    for (const sub of subs) {
      const creds = resolveSubscriberCreds(sub);
      const positions: LiveTradeRow[] = [];
      if (creds) {
        const deltaList = await cachedFollowerPositions(creds);
        for (const pos of deltaList) {
          positions.push(await enrichPositionLiveRow(pos));
        }
        positions.sort((a, b) =>
          (b.entryTime ?? "").localeCompare(a.entryTime ?? ""),
        );
      }

      subscribers.push({
        userId: sub.userId,
        userEmail: sub.user.email,
        userName: sub.user.name,
        multiplier: sub.multiplier,
        syncStatus: sub.syncStatus,
        syncError: sub.syncError,
        positions,
      });
    }

    subscribers.sort((a, b) => a.userEmail.localeCompare(b.userEmail));

    out.push({
      strategy,
      masterPositions,
      subscribers,
      masterMeta,
    });
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
