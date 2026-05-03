import {
  type PrismaClient,
  SubscriptionStatus,
  TradeStatus,
  UserStatus,
} from "@prisma/client";
import {
  fetchCosmicOpenPositions,
  type CosmicLedTrade,
} from "./cosmicClient.js";
import {
  fetchDeltaOpenPositions,
  fetchDeltaTicker,
  type DeltaLivePosition,
  type TradeSide,
} from "./exchangeService.js";

export type LiveTradeRow = {
  entryTime: string | null;
  token: string;
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
  userEmail: string;
};

export type AdminCosmicGroupRow = {
  cosmic: LiveTradeRow;
  followers: AdminFollowerRow[];
};

export type AdminStrategyLiveSection = {
  strategyId: string;
  strategyTitle: string;
  groups: AdminCosmicGroupRow[];
  /** Why Cosmic rows might be empty (does not prove login succeeded). */
  cosmicMeta: {
    scraperEnvConfigured: boolean;
    credentialsPresent: boolean;
  };
};

function compactSymbolKey(s: string): string {
  return s.replace(/[/:]/g, "").toUpperCase();
}

function symbolsAlign(tradeSymbol: string, positionKey: string): boolean {
  const a = compactSymbolKey(tradeSymbol);
  const b = compactSymbolKey(positionKey);
  return a === b || a.endsWith(b) || b.endsWith(a);
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

function cosmicToRow(c: CosmicLedTrade): LiveTradeRow {
  return {
    entryTime: c.openedAt ?? null,
    token: c.deltaSymbol,
    entryPrice: c.entryPrice,
    stopLoss: c.stopLoss ?? null,
    target: c.takeProfit ?? null,
    livePnl: null,
    markPrice: null,
    side: c.side,
  };
}

function deltaToRow(p: DeltaLivePosition): LiveTradeRow {
  return {
    entryTime: p.entryTime,
    token: p.symbolKey,
    entryPrice: p.entryPrice,
    stopLoss: p.stopLoss,
    target: p.takeProfit,
    livePnl: p.unrealizedPnl,
    markPrice: p.markPrice,
    side: p.side,
  };
}

function estimateCosmicPnl(
  c: CosmicLedTrade,
  mark: number | null,
): number | null {
  if (mark === null || !Number.isFinite(mark)) return null;
  const diff = mark - c.entryPrice;
  const signed = c.side === "BUY" ? diff : -diff;
  return signed * c.size;
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

  async function positionsForStrategy(strategyId: string) {
    const creds = strategyToAccount.get(strategyId);
    if (!creds) return [];
    const hit = positionsCache.get(creds.id);
    if (hit) return hit;
    try {
      const list = await fetchDeltaOpenPositions(
        creds.apiKey,
        creds.apiSecret,
      );
      positionsCache.set(creds.id, list);
      return list;
    } catch {
      positionsCache.set(creds.id, []);
      return [];
    }
  }

  const rows: UserLiveTradeRow[] = [];

  for (const t of openTrades) {
    const positions = await positionsForStrategy(t.strategyId);
    const match = matchDeltaPosition(positions, t.symbol, t.side);

    let markPrice: number | null = match?.markPrice ?? null;
    let livePnl: number | null = match?.unrealizedPnl ?? null;
    let stopLoss: number | null = match?.stopLoss ?? null;
    let target: number | null = match?.takeProfit ?? null;
    let entryTime: string | null =
      match?.entryTime ?? t.createdAt.toISOString();

    if (match) {
      entryTime = match.entryTime ?? entryTime;
    } else {
      try {
        const tick = await fetchDeltaTicker(t.symbol);
        if (tick.last !== undefined && Number.isFinite(tick.last)) {
          markPrice = tick.last;
          const entry = t.entryPrice;
          const diff = markPrice - entry;
          const signed = t.side.toUpperCase() === "BUY" ? diff : -diff;
          livePnl = signed * t.size;
        }
      } catch {
        /* ignore */
      }
      entryTime = t.createdAt.toISOString();
    }

    rows.push({
      strategyId: t.strategy.id,
      strategyTitle: t.strategy.title,
      entryTime,
      token: t.symbol,
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
      cosmicEmail: true,
      cosmicPassword: true,
    },
  });

  const scraperEnvConfigured = Boolean(
    process.env.COSMIC_SCRAPER_LOGIN_URL?.trim(),
  );

  const out: AdminStrategyLiveSection[] = [];

  const followerPositionsCache = new Map<string, DeltaLivePosition[]>();

  for (const strat of strategies) {
    const credentialsPresent = Boolean(
      strat.cosmicEmail?.trim() && strat.cosmicPassword?.trim(),
    );

    let cosmicList: CosmicLedTrade[] = [];
    try {
      cosmicList = await fetchCosmicOpenPositions(
        strat.cosmicEmail,
        strat.cosmicPassword,
      );
    } catch {
      cosmicList = [];
    }

    const subs = await prisma.userSubscription.findMany({
      where: {
        strategyId: strat.id,
        status: SubscriptionStatus.ACTIVE,
        user: { status: UserStatus.ACTIVE },
      },
      include: {
        user: { select: { email: true } },
        exchangeAccount: true,
      },
    });

    async function followerPositions(
      accountId: string,
      apiKey: string,
      apiSecret: string,
    ): Promise<DeltaLivePosition[]> {
      const hit = followerPositionsCache.get(accountId);
      if (hit) return hit;
      try {
        const list = await fetchDeltaOpenPositions(apiKey, apiSecret);
        followerPositionsCache.set(accountId, list);
        return list;
      } catch {
        followerPositionsCache.set(accountId, []);
        return [];
      }
    }

    const groups: AdminCosmicGroupRow[] = [];

    if (cosmicList.length === 0) {
      out.push({
        strategyId: strat.id,
        strategyTitle: strat.title,
        groups,
        cosmicMeta: { scraperEnvConfigured, credentialsPresent },
      });
      continue;
    }

    for (const c of cosmicList) {
      let mark: number | null = null;
      try {
        const tick = await fetchDeltaTicker(c.deltaSymbol);
        mark = tick.last ?? null;
      } catch {
        mark = null;
      }

      const cosmicRow: LiveTradeRow = {
        ...cosmicToRow(c),
        markPrice: mark,
        livePnl: estimateCosmicPnl(c, mark),
      };

      const followers: AdminFollowerRow[] = [];

      for (const sub of subs) {
        if (!sub.exchangeAccount) continue;
        const positions = await followerPositions(
          sub.exchangeAccount.id,
          sub.exchangeAccount.apiKey,
          sub.exchangeAccount.apiSecret,
        );
        const m = matchDeltaPosition(positions, c.deltaSymbol, c.side);
        if (!m) continue;
        followers.push({
          userEmail: sub.user.email,
          ...deltaToRow(m),
        });
      }

      groups.push({ cosmic: cosmicRow, followers });
    }

    out.push({
      strategyId: strat.id,
      strategyTitle: strat.title,
      groups,
      cosmicMeta: { scraperEnvConfigured, credentialsPresent },
    });
  }

  return out;
}
