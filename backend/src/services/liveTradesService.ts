import {
  type PrismaClient,
  SubscriptionStatus,
  TradeStatus,
  UserStatus,
} from "@prisma/client";
import {
  fetchDeltaOpenPositions,
  fetchDeltaSwapContractSize,
  fetchDeltaTicker,
  type DeltaLivePosition,
  type TradeSide,
} from "./exchangeService.js";

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
  strategyId: string;
  strategyTitle: string;
};

export type AdminFollowerRow = LiveTradeRow & {
  userId: string;
  userEmail: string;
};

export type AdminMasterGroupRow = {
  /** Symbol key (e.g. ETHUSDT) for this master leg. */
  token: string;
  side: string;
  followers: AdminFollowerRow[];
};

export type AdminStrategyLiveSection = {
  strategyId: string;
  strategyTitle: string;
  /** Open positions on the master Delta (India) account from {@link fetchDeltaOpenPositions} (CCXT). */
  masterPositions: LiveTradeRow[];
  groups: AdminMasterGroupRow[];
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

/** Fresh ticker mark + linear PnL using base size (`realBaseSize`), not raw contract count. */
async function enrichPositionLiveRow(
  pos: DeltaLivePosition,
): Promise<LiveTradeRow> {
  const tick = await fetchDeltaTicker(pos.symbolKey);
  const mark =
    tick.last != null && Number.isFinite(tick.last) ? tick.last : null;

  const base = deltaToRow(pos);
  const entryPx =
    base.entryPrice ?? (mark != null && Number.isFinite(mark) ? mark : null);
  const realSize = pos.realBaseSize;
  let livePnl = base.livePnl;
  if (
    entryPx != null &&
    Number.isFinite(entryPx) &&
    Number.isFinite(realSize) &&
    realSize > 0 &&
    mark != null
  ) {
    livePnl = estimateLeaderPnl({
      entryPrice: entryPx,
      side: pos.side,
      realSize,
      mark,
    });
  }

  return {
    ...base,
    entryPrice: entryPx,
    markPrice: mark ?? base.markPrice,
    livePnl,
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
 * Linear USD-settled perp: `(mark - entry) × realBaseSize × (long ? 1 : -1)`.
 * `realBaseSize` must be contracts × `market.contractSize` (see {@link fetchDeltaOpenPositions}).
 */
function estimateLeaderPnl(args: {
  entryPrice: number;
  side: TradeSide;
  realSize: number;
  mark: number | null;
}): number | null {
  const { mark } = args;
  if (mark === null || !Number.isFinite(mark)) return null;
  const sign = args.side === "BUY" ? 1 : -1;
  return (mark - args.entryPrice) * args.realSize * sign;
}

export async function getUserLiveTradeRows(
  prisma: PrismaClient,
  userId: string,
): Promise<UserLiveTradeRow[]> {
  const openTrades = await prisma.trade.findMany({
    where: { userId, status: TradeStatus.OPEN },
    include: {
      strategy: { select: { id: true, title: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  const subs = await prisma.userSubscription.findMany({
    where: {
      userId,
      status: SubscriptionStatus.ACTIVE,
      user: { status: UserStatus.ACTIVE },
    },
    include: { exchangeAccount: true },
  });

  const strategyToAccount = new Map<
    string,
    { id: string; apiKey: string; apiSecret: string }
  >();
  for (const s of subs) {
    if (!s.exchangeAccount) continue;
    if (!strategyToAccount.has(s.strategyId)) {
      strategyToAccount.set(s.strategyId, {
        id: s.exchangeAccount.id,
        apiKey: s.exchangeAccount.apiKey,
        apiSecret: s.exchangeAccount.apiSecret,
      });
    }
  }

  const positionsCache = new Map<string, DeltaLivePosition[]>();
  const positionsCacheReliable = new Map<string, boolean>();

  async function positionsForStrategy(
    strategyId: string,
  ): Promise<{ positions: DeltaLivePosition[]; reliable: boolean }> {
    const creds = strategyToAccount.get(strategyId);
    if (!creds) return { positions: [], reliable: false };
    const hit = positionsCache.get(creds.id);
    if (hit) {
      return {
        positions: hit,
        reliable: positionsCacheReliable.get(creds.id) ?? true,
      };
    }
    try {
      const list = await fetchDeltaOpenPositions(
        creds.apiKey,
        creds.apiSecret,
      );
      positionsCache.set(creds.id, list);
      positionsCacheReliable.set(creds.id, true);
      return { positions: list, reliable: true };
    } catch {
      positionsCache.set(creds.id, []);
      positionsCacheReliable.set(creds.id, false);
      return { positions: [], reliable: false };
    }
  }

  const rows: UserLiveTradeRow[] = [];

  for (const t of openTrades) {
    const { positions, reliable } = await positionsForStrategy(t.strategyId);
    const match = matchDeltaPosition(positions, t.symbol, t.side);
    if (!match && reliable) {
      await prisma.trade.update({
        where: { id: t.id },
        data: { status: TradeStatus.CLOSED },
      });
      continue;
    }

    let markPrice: number | null = match?.markPrice ?? null;
    let livePnl: number | null = match?.unrealizedPnl ?? null;
    let stopLoss: number | null = match?.stopLoss ?? null;
    let target: number | null = match?.takeProfit ?? null;
    let entryTime: string | null =
      match?.entryTime ?? t.createdAt.toISOString();

    if (match) {
      entryTime = match.entryTime ?? entryTime;
      const tick = await fetchDeltaTicker(match.symbolKey);
      const markFresh =
        tick.last != null && Number.isFinite(tick.last)
          ? tick.last
          : match.markPrice;
      markPrice = markFresh ?? match.markPrice ?? null;
      const entryPx =
        match.entryPrice != null && Number.isFinite(match.entryPrice)
          ? match.entryPrice
          : t.entryPrice;
      const rs = match.realBaseSize;
      if (
        markPrice != null &&
        Number.isFinite(markPrice) &&
        Number.isFinite(entryPx) &&
        Number.isFinite(rs) &&
        rs > 0
      ) {
        livePnl = estimateLeaderPnl({
          entryPrice: entryPx,
          side: match.side,
          realSize: rs,
          mark: markPrice,
        });
      }
    } else {
      const tick = await fetchDeltaTicker(t.symbol);
      if (tick.last != null && Number.isFinite(tick.last)) {
        markPrice = tick.last;
        const contractSize = await fetchDeltaSwapContractSize(t.symbol);
        const realSize = Math.abs(t.size) * contractSize;
        livePnl = estimateLeaderPnl({
          entryPrice: t.entryPrice,
          side: t.side.toUpperCase() === "BUY" ? "BUY" : "SELL",
          realSize,
          mark: markPrice,
        });
      }
      entryTime = t.createdAt.toISOString();
    }

    rows.push({
      strategyId: t.strategy.id,
      strategyTitle: t.strategy.title,
      entryTime,
      token: t.symbol,
      size: t.size,
      entryPrice: t.entryPrice,
      stopLoss,
      target,
      livePnl,
      markPrice,
      side: t.side,
    });
  }

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

    const groups: AdminMasterGroupRow[] = [];
    const masterPositions: LiveTradeRow[] = [];

    if (masterList.length === 0) {
      out.push({
        strategyId: strat.id,
        strategyTitle: strat.title,
        masterPositions,
        groups,
        masterMeta: metaBase,
      });
      continue;
    }

    for (const pos of masterList) {
      const masterRow = await enrichPositionLiveRow(pos);
      masterPositions.push(masterRow);

      const followers: AdminFollowerRow[] = [];

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
        followers.push({
          userId: sub.userId,
          userEmail: sub.user.email,
          ...(await enrichPositionLiveRow(m)),
        });
      }

      groups.push({
        token: pos.symbolKey,
        side: pos.side,
        followers,
      });
    }

    out.push({
      strategyId: strat.id,
      strategyTitle: strat.title,
      masterPositions,
      groups,
      masterMeta: metaBase,
    });
  }

  return out;
}
