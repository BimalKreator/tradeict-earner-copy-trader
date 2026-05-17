import {
  type PrismaClient,
  SubscriptionStatus,
  TradeStatus,
  UserStatus,
} from "@prisma/client";
import {
  fetchDeltaMarkPrice,
  fetchDeltaOpenPositions,
  type DeltaLivePosition,
  type TradeSide,
} from "./exchangeService.js";
import {
  estimateLivePnlUsd,
  resolveLiveMarkPrice,
} from "./liveMarkPriceCache.js";
import { registerSymbolsForLivePrices } from "./livePriceTracker.js";

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

/** Active subscriber with all matched open legs on Delta (grouped by user). */
export type AdminSubscriberUserSection = {
  userId: string;
  userEmail: string;
  multiplier: number;
  positions: LiveTradeRow[];
};

export type AdminStrategyLiveSection = {
  strategyId: string;
  strategyTitle: string;
  autoExitTarget: number | null;
  autoExitStopLoss: number | null;
  /** Open positions on the master Delta (India) account from {@link fetchDeltaOpenPositions} (CCXT). */
  masterPositions: LiveTradeRow[];
  subscribers: AdminSubscriberUserSection[];
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

/** Mark from WS cache → CCXT position mark → REST mark (never LTP / last / bid / ask). */
async function resolveMarkForLiveRow(
  pos: DeltaLivePosition,
): Promise<number | null> {
  const cached = resolveLiveMarkPrice(pos.symbolKey);
  if (cached != null) return cached;
  if (
    pos.markPrice != null &&
    Number.isFinite(pos.markPrice) &&
    pos.markPrice > 0
  ) {
    return pos.markPrice;
  }
  const rest = await fetchDeltaMarkPrice(pos.symbolKey);
  return rest.markPrice;
}

/** Mark + PnL for dashboards: native Delta UPNL first; manual estimate only if missing. */
async function enrichPositionLiveRow(
  pos: DeltaLivePosition,
): Promise<LiveTradeRow> {
  registerSymbolsForLivePrices([pos.symbolKey]);
  const mark = await resolveMarkForLiveRow(pos);

  const base = deltaToRow(pos);
  const entryPx =
    base.entryPrice ?? (mark != null && Number.isFinite(mark) ? mark : null);
  const realSize = pos.realBaseSize;
  const contractSize =
    pos.contracts > 0 && pos.realBaseSize > 0
      ? pos.realBaseSize / Math.abs(pos.contracts)
      : undefined;

  let livePnl = base.livePnl;
  if (
    mark != null &&
    entryPx != null &&
    Number.isFinite(entryPx) &&
    Number.isFinite(realSize) &&
    realSize > 0
  ) {
    livePnl = estimateLivePnlUsd({
      symbolKey: pos.symbolKey,
      side: pos.side,
      entryPrice: entryPx,
      contracts: pos.contracts,
      markPrice: mark,
      ...(contractSize != null ? { contractSize } : {}),
    });
  } else if (livePnl == null || !Number.isFinite(livePnl)) {
    livePnl = base.livePnl;
  }

  return {
    ...base,
    entryPrice: entryPx,
    markPrice: mark ?? base.markPrice,
    livePnl,
  };
}

type UserDeltaCreds = {
  cacheKey: string;
  apiKey: string;
  apiSecret: string;
};

async function resolveUserDeltaCredentialSets(
  prisma: PrismaClient,
  userId: string,
): Promise<UserDeltaCreds[]> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      exchangeAccounts: { orderBy: { createdAt: "desc" } },
      deltaApiKeys: { orderBy: { id: "desc" } },
    },
  });
  if (!user) return [];

  const out: UserDeltaCreds[] = [];
  const seen = new Set<string>();

  for (const ex of user.exchangeAccounts) {
    const key = ex.apiKey?.trim() ?? "";
    const secret = ex.apiSecret?.trim() ?? "";
    if (!key || !secret) continue;
    const cacheKey = `ex:${ex.id}`;
    if (seen.has(cacheKey)) continue;
    seen.add(cacheKey);
    out.push({ cacheKey, apiKey: ex.apiKey, apiSecret: ex.apiSecret });
  }

  for (const dk of user.deltaApiKeys) {
    const key = dk.apiKey?.trim() ?? "";
    const secret = dk.apiSecret?.trim() ?? "";
    if (!key || !secret) continue;
    const cacheKey = `dk:${dk.id}`;
    if (seen.has(cacheKey)) continue;
    seen.add(cacheKey);
    out.push({ cacheKey, apiKey: dk.apiKey, apiSecret: dk.apiSecret });
  }

  return out;
}

