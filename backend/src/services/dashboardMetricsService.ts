import {
  InvoiceStatus,
  SubscriptionStatus,
  TradeStatus,
  type PrismaClient,
} from "@prisma/client";
import { decryptDeltaSecretOrPlain } from "../utils/encryption.js";
import {
  type DeltaBalanceBreakdown,
  fetchDeltaAvailableBalanceUsd,
  fetchDeltaBalanceBreakdownUsd,
} from "./exchangeService.js";

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
): Promise<{ count: number; names: string[] }> {
  const subs = await prisma.userSubscription.findMany({
    where: { userId, status: SubscriptionStatus.ACTIVE },
    include: { strategy: { select: { title: true } } },
    orderBy: { joinedDate: "desc" },
  });
  return {
    count: subs.length,
    names: subs.map((s) => strategyShortName(s.strategy.title)),
  };
}

/** Sum Delta USD balance across users with linked credentials (deduped per user). */
export async function aggregateUsersAum(prisma: PrismaClient): Promise<number> {
  const users = await prisma.user.findMany({
    select: { id: true },
  });

  let total = 0;
  for (const u of users) {
    try {
      total += await fetchUserAvailableCapital(prisma, u.id);
    } catch {
      /* skip user */
    }
  }
  return total;
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
    where: {
      masterApiKey: { not: "" },
      masterApiSecret: { not: "" },
    },
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
