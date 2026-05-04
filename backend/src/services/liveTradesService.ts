import {
  type PrismaClient,
  SubscriptionStatus,
  TradeStatus,
  UserStatus,
} from "@prisma/client";
import {
  fetchCosmicOpenPositionsWithMeta,
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

export type CosmicScrapeDiagnostics = {
  payloadChunkCount: number;
  payloadPositionRows: number;
  tradesAfterDeltaFilter: number;
  domRowsMatched?: number;
  domPositionsParsed?: number;
  walletBalanceDom?: string | null;
  scrapeAbortedReason?: string;
  extractError?: string;
};

export type AdminStrategyLiveSection = {
  strategyId: string;
  strategyTitle: string;
  groups: AdminCosmicGroupRow[];
  /** Why Cosmic rows might be empty (does not prove login succeeded). */
  cosmicMeta: {
    scraperEnvConfigured: boolean;
    credentialsPresent: boolean;
    /** Set when Puppeteer / scrape threw before returning structured meta. */
    fetchException?: string;
    /** Latest headless scrape stats (admin Live trades runs one scrape per load). */
    lastScrape?: CosmicScrapeDiagnostics;
  };
};

function compactSymbolKey(s: string): string {
  return s.replace(/[/:]/g, "").toUpperCase();
}

/** ETHUSDT (Cosmic) vs ETHUSD (older keys) — same underlying on Delta India. */
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
      cosmicEmail: true,
      cosmicPassword: true,
      scraperMappings: true,
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
    let fetchException: string | undefined;
    let lastScrape: CosmicScrapeDiagnostics | undefined;
    try {
      const scraped = await fetchCosmicOpenPositionsWithMeta(
        strat.cosmicEmail,
        strat.cosmicPassword,
        strat.scraperMappings,
      );
      cosmicList = scraped.trades;
      const m = scraped.scrapeMeta;
      const diag: CosmicScrapeDiagnostics = {
        payloadChunkCount: scraped.payloadChunkCount,
        payloadPositionRows: scraped.payloadPositionRows,
        tradesAfterDeltaFilter: scraped.trades.length,
        walletBalanceDom: m?.walletBalanceDom ?? null,
      };
      if (m?.domRowsMatched !== undefined) diag.domRowsMatched = m.domRowsMatched;
      if (m?.domPositionsParsed !== undefined) {
        diag.domPositionsParsed = m.domPositionsParsed;
      }
      if (m?.scrapeAbortedReason !== undefined) {
        diag.scrapeAbortedReason = m.scrapeAbortedReason;
      }
      if (m?.extractError !== undefined) diag.extractError = m.extractError;
      lastScrape = diag;
    } catch (err) {
      cosmicList = [];
      fetchException =
        err instanceof Error ? err.message : String(err ?? "scrape failed");
      console.error(
        `[live-trades] Cosmic scrape threw for "${strat.title}" (${strat.id}):`,
        fetchException,
      );
    }

    const metaBase = {
      scraperEnvConfigured,
      credentialsPresent,
      ...(fetchException !== undefined ? { fetchException } : {}),
      ...(lastScrape !== undefined ? { lastScrape } : {}),
    };

    if (
      scraperEnvConfigured &&
      credentialsPresent &&
      cosmicList.length === 0
    ) {
      console.warn(
        `[live-trades] Zero Cosmic positions for "${strat.title}" (${strat.id}). ` +
          `domRows=${lastScrape?.domRowsMatched ?? "?"}, domParsed=${lastScrape?.domPositionsParsed ?? "?"}, ` +
          `payloadRows=${lastScrape?.payloadPositionRows ?? "?"}, deltaTrades=${lastScrape?.tradesAfterDeltaFilter ?? "?"}, ` +
          `abort=${lastScrape?.scrapeAbortedReason ?? "none"}, extract=${lastScrape?.extractError ?? "none"}, ` +
          `fetchErr=${fetchException ?? "none"}`,
      );
    }

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

    const groups: AdminCosmicGroupRow[] = [];

    if (cosmicList.length === 0) {
      out.push({
        strategyId: strat.id,
        strategyTitle: strat.title,
        groups,
        cosmicMeta: metaBase,
      });
      continue;
    }

    for (const c of cosmicList) {
      const tick = await fetchDeltaTicker(c.deltaSymbol);
      const mark =
        tick.last != null && Number.isFinite(tick.last) ? tick.last : null;

      const cosmicRow: LiveTradeRow = {
        ...cosmicToRow(c),
        markPrice: mark,
        livePnl: estimateCosmicPnl(c, mark),
      };

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
      cosmicMeta: metaBase,
    });
  }

  return out;
}
