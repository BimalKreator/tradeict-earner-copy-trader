import {
  InvoiceStatus,
  Role,
  SubscriptionStatus,
  TradeStatus,
  UserStatus,
  type PrismaClient,
} from "@prisma/client";
import { decryptDeltaSecretOrPlain } from "../utils/encryption.js";
import {
  type DeltaBalanceBreakdown,
  fetchDeltaAvailableBalanceUsd,
  fetchDeltaBalanceBreakdownUsd,
  fetchDeltaSwapContractSize,
  fetchDeltaTicker,
  type TradeSide,
} from "./exchangeService.js";
import {
  deltaContractSizeFallback,
  estimateLivePnlUsd,
  resolveLiveMarkPrice,
} from "./liveMarkPriceCache.js";
import { registerSymbolsForLivePrices } from "./livePriceTracker.js";
import { FUTURE_HEDGE_STRATEGY_TITLE } from "../constants/strategyTitles.js";

export type { DeltaBalanceBreakdown };

export function startOfUtcDay(ref = new Date()): Date {
  return new Date(
    Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate()),
  );
}

export function endOfUtcDay(ref = new Date()): Date {
  return new Date(
    Date.UTC(
      ref.getUTCFullYear(),
      ref.getUTCMonth(),
      ref.getUTCDate(),
      23,
      59,
      59,
      999,
    ),
  );
}

export function startOfUtcMonth(ref = new Date()): Date {
  return new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), 1));
}

export function realizedTradePnl(trade: {
  tradePnl: number;
  pnl: number | null;
}): number {
  if (Number.isFinite(trade.tradePnl) && trade.tradePnl !== 0) {
    return trade.tradePnl;
  }
  return Number.isFinite(trade.pnl ?? NaN) ? (trade.pnl as number) : 0;
}

export function strategyShortName(title: string): string {
  const t = title.trim();
  if (t.length <= 28) return t;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return `${words[0]} ${words[1]}`.slice(0, 28);
  }
  return `${t.slice(0, 25)}…`;
}

export function pnlPercentOfCapital(pnl: number, capital: number): number {
  if (!Number.isFinite(capital) || capital <= 0) return 0;
  return (pnl / capital) * 100;
}

type UserCreds = { apiKey: string; apiSecret: string };

function credsFromRow(row: {
  apiKey: string;
  apiSecret: string;
} | null | undefined): UserCreds | null {
  if (!row?.apiKey?.trim() || !row?.apiSecret?.trim()) return null;
  return { apiKey: row.apiKey, apiSecret: row.apiSecret };
}

/** True when stored credentials match any strategy leader (master) API key pair. */
export async function credentialsMatchStrategyMaster(
  prisma: PrismaClient,
  creds: UserCreds,
): Promise<boolean> {
  const userKey = decryptDeltaSecretOrPlain(creds.apiKey).trim();
  const userSecret = decryptDeltaSecretOrPlain(creds.apiSecret).trim();
  if (!userKey || !userSecret) return false;

  const strategies = await prisma.strategy.findMany({
    where: {
      masterApiKey: { not: "" },
      masterApiSecret: { not: "" },
    },
    select: { masterApiKey: true, masterApiSecret: true },
  });

  for (const s of strategies) {
    const masterKey = decryptDeltaSecretOrPlain(s.masterApiKey).trim();
    const masterSecret = decryptDeltaSecretOrPlain(s.masterApiSecret).trim();
    if (masterKey && masterSecret && masterKey === userKey && masterSecret === userSecret) {
      return true;
    }
  }
  return false;
}

/**
 * Resolve the subscriber's Delta credentials (never strategy master keys).
 * Priority: active subscription's linked exchange account → latest deltaApiKey → latest exchangeAccount.
 */
export async function resolveUserDeltaCreds(
  prisma: PrismaClient,
  userId: string,
): Promise<UserCreds | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      subscriptions: {
        where: {
          status: SubscriptionStatus.ACTIVE,
          exchangeAccountId: { not: null },
        },
        orderBy: { joinedDate: "desc" },
        take: 1,
        select: {
          exchangeAccount: {
            select: { apiKey: true, apiSecret: true },
          },
        },
      },
      deltaApiKeys: {
        orderBy: { id: "desc" },
        take: 1,
        select: { apiKey: true, apiSecret: true },
      },
      exchangeAccounts: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { apiKey: true, apiSecret: true },
      },
    },
  });
  if (!user) return null;

  const candidates: UserCreds[] = [];
  const subCreds = credsFromRow(user.subscriptions[0]?.exchangeAccount ?? null);
  if (subCreds) candidates.push(subCreds);
  const deltaCreds = credsFromRow(user.deltaApiKeys[0] ?? null);
  if (deltaCreds) candidates.push(deltaCreds);
  const exchangeCreds = credsFromRow(user.exchangeAccounts[0] ?? null);
  if (exchangeCreds) candidates.push(exchangeCreds);

  for (const creds of candidates) {
    if (await credentialsMatchStrategyMaster(prisma, creds)) {
      continue;
    }
    return creds;
  }
  return null;
}

