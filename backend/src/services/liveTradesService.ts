import {
  type PrismaClient,
  SubscriptionStatus,
  TradeStatus,
  UserStatus,
} from "@prisma/client";
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

/** Public market + PnL enrichment for one master `DeltaLivePosition` row. */
async function enrichMasterPositionRow(
  pos: DeltaLivePosition,
): Promise<LiveTradeRow> {
  const tick = await fetchDeltaTicker(pos.symbolKey);
  const mark =
    tick.last != null && Number.isFinite(tick.last) ? tick.last : null;

  const base = deltaToRow(pos);
  const entryPx =
    base.entryPrice ?? (mark != null && Number.isFinite(mark) ? mark : null);
  const size = Math.abs(pos.contracts);
  let livePnl = base.livePnl;
  if (
    entryPx != null &&
    Number.isFinite(entryPx) &&
    Number.isFinite(size) &&
    mark != null
  ) {
    livePnl = estimateLeaderPnl({
      entryPrice: entryPx,
      side: pos.side,
      size,
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
 * CCXT snapshots of each strategy's master Delta account (India REST via {@link fetchDeltaOpenPositions}).
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
      positions.push(await enrichMasterPositionRow(pos));
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
    entryPrice: p.entryPrice,
    stopLoss: p.stopLoss,
    target: p.takeProfit,
    livePnl: p.unrealizedPnl,
    markPrice: p.markPrice,
    side: p.side,
  };
}

function estimateLeaderPnl(args: {
  entryPrice: number;
  side: TradeSide;
  size: number;
  mark: number | null;
}): number | null {
  const { mark } = args;
  if (mark === null || !Number.isFinite(mark)) return null;
  const diff = mark - args.entryPrice;
  const signed = args.side === "BUY" ? diff : -diff;
  return signed * args.size;
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
      const tick = await fetchDeltaTicker(t.symbol);
      if (tick.last != null && Number.isFinite(tick.last)) {
        markPrice = tick.last;
        const entry = t.entryPrice;
        const diff = markPrice - entry;
        const signed = t.side.toUpperCase() === "BUY" ? diff : -diff;
        livePnl = signed * t.size;
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
      const masterRow = await enrichMasterPositionRow(pos);
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
          userEmail: sub.user.email,
          ...deltaToRow(m),
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