function matchOpenTradeStrategy(
  openTrades: Array<{
    symbol: string;
    side: string;
    strategy: { id: string; title: string };
  }>,
  symbolKey: string,
  side: TradeSide,
): { id: string; title: string } | null {
  for (const t of openTrades) {
    if (!symbolsAlign(t.symbol, symbolKey)) continue;
    if (!sidesAlign(t.side, side)) continue;
    return { id: t.strategy.id, title: t.strategy.title };
  }
  return null;
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

function compactSymbolKey(s: string): string {
  return s.replace(/[/:]/g, "").toUpperCase();
}

/** ETHUSDT vs ETHUSD — same underlying on Delta India. */
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

function sidesAlign(tradeSide: string, posSide: TradeSide): boolean {
  const t = tradeSide.toUpperCase();
  return t === posSide;
}

function matchDeltaPosition(
  positions: DeltaLivePosition[],
  tradeSymbol: string,
  tradeSide: string,
): DeltaLivePosition | undefined {
  return positions.find(
    (p) =>
      symbolsAlign(tradeSymbol, p.symbolKey) && sidesAlign(tradeSide, p.side),
  );
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
 * All open Delta positions for the user via CCXT (includes manual trades not in DB).
 * Optional strategy label when an OPEN copy-trade row matches symbol + side.
 */
export async function getUserLiveTradeRows(
  prisma: PrismaClient,
  userId: string,
): Promise<UserLiveTradeRow[]> {
  const credsList = await resolveUserDeltaCredentialSets(prisma, userId);
  if (credsList.length === 0) return [];

  const openTrades = await prisma.trade.findMany({
    where: { userId, status: TradeStatus.OPEN },
    include: { strategy: { select: { id: true, title: true } } },
  });

  const rows: UserLiveTradeRow[] = [];
  const seenLegs = new Set<string>();

  for (const creds of credsList) {
    let positions: DeltaLivePosition[];
    try {
      positions = await fetchDeltaOpenPositions(creds.apiKey, creds.apiSecret);
    } catch (err) {
      console.warn(
        `[live-trades] user CCXT fetch failed userId=${userId}:`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }

    for (const pos of positions) {
      const legKey = `${creds.cacheKey}:${pos.symbolKey}:${pos.side}`;
      if (seenLegs.has(legKey)) continue;
      seenLegs.add(legKey);

      const strat = matchOpenTradeStrategy(openTrades, pos.symbolKey, pos.side);
      const enriched = await enrichPositionLiveRow(pos);

      rows.push({
        strategyId: strat?.id ?? null,
        strategyTitle: strat?.title ?? "Manual on Delta",
        entryTime: enriched.entryTime,
        token: enriched.token,
        size: enriched.size,
        entryPrice: enriched.entryPrice,
        stopLoss: null,
        target: null,
        livePnl: enriched.livePnl,
        markPrice: enriched.markPrice,
        side: enriched.side,
      });
    }
  }

  rows.sort((a, b) => {
    const ta = a.entryTime ?? "";
    const tb = b.entryTime ?? "";
    return tb.localeCompare(ta);
  });

  return rows;
}

export async function getAdminGroupedLiveTrades(
  prisma: PrismaClient,
): Promise<AdminStrategyLiveSection[]> {
  const strategies = await prisma.strategy.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      title: true,
      masterApiKey: true,
      masterApiSecret: true,
      autoExitTarget: true,
      autoExitStopLoss: true,
    },
  });

  const out: AdminStrategyLiveSection[] = [];

  const followerPositionsCache = new Map<string, DeltaLivePosition[]>();

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
        console.error(
          `[live-trades] Master Delta positions threw for "${strat.title}" (${strat.id}):`,
          fetchException,
        );
      }
    }

    const metaBase = {
      credentialsPresent,
      ...(fetchException !== undefined ? { fetchException } : {}),
    };

    const subs = await prisma.userSubscription.findMany({
      where: {
        strategyId: strat.id,
        status: SubscriptionStatus.ACTIVE,
        user: { status: UserStatus.ACTIVE },
      },
      include: {
        user: { select: { email: true, deltaApiKeys: true } },
        exchangeAccount: true,
      },
    });

    async function followerPositions(
      cacheKey: string,
      apiKey: string,
      apiSecret: string,
    ): Promise<DeltaLivePosition[]> {
      const hit = followerPositionsCache.get(cacheKey);
      if (hit) return hit;
      try {
        const list = await fetchDeltaOpenPositions(apiKey, apiSecret);
        followerPositionsCache.set(cacheKey, list);
        return list;
      } catch {
        followerPositionsCache.set(cacheKey, []);
        return [];
      }
    }

    const masterPositions: LiveTradeRow[] = [];
    const subscriberMap = new Map<string, AdminSubscriberUserSection>();

    const upsertSubscriberPosition = async (
      sub: (typeof subs)[number],
      deltaPos: DeltaLivePosition,
    ): Promise<void> => {
      const legKey = `${deltaPos.symbolKey}:${deltaPos.side}`;
      let section = subscriberMap.get(sub.userId);
      if (!section) {
        section = {
          userId: sub.userId,
          userEmail: sub.user.email,
          multiplier: sub.multiplier,
          positions: [],
        };
        subscriberMap.set(sub.userId, section);
      }
      if (
        section.positions.some(
          (p) => `${p.token}:${p.side}` === legKey,
        )
      ) {
        return;
      }
      section.positions.push(await enrichPositionLiveRow(deltaPos));
    };

    if (masterList.length === 0) {
      out.push({
        strategyId: strat.id,
        strategyTitle: strat.title,
        autoExitTarget: strat.autoExitTarget,
        autoExitStopLoss: strat.autoExitStopLoss,
        masterPositions,
        subscribers: [],
        masterMeta: metaBase,
      });
      continue;
    }

    for (const pos of masterList) {
      const masterRow = await enrichPositionLiveRow(pos);
      masterPositions.push(masterRow);

      for (const sub of subs) {
        const creds =
          sub.exchangeAccount != null
            ? {
                cacheKey: `ex:${sub.exchangeAccount.id}`,
                apiKey: sub.exchangeAccount.apiKey,
                apiSecret: sub.exchangeAccount.apiSecret,
              }
            : sub.user.deltaApiKeys[0] != null
              ? {
                  cacheKey: `legacy:${sub.userId}:${sub.user.deltaApiKeys[0]!.id}`,
                  apiKey: sub.user.deltaApiKeys[0]!.apiKey,
                  apiSecret: sub.user.deltaApiKeys[0]!.apiSecret,
                }
              : null;
        if (!creds) continue;

        const positions = await followerPositions(
          creds.cacheKey,
          creds.apiKey,
          creds.apiSecret,
        );
        const m = matchDeltaPosition(positions, pos.symbolKey, pos.side);
        if (!m) continue;
        await upsertSubscriberPosition(sub, m);
      }
    }

    const subscribers = Array.from(subscriberMap.values()).sort((a, b) =>
      a.userEmail.localeCompare(b.userEmail),
    );

    out.push({
      strategyId: strat.id,
      strategyTitle: strat.title,
      autoExitTarget: strat.autoExitTarget,
      autoExitStopLoss: strat.autoExitStopLoss,
      masterPositions,
      subscribers,
      masterMeta: metaBase,
    });
  }

  return out;
}
