import {
  type Prisma,
  type PrismaClient,
  SubscriptionStatus,
  UserStatus,
} from "@prisma/client";

/** Copy engine: only subscribers with an active row for the given strategy. */
export function activeStrategySubscriptionWhere(
  strategyId: string,
): Prisma.UserStrategySubscriptionWhereInput {
  return {
    strategyId,
    isActive: true,
    status: SubscriptionStatus.ACTIVE,
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

export function subscriptionMultiplier(sub: { multiplier: number }): number {
  const m = sub.multiplier;
  return Number.isFinite(m) && m > 0 ? m : 1;
}
