import {
  type Prisma,
  type PrismaClient,
  SubscriptionStatus,
  UserStatus,
} from "@prisma/client";
import { FUTURE_HEDGE_STRATEGY_TITLE } from "../constants/strategyTitles.js";

/** Copy engine: only subscribers with an active row for the given strategy. */
export function activeStrategySubscriptionWhere(
  strategyId: string,
): Prisma.UserStrategySubscriptionWhereInput {
  return {
    strategyId,
    isActive: true,
    status: SubscriptionStatus.ACTIVE,
    strategy: { isActive: true },
    user: { status: UserStatus.ACTIVE, copyTradingPaused: false },
  };
}

/** Strategy roster: at least one copy-eligible subscriber. */
export const STRATEGY_WHERE_HAS_ACTIVE_COPY_SUBSCRIBERS: Prisma.StrategyWhereInput =
  {
    subscriptions: {
      some: {
        isActive: true,
        status: SubscriptionStatus.ACTIVE,
      },
    },
  };

export const COPY_SUBSCRIPTION_INCLUDE = {
  exchangeAccount: true,
  user: {
    include: {
      deltaApiKeys: true,
      exchangeAccounts: {
        orderBy: { createdAt: "desc" as const },
        take: 1,
      },
    },
  },
} satisfies Prisma.UserStrategySubscriptionInclude;

export type CopySubscriptionRow = Prisma.UserStrategySubscriptionGetPayload<{
  include: typeof COPY_SUBSCRIPTION_INCLUDE;
}>;

export async function findActiveCopySubscribersForStrategy(
  prisma: PrismaClient,
  strategyId: string,
): Promise<CopySubscriptionRow[]> {
  const rows = await prisma.userStrategySubscription.findMany({
    where: activeStrategySubscriptionWhere(strategyId),
    include: COPY_SUBSCRIPTION_INCLUDE,
  });
  return Array.from(new Map(rows.map((s) => [s.userId, s])).values());
}

export async function findActiveCopySubscriptionForUser(
  prisma: PrismaClient,
  args: { strategyId: string; userId: string },
): Promise<CopySubscriptionRow | null> {
  return prisma.userStrategySubscription.findFirst({
    where: {
      ...activeStrategySubscriptionWhere(args.strategyId),
      userId: args.userId,
    },
    include: COPY_SUBSCRIPTION_INCLUDE,
  });
}

/** Admin manual sync — includes FAILED rows; does not require strategy.isActive. */
export async function findCopySubscriptionForUser(
  prisma: PrismaClient,
  args: { strategyId: string; userId: string },
): Promise<CopySubscriptionRow | null> {
  return prisma.userStrategySubscription.findUnique({
    where: {
      userId_strategyId: {
        userId: args.userId,
        strategyId: args.strategyId,
      },
    },
    include: COPY_SUBSCRIPTION_INCLUDE,
  });
}

export function subscriptionMultiplier(sub: { multiplier: number }): number {
  const m = sub.multiplier;
  return Number.isFinite(m) && m > 0 ? m : 1;
}

/** Integer follower contract lots = floor(master lots × subscription multiplier). */
export function followerLotsFromMaster(
  masterLots: number,
  sub: { multiplier: number },
): number {
  const scaled = Math.abs(masterLots) * subscriptionMultiplier(sub);
  return Math.max(1, Math.floor(scaled));
}

export async function resolveFutureHedgeStrategyId(
  prisma: PrismaClient,
): Promise<string | null> {
  const row = await prisma.strategy.findFirst({
    where: { title: FUTURE_HEDGE_STRATEGY_TITLE, isActive: true },
    select: { id: true },
  });
  return row?.id ?? null;
}

/** True only when the strategy row exists and `Strategy.isActive` is true. */
export async function isStrategyCopyTradingActive(
  prisma: PrismaClient,
  strategyId: string,
): Promise<boolean> {
  const row = await prisma.strategy.findUnique({
    where: { id: strategyId },
    select: { isActive: true },
  });
  return row?.isActive === true;
}

/** Active copy subscribers for Future Hedge only. */
export async function findActiveFutureHedgeCopySubscribers(
  prisma: PrismaClient,
): Promise<CopySubscriptionRow[]> {
  const strategyId = await resolveFutureHedgeStrategyId(prisma);
  if (!strategyId) return [];
  return findActiveCopySubscribersForStrategy(prisma, strategyId);
}

export function resolveCopySubscriptionCreds(
  sub: CopySubscriptionRow,
): { apiKey: string; apiSecret: string } | null {
  if (sub.exchangeAccount != null) {
    const key = sub.exchangeAccount.apiKey?.trim() ?? "";
    const secret = sub.exchangeAccount.apiSecret?.trim() ?? "";
    if (key && secret) {
      return { apiKey: sub.exchangeAccount.apiKey, apiSecret: sub.exchangeAccount.apiSecret };
    }
  }
  const ex = sub.user.exchangeAccounts[0];
  if (ex != null) {
    const key = ex.apiKey?.trim() ?? "";
    const secret = ex.apiSecret?.trim() ?? "";
    if (key && secret) return { apiKey: ex.apiKey, apiSecret: ex.apiSecret };
  }
  const dk = sub.user.deltaApiKeys[0];
  if (dk != null) {
    const key = dk.apiKey?.trim() ?? "";
    const secret = dk.apiSecret?.trim() ?? "";
    if (key && secret) return { apiKey: dk.apiKey, apiSecret: dk.apiSecret };
  }
  return null;
}
