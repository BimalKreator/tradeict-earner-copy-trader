import {
  InvoiceStatus,
  SubscriptionStatus,
  TradeStatus,
  type PrismaClient,
} from "@prisma/client";
import { fetchDeltaTotalBalanceUsd } from "./exchangeService.js";

export function startOfUtcDay(ref = new Date()): Date {
  return new Date(
    Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate()),
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

export async function resolveUserDeltaCreds(
  prisma: PrismaClient,
  userId: string,
): Promise<UserCreds | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      exchangeAccounts: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { apiKey: true, apiSecret: true },
      },
      deltaApiKeys: {
        orderBy: { id: "desc" },
        take: 1,
        select: { apiKey: true, apiSecret: true },
      },
    },
  });
  if (!user) return null;
  const creds = user.exchangeAccounts[0] ?? user.deltaApiKeys[0] ?? null;
  if (!creds?.apiKey?.trim() || !creds?.apiSecret?.trim()) return null;
  return { apiKey: creds.apiKey, apiSecret: creds.apiSecret };
}

export async function fetchUserAvailableCapital(
  prisma: PrismaClient,
  userId: string,
): Promise<number> {
  const creds = await resolveUserDeltaCreds(prisma, userId);
  if (!creds) return 0;
  try {
    return await fetchDeltaTotalBalanceUsd(creds.apiKey, creds.apiSecret);
  } catch {
    return 0;
  }
}

export async function checkDeltaApiConnected(
  creds: UserCreds,
): Promise<boolean> {
  try {
    const bal = await fetchDeltaTotalBalanceUsd(creds.apiKey, creds.apiSecret);
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
    select: {
      id: true,
      exchangeAccounts: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { apiKey: true, apiSecret: true },
      },
      deltaApiKeys: {
        orderBy: { id: "desc" },
        take: 1,
        select: { apiKey: true, apiSecret: true },
      },
    },
  });

  let total = 0;
  for (const u of users) {
    const creds = u.exchangeAccounts[0] ?? u.deltaApiKeys[0];
    if (!creds?.apiKey?.trim() || !creds?.apiSecret?.trim()) continue;
    try {
      total += await fetchDeltaTotalBalanceUsd(creds.apiKey, creds.apiSecret);
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