const ZERO_BREAKDOWN: DeltaBalanceBreakdown = {
  totalBalance: 0,
  availableBalance: 0,
  usedBalance: 0,
};

export async function fetchUserCapitalBreakdown(
  prisma: PrismaClient,
  userId: string,
): Promise<DeltaBalanceBreakdown> {
  const creds = await resolveUserDeltaCreds(prisma, userId);
  if (!creds) return { ...ZERO_BREAKDOWN };
  try {
    return await fetchDeltaBalanceBreakdownUsd(creds.apiKey, creds.apiSecret);
  } catch {
    return { ...ZERO_BREAKDOWN };
  }
}

export async function fetchUserAvailableCapital(
  prisma: PrismaClient,
  userId: string,
): Promise<number> {
  const breakdown = await fetchUserCapitalBreakdown(prisma, userId);
  return breakdown.availableBalance;
}

export async function checkDeltaApiConnected(
  creds: UserCreds,
): Promise<boolean> {
  try {
    const bal = await fetchDeltaAvailableBalanceUsd(creds.apiKey, creds.apiSecret);
    return Number.isFinite(bal);
  } catch {
    return false;
  }
}

export async function sumClosedTradePnlSince(
  prisma: PrismaClient,
  userId: string,
  since: Date,
): Promise<number> {
  const trades = await prisma.trade.findMany({
    where: {
      userId,
      status: TradeStatus.CLOSED,
      createdAt: { gte: since },
    },
    select: { tradePnl: true, pnl: true },
  });
  return trades.reduce((s, t) => s + realizedTradePnl(t), 0);
}

/** All-time realized PnL from CLOSED trades only (gross booked). */
export async function sumAllClosedTradePnl(
  prisma: PrismaClient,
  userId: string,
): Promise<number> {
  const trades = await prisma.trade.findMany({
    where: { userId, status: TradeStatus.CLOSED },
    select: { tradePnl: true, pnl: true },
  });
  return trades.reduce((s, t) => s + realizedTradePnl(t), 0);
}

export type BookedPnlAndRevenueDue = {
  /** Sum of realized PnL on CLOSED trades in the window (ignores open/floating). */
  grossBookedPnl: number;
  /**
   * Per-strategy: max(0, net booked PnL) × profitShare%.
   * Losses reduce net booked; if net ≤ 0 for a strategy, its due is $0.
   */
  revenueSharingDue: number;
};

/**
 * Gross booked PnL and revenue-sharing due from CLOSED trades only.
 * @param since — UTC start of window; `null` = all-time.
 */
export async function computeUserBookedPnlAndRevenueDue(
  prisma: PrismaClient,
  userId: string,
  since: Date | null,
): Promise<BookedPnlAndRevenueDue> {
  const trades = await prisma.trade.findMany({
    where: {
      userId,
      status: TradeStatus.CLOSED,
      ...(since ? { createdAt: { gte: since } } : {}),
    },
    select: { strategyId: true, tradePnl: true, pnl: true },
  });

  let grossBookedPnl = 0;
  const pnlByStrategy = new Map<string, number>();

  for (const t of trades) {
    const pnl = realizedTradePnl(t);
    grossBookedPnl += pnl;
    pnlByStrategy.set(t.strategyId, (pnlByStrategy.get(t.strategyId) ?? 0) + pnl);
  }

  if (pnlByStrategy.size === 0) {
    return { grossBookedPnl: 0, revenueSharingDue: 0 };
  }

  const strategies = await prisma.strategy.findMany({
    where: { id: { in: [...pnlByStrategy.keys()] } },
    select: { id: true, profitShare: true },
  });
  const sharePctById = new Map(strategies.map((s) => [s.id, s.profitShare]));

  let revenueSharingDue = 0;
  for (const [strategyId, netBooked] of pnlByStrategy) {
    if (netBooked <= 0) continue;
    const pct = sharePctById.get(strategyId) ?? 0;
    revenueSharingDue += netBooked * (pct / 100);
  }

  return { grossBookedPnl, revenueSharingDue };
}

