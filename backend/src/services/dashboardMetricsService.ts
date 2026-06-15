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
} from "./exchangeService.js";
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

/** Calendar day boundary for dashboard PnL (Delta India users — default IST). */
export const DASHBOARD_PNL_DAY_TIMEZONE =
  process.env.DASHBOARD_PNL_DAY_TIMEZONE?.trim() || "Asia/Kolkata";

function timeZoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);

  const pick = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");

  const asUtc = Date.UTC(
    pick("year"),
    pick("month") - 1,
    pick("day"),
    pick("hour"),
    pick("minute"),
    pick("second"),
  );
  return asUtc - at.getTime();
}

/** UTC instant when the calendar day containing `ref` begins in `timeZone`. */
export function startOfDayInTimeZone(
  ref = new Date(),
  timeZone = DASHBOARD_PNL_DAY_TIMEZONE,
): Date {
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(ref);
  const parts = ymd.split("-").map((x) => Number(x));
  const year = parts[0] ?? NaN;
  const month = parts[1] ?? NaN;
  const day = parts[2] ?? NaN;
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return startOfUtcDay(ref);
  }
  const utcMidnightGuess = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  const offset = timeZoneOffsetMs(new Date(utcMidnightGuess), timeZone);
  return new Date(utcMidnightGuess - offset);
}

/** Exclusive upper bound for today's window in `timeZone` (start of next calendar day). */
export function endOfDayInTimeZone(
  ref = new Date(),
  timeZone = DASHBOARD_PNL_DAY_TIMEZONE,
): Date {
  const start = startOfDayInTimeZone(ref, timeZone);
  return startOfDayInTimeZone(new Date(start.getTime() + 36 * 3_600_000), timeZone);
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

/** Per-trade app revenue share — positive on wins, negative on losses (hedge legs net at billing). */
export function computePerTradeRevenueShareAmt(
  realizedPnl: number,
  profitSharePct: number,
): number {
  if (!Number.isFinite(realizedPnl)) return 0;
  if (!Number.isFinite(profitSharePct) || profitSharePct <= 0) return 0;
  return realizedPnl * (profitSharePct / 100);
}

/** Prefer stored per-trade share when set; recompute for legacy loss rows stored as 0. */
export function resolveStoredOrComputedTradeRevenueShare(args: {
  realizedPnl: number;
  profitSharePct: number;
  revenueShareAmt?: number | null;
}): number {
  const stored = args.revenueShareAmt;
  if (Number.isFinite(stored) && stored !== 0) {
    return stored as number;
  }
  return computePerTradeRevenueShareAmt(args.realizedPnl, args.profitSharePct);
}

/** Billable app revenue — never charge a negative commission to the client. */
export function floorRevenueShareDue(rawTotal: number): number {
  if (!Number.isFinite(rawTotal)) return 0;
  return Math.max(0, rawTotal);
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

/** Canonical PnL breakdown — shared by user dashboard, trades API, and partner network. */
export type PnlBreakdown = {
  /** Sum of realized trade PnL on CLOSED trades before app revenue share. */
  grossPnl: number;
  /**
   * Sum of per-trade profitShare% on every closed leg (losses reduce the total),
   * floored at zero — only positive net commission is billable.
   */
  appRevenue: number;
  /** grossPnl − appRevenue — user's net take-home. */
  netEarnedPnl: number;
};

export type BookedPnlAndRevenueDue = PnlBreakdown & {
  /** @deprecated use grossPnl */
  grossBookedPnl: number;
  /** @deprecated use appRevenue */
  revenueSharingDue: number;
};

const ZERO_PNL_BREAKDOWN: PnlBreakdown = {
  grossPnl: 0,
  appRevenue: 0,
  netEarnedPnl: 0,
};

function withPnlAliases(breakdown: PnlBreakdown): BookedPnlAndRevenueDue {
  return {
    ...breakdown,
    grossBookedPnl: breakdown.grossPnl,
    revenueSharingDue: breakdown.appRevenue,
  };
}

type ClosedTradePnlRow = {
  strategyId: string;
  tradePnl: number;
  pnl: number | null;
  revenueShareAmt?: number;
};

/** Gross PnL, app revenue, and net earned PnL from closed trade rows. */
export function computeBookedPnlAndRevenueDueFromTrades(
  trades: ClosedTradePnlRow[],
  profitShareByStrategyId: Map<string, number>,
): BookedPnlAndRevenueDue {
  if (trades.length === 0) {
    return withPnlAliases(ZERO_PNL_BREAKDOWN);
  }

  let grossPnl = 0;
  let rawAppRevenue = 0;

  for (const t of trades) {
    const pnl = realizedTradePnl(t);
    grossPnl += pnl;
    const pct = profitShareByStrategyId.get(t.strategyId) ?? 0;
    rawAppRevenue += resolveStoredOrComputedTradeRevenueShare({
      realizedPnl: pnl,
      profitSharePct: pct,
      ...(t.revenueShareAmt != null ? { revenueShareAmt: t.revenueShareAmt } : {}),
    });
  }

  const appRevenue = floorRevenueShareDue(rawAppRevenue);

  return withPnlAliases({
    grossPnl,
    appRevenue,
    netEarnedPnl: grossPnl - appRevenue,
  });
}

/**
 * Batch all-time booked PnL + app revenue for many users (partner network tree).
 */
export async function computeUsersBookedPnlAndRevenueDue(
  prisma: PrismaClient,
  userIds: string[],
  since: Date | null = null,
): Promise<Map<string, BookedPnlAndRevenueDue>> {
  const out = new Map<string, BookedPnlAndRevenueDue>();
  for (const id of userIds) {
    out.set(id, withPnlAliases(ZERO_PNL_BREAKDOWN));
  }
  if (userIds.length === 0) return out;

  const trades = await prisma.trade.findMany({
    where: {
      userId: { in: userIds },
      status: TradeStatus.CLOSED,
      ...(since ? { createdAt: { gte: since } } : {}),
    },
    select: {
      userId: true,
      strategyId: true,
      tradePnl: true,
      pnl: true,
      revenueShareAmt: true,
    },
  });

  if (trades.length === 0) return out;

  const strategyIds = [...new Set(trades.map((t) => t.strategyId))];
  const strategies = await prisma.strategy.findMany({
    where: { id: { in: strategyIds } },
    select: { id: true, profitShare: true },
  });
  const sharePctById = new Map(strategies.map((s) => [s.id, s.profitShare]));

  const tradesByUser = new Map<string, ClosedTradePnlRow[]>();
  for (const t of trades) {
    const list = tradesByUser.get(t.userId) ?? [];
    list.push({
      strategyId: t.strategyId,
      tradePnl: t.tradePnl,
      pnl: t.pnl,
      revenueShareAmt: t.revenueShareAmt,
    });
    tradesByUser.set(t.userId, list);
  }

  for (const [userId, userTrades] of tradesByUser) {
    out.set(
      userId,
      computeBookedPnlAndRevenueDueFromTrades(userTrades, sharePctById),
    );
  }

  return out;
}

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
    select: {
      strategyId: true,
      tradePnl: true,
      pnl: true,
      revenueShareAmt: true,
    },
  });

  if (trades.length === 0) {
    return withPnlAliases(ZERO_PNL_BREAKDOWN);
  }

  const strategies = await prisma.strategy.findMany({
    where: { id: { in: [...new Set(trades.map((t) => t.strategyId))] } },
    select: { id: true, profitShare: true },
  });
  const sharePctById = new Map(strategies.map((s) => [s.id, s.profitShare]));

  return computeBookedPnlAndRevenueDueFromTrades(trades, sharePctById);
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