/** Calendar-month subscription fee renewal — days until next joinedDate anniversary. */
export function daysUntilNextMonthlyFee(
  joinedDate: Date,
  ref = new Date(),
): number {
  const anchor = new Date(joinedDate);
  let next = new Date(
    Date.UTC(
      anchor.getUTCFullYear(),
      anchor.getUTCMonth(),
      anchor.getUTCDate(),
    ),
  );
  while (next.getTime() <= ref.getTime()) {
    next = new Date(
      Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()),
    );
  }
  const diffMs = next.getTime() - ref.getTime();
  return Math.max(0, Math.ceil(diffMs / 86_400_000));
}

export type ActiveStrategiesSummary = {
  count: number;
  names: string[];
  /** Soonest subscription fee renewal among active subs; null when none. */
  daysUntilNextFee: number | null;
};

export async function monthlyWinRate(
  prisma: PrismaClient,
  userId: string,
): Promise<number> {
  const monthStart = startOfUtcMonth();
  const trades = await prisma.trade.findMany({
    where: {
      userId,
      status: TradeStatus.CLOSED,
      createdAt: { gte: monthStart },
    },
    select: { tradePnl: true, pnl: true },
  });
  if (trades.length === 0) return 0;
  const wins = trades.filter((t) => realizedTradePnl(t) > 0).length;
  return (wins / trades.length) * 100;
}

export async function userTotalDue(prisma: PrismaClient, userId: string): Promise<number> {
  const agg = await prisma.invoice.aggregate({
    where: {
      userId,
      status: { in: [InvoiceStatus.PENDING, InvoiceStatus.OVERDUE] },
    },
    _sum: { amountDue: true },
  });
  return agg._sum.amountDue ?? 0;
}

export async function activeStrategiesForUser(
  prisma: PrismaClient,
  userId: string,
): Promise<ActiveStrategiesSummary> {
  const subs = await prisma.userStrategySubscription.findMany({
    where: { userId, status: SubscriptionStatus.ACTIVE },
    include: { strategy: { select: { title: true } } },
    orderBy: { joinedDate: "desc" },
  });

  let daysUntilNextFee: number | null = null;
  if (subs.length > 0) {
    daysUntilNextFee = Math.min(
      ...subs.map((s) => daysUntilNextMonthlyFee(s.joinedDate)),
    );
  }

  return {
    count: subs.length,
    names: subs.map((s) => strategyShortName(s.strategy.title)),
    daysUntilNextFee,
  };
}

/**
 * Total AUM: sum of live Delta total balances — same source as admin Users list (`deltaBalance`).
 */
export async function aggregateUsersAum(prisma: PrismaClient): Promise<number> {
  return sumAdminUsersDeltaBalances(prisma);
}

/** Per-user Delta balance fetch timeout (admin list + dashboard AUM). */
export const ADMIN_DELTA_BALANCE_TIMEOUT_MS = 12_000;
/** Max concurrent Delta balance API calls for admin aggregation. */
export const ADMIN_DELTA_BALANCE_CONCURRENCY = 4;

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = nextIndex;
      nextIndex += 1;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  }
  const workers = Math.min(Math.max(1, concurrency), items.length || 1);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

/** Same live Delta total balance shown on GET /api/admin/users (`deltaBalance`). */
export async function fetchUserDeltaBalanceForAdmin(
  prisma: PrismaClient,
  userId: string,
): Promise<{ deltaBalance: number | null; deltaConnected: boolean }> {
  const creds = await resolveUserDeltaCreds(prisma, userId);
  if (!creds) {
    return { deltaBalance: null, deltaConnected: false };
  }
  try {
    const breakdown = await Promise.race([
      fetchUserCapitalBreakdown(prisma, userId),
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error("Delta balance fetch timed out")),
          ADMIN_DELTA_BALANCE_TIMEOUT_MS,
        );
      }),
    ]);
    return {
      deltaBalance: breakdown.totalBalance,
      deltaConnected: true,
    };
  } catch (err) {
    console.warn(
      `[admin-aum] Delta balance fetch failed userId=${userId}:`,
      err instanceof Error ? err.message : err,
    );
    return { deltaBalance: null, deltaConnected: true };
  }
}