/** Live Delta total balances for a set of user ids (partner network AUM, direct-user table). */
export async function fetchDeltaBalancesForUserIds(
  prisma: PrismaClient,
  userIds: string[],
): Promise<Map<string, { deltaBalance: number | null; deltaConnected: boolean }>> {
  if (userIds.length === 0) return new Map();

  const rows = await mapWithConcurrency(
    userIds,
    ADMIN_DELTA_BALANCE_CONCURRENCY,
    async (userId) => ({
      userId,
      ...(await fetchUserDeltaBalanceForAdmin(prisma, userId)),
    }),
  );

  return new Map(
    rows.map((row) => [
      row.userId,
      {
        deltaBalance: row.deltaBalance,
        deltaConnected: row.deltaConnected,
      },
    ]),
  );
}

export async function sumDeltaBalancesForUserIds(
  prisma: PrismaClient,
  userIds: string[],
): Promise<number> {
  const balances = await fetchDeltaBalancesForUserIds(prisma, userIds);
  let sum = 0;
  for (const row of balances.values()) {
    if (row.deltaBalance != null && Number.isFinite(row.deltaBalance)) {
      sum += row.deltaBalance;
    }
  }
  return sum;
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

/** Realized PnL booked today — sum of `PnLRecord.profitAmount` in the dashboard day window (IST by default). */
export async function computeTodaysPnl(
  prisma: PrismaClient,
  userId: string,
  ref = new Date(),
  timeZone = DASHBOARD_PNL_DAY_TIMEZONE,
): Promise<number> {
  const dayStart = startOfDayInTimeZone(ref, timeZone);
  const dayEnd = endOfDayInTimeZone(ref, timeZone);

  const agg = await prisma.pnLRecord.aggregate({
    where: {
      userId,
      timestamp: { gte: dayStart, lt: dayEnd },
    },
    _sum: { profitAmount: true },
  });

  return agg._sum.profitAmount ?? 0;
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