/** Sum of `deltaBalance` across all platform users (matches admin Users list column). */
export async function sumAdminUsersDeltaBalances(
  prisma: PrismaClient,
): Promise<number> {
  const users = await prisma.user.findMany({
    where: { role: Role.USER },
    select: { id: true },
    orderBy: { createdAt: "desc" },
  });

  const rows = await mapWithConcurrency(
    users,
    ADMIN_DELTA_BALANCE_CONCURRENCY,
    async (user) => fetchUserDeltaBalanceForAdmin(prisma, user.id),
  );

  return rows.reduce(
    (sum, row) =>
      sum +
      (row.deltaBalance != null && Number.isFinite(row.deltaBalance)
        ? row.deltaBalance
        : 0),
    0,
  );
}

async function resolveMarkForOpenTrade(symbol: string): Promise<number | null> {
  registerSymbolsForLivePrices([symbol]);
  const cached = resolveLiveMarkPrice(symbol);
  if (cached != null && cached > 0) return cached;
  try {
    const tick = await fetchDeltaTicker(symbol);
    if (tick.last != null && Number.isFinite(tick.last) && tick.last > 0) {
      return tick.last;
    }
  } catch {
    /* fallback below */
  }
  return null;
}

/** Realized (closed today) + unrealized on OPEN copy trades using live marks. */
export async function computeTodaysPnl(
  prisma: PrismaClient,
  userId: string,
  ref = new Date(),
): Promise<number> {
  const dayStart = startOfUtcDay(ref);

  const closedToday = await prisma.trade.findMany({
    where: {
      userId,
      status: TradeStatus.CLOSED,
      updatedAt: { gte: dayStart },
    },
    select: { tradePnl: true, pnl: true },
  });
  const realizedToday = closedToday.reduce(
    (sum, t) => sum + realizedTradePnl(t),
    0,
  );

  const openTrades = await prisma.trade.findMany({
    where: { userId, status: TradeStatus.OPEN },
    select: {
      symbol: true,
      side: true,
      entryPrice: true,
      size: true,
    },
  });

  let unrealizedLive = 0;
  for (const trade of openTrades) {
    if (!Number.isFinite(trade.entryPrice) || trade.entryPrice <= 0) continue;

    const mark = await resolveMarkForOpenTrade(trade.symbol);
    if (mark == null) continue;

    const side: TradeSide =
      String(trade.side).toUpperCase() === "SELL" ? "SELL" : "BUY";
    const contracts = Math.abs(trade.size);
    if (contracts < 1e-12) continue;

    let contractSize = deltaContractSizeFallback(trade.symbol);
    try {
      contractSize = await fetchDeltaSwapContractSize(trade.symbol);
    } catch {
      /* keep fallback */
    }

    unrealizedLive += estimateLivePnlUsd({
      symbolKey: trade.symbol,
      side,
      entryPrice: trade.entryPrice,
      contracts,
      markPrice: mark,
      contractSize,
    });
  }

  return realizedToday + unrealizedLive;
}

export async function systemClosedPnlSince(
  prisma: PrismaClient,
  since: Date,
): Promise<number> {
  const trades = await prisma.trade.findMany({
    where: { status: TradeStatus.CLOSED, createdAt: { gte: since } },
    select: { tradePnl: true, pnl: true },
  });
  return trades.reduce((s, t) => s + realizedTradePnl(t), 0);
}

export async function totalPendingRevenueAllUsers(
  prisma: PrismaClient,
): Promise<number> {
  const agg = await prisma.invoice.aggregate({
    where: { status: { in: [InvoiceStatus.PENDING, InvoiceStatus.OVERDUE] } },
    _sum: { amountDue: true },
  });
  return agg._sum.amountDue ?? 0;
}

export async function masterApiHealth(prisma: PrismaClient): Promise<{
  connected: boolean;
  strategyTitle: string | null;
}> {
  const strat = await prisma.strategy.findFirst({
    where: { title: FUTURE_HEDGE_STRATEGY_TITLE },
    select: { title: true, masterApiKey: true, masterApiSecret: true },
  });
  if (!strat?.masterApiKey?.trim() || !strat?.masterApiSecret?.trim()) {
    return { connected: false, strategyTitle: null };
  }
  const ok = await checkDeltaApiConnected({
    apiKey: strat.masterApiKey,
    apiSecret: strat.masterApiSecret,
  });
  return { connected: ok, strategyTitle: strat.title };
}
