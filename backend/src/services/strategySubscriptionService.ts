import {
  type Prisma,
  type PrismaClient,
  InvoiceKind,
  InvoiceStatus,
  SubscriptionStatus,
  UserStatus,
} from "@prisma/client";
import {
  STRATEGY_FEE_CYCLE_DAYS,
  STRATEGY_PAYMENT_MODE,
  type StrategyPaymentMode,
} from "../constants/subscription.js";
import { getUsdInrRate } from "./settingsService.js";
import { resolveCanonicalFutureHedgeStrategyId } from "./futureHedgeService.js";

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

const SUBSCRIBER_CACHE_TTL_MS = 3_000;
let subscriberCache: {
  strategyId: string;
  rows: CopySubscriptionRow[];
  fetchedAt: number;
} | null = null;
let strategyIdCache: { id: string | null; fetchedAt: number } | null = null;

/** Bust in-memory copy roster after subscription deploy/undeploy/sync changes. */
export function invalidateCopySubscriberCache(): void {
  subscriberCache = null;
  strategyIdCache = null;
}

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
  const now = Date.now();
  if (
    strategyIdCache &&
    now - strategyIdCache.fetchedAt < SUBSCRIBER_CACHE_TTL_MS
  ) {
    return strategyIdCache.id;
  }

  const id = await resolveCanonicalFutureHedgeStrategyId(prisma);
  if (!id) {
    strategyIdCache = { id: null, fetchedAt: now };
    return null;
  }
  const row = await prisma.strategy.findUnique({
    where: { id },
    select: { isActive: true },
  });
  const activeId = row?.isActive ? id : null;
  strategyIdCache = { id: activeId, fetchedAt: now };
  return activeId;
}

export { normalizeFutureHedgeStrategyId } from "./futureHedgeService.js";

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

  const now = Date.now();
  if (
    subscriberCache &&
    subscriberCache.strategyId === strategyId &&
    now - subscriberCache.fetchedAt < SUBSCRIBER_CACHE_TTL_MS
  ) {
    return subscriberCache.rows;
  }

  const rows = await findActiveCopySubscribersForStrategy(prisma, strategyId);
  subscriberCache = { strategyId, rows, fetchedAt: now };
  return rows;
}

export type ActiveCopyTradingStrategy = {
  id: string;
  title: string;
  masterApiKey: string;
  masterApiSecret: string;
  slippage: number;
  isActive: boolean;
};

/**
 * All strategies eligible for the copy engine: active, master keys configured,
 * and at least one active subscriber deployment.
 */
export async function findActiveCopyTradingStrategies(
  prisma: PrismaClient,
): Promise<ActiveCopyTradingStrategy[]> {
  const candidates = await prisma.strategy.findMany({
    where: {
      isActive: true,
      masterApiKey: { not: "" },
      masterApiSecret: { not: "" },
    },
    select: {
      id: true,
      title: true,
      masterApiKey: true,
      masterApiSecret: true,
      slippage: true,
      isActive: true,
    },
  });

  const out: ActiveCopyTradingStrategy[] = [];
  for (const row of candidates) {
    if (!row.masterApiKey?.trim() || !row.masterApiSecret?.trim()) continue;
    const subs = await findActiveCopySubscribersForStrategy(prisma, row.id);
    if (subs.length > 0) out.push(row);
  }
  return out;
}

export async function loadStrategyCopyMeta(
  prisma: PrismaClient,
  strategyId: string,
): Promise<{ id: string; isActive: boolean; slippage: number } | null> {
  return prisma.strategy.findUnique({
    where: { id: strategyId },
    select: { id: true, isActive: true, slippage: true },
  });
}

export function resolveCopySubscriptionCreds(
  sub: CopySubscriptionRow,
): { apiKey: string; apiSecret: string } | null {
  /** Deploy binds an exchange account — never fall back to another wallet's keys. */
  if (sub.exchangeAccountId) {
    if (sub.exchangeAccount == null) return null;
    const key = sub.exchangeAccount.apiKey?.trim() ?? "";
    const secret = sub.exchangeAccount.apiSecret?.trim() ?? "";
    if (key && secret) {
      return { apiKey: key, apiSecret: secret };
    }
    return null;
  }
  if (sub.exchangeAccount != null) {
    const key = sub.exchangeAccount.apiKey?.trim() ?? "";
    const secret = sub.exchangeAccount.apiSecret?.trim() ?? "";
    if (key && secret) {
      return { apiKey: key, apiSecret: secret };
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

/** Delta API keys for a user — deployed subscription account first, then latest wallet. */
export async function resolveUserExchangeCreds(
  prisma: PrismaClient,
  userId: string,
): Promise<{ apiKey: string; apiSecret: string } | null> {
  const sub = await prisma.userStrategySubscription.findFirst({
    where: { userId, exchangeAccountId: { not: null } },
    include: COPY_SUBSCRIPTION_INCLUDE,
    orderBy: { joinedDate: "desc" },
  });
  if (sub) {
    const creds = resolveCopySubscriptionCreds(sub);
    if (creds) return creds;
  }

  const ex = await prisma.exchangeAccount.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
  if (ex != null) {
    const key = ex.apiKey?.trim() ?? "";
    const secret = ex.apiSecret?.trim() ?? "";
    if (key && secret) return { apiKey: ex.apiKey, apiSecret: ex.apiSecret };
  }

  const dk = await prisma.deltaApiKey.findFirst({
    where: { userId },
  });
  if (dk != null) {
    const key = dk.apiKey?.trim() ?? "";
    const secret = dk.apiSecret?.trim() ?? "";
    if (key && secret) return { apiKey: dk.apiKey, apiSecret: dk.apiSecret };
  }

  return null;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function parseStrategyPaymentMode(
  value: unknown,
): StrategyPaymentMode | null {
  if (value === STRATEGY_PAYMENT_MODE.PAY_NOW) return STRATEGY_PAYMENT_MODE.PAY_NOW;
  if (value === STRATEGY_PAYMENT_MODE.PAY_LATER) {
    return STRATEGY_PAYMENT_MODE.PAY_LATER;
  }
  return null;
}

/** INR strategy fee → USD wallet invoice amount. */
export async function strategyFeeInrToUsd(
  prisma: PrismaClient,
  feeInr: number,
): Promise<number> {
  const rate = await getUsdInrRate(prisma);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error("USD/INR rate is not configured");
  }
  return Math.max(0, feeInr) / rate;
}

export function strategyFeeCycleEndFrom(joinedAt: Date): Date {
  return new Date(joinedAt.getTime() + STRATEGY_FEE_CYCLE_DAYS * MS_PER_DAY);
}

export type CreateStrategySubscriptionResult = {
  subscription: Prisma.UserStrategySubscriptionGetPayload<{
    include: Record<string, never>;
  }>;
  strategyFeeInvoiceId: string | null;
};

/**
 * Creates a subscription row after pay-later checkout (no gateway debit).
 * Active subscription status; deploy still binds exchange account + isActive.
 */
export async function createStrategySubscriptionWithPaymentMode(
  prisma: PrismaClient,
  args: {
    userId: string;
    strategyId: string;
    paymentMode: StrategyPaymentMode;
    finalFeeInr: number;
    couponId?: string | null;
  },
): Promise<CreateStrategySubscriptionResult> {
  const joinedDate = new Date();
  const feePaid = args.finalFeeInr <= 0;
  const payLater =
    !feePaid && args.paymentMode === STRATEGY_PAYMENT_MODE.PAY_LATER;

  if (!feePaid && args.paymentMode === STRATEGY_PAYMENT_MODE.PAY_NOW) {
    throw new Error(
      "PAY_NOW subscriptions must complete Razorpay checkout before creation",
    );
  }

  const cycleEndsAt = payLater ? strategyFeeCycleEndFrom(joinedDate) : null;
  const amountDueUsd = payLater
    ? await strategyFeeInrToUsd(prisma, args.finalFeeInr)
    : 0;

  const result = await prisma.$transaction(async (tx) => {
    const subscription = await tx.userStrategySubscription.create({
      data: {
        userId: args.userId,
        strategyId: args.strategyId,
        multiplier: 1,
        isActive: false,
        status: SubscriptionStatus.ACTIVE,
        isStrategyFeePaid: feePaid,
        strategyFeeCycleEndsAt: cycleEndsAt,
        joinedDate,
      },
    });

    let strategyFeeInvoiceId: string | null = null;

    if (payLater) {
      const invoice = await tx.invoice.create({
        data: {
          userId: args.userId,
          strategyId: args.strategyId,
          month: joinedDate.getUTCMonth() + 1,
          year: joinedDate.getUTCFullYear(),
          totalPnl: 0,
          amountDue: amountDueUsd,
          dueDate: cycleEndsAt!,
          status: InvoiceStatus.PENDING,
          kind: InvoiceKind.STRATEGY_FEE,
        },
      });
      strategyFeeInvoiceId = invoice.id;
    }

    if (args.couponId) {
      const { consumeCouponUse } = await import("./couponService.js");
      await consumeCouponUse(tx, args.couponId);
    }

    return { subscription, strategyFeeInvoiceId };
  });

  invalidateCopySubscriberCache();
  return result;
}

/** Outstanding invoices that should block deploy / resume. */
export function blockingUnpaidInvoiceWhere(
  userId: string,
  strategyId: string,
): Prisma.InvoiceWhereInput {
  return {
    userId,
    strategyId,
    OR: [
      {
        kind: InvoiceKind.REVENUE_SHARE,
        status: { in: [InvoiceStatus.PENDING, InvoiceStatus.OVERDUE] },
      },
      {
        kind: InvoiceKind.STRATEGY_FEE,
        status: InvoiceStatus.OVERDUE,
      },
    ],
  };
}

export async function hasBlockingUnpaidInvoicesForStrategy(
  prisma: PrismaClient,
  userId: string,
  strategyId: string,
): Promise<boolean> {
  const row = await prisma.invoice.findFirst({
    where: blockingUnpaidInvoiceWhere(userId, strategyId),
    select: { id: true },
  });
  return row != null;
}

export async function markStrategyFeePaidForSubscription(
  prisma: PrismaClient,
  args: { userId: string; strategyId: string },
): Promise<void> {
  await prisma.userStrategySubscription.updateMany({
    where: {
      userId: args.userId,
      strategyId: args.strategyId,
    },
    data: {
      isStrategyFeePaid: true,
      strategyFeeCycleEndsAt: null,
    },
  });
  invalidateCopySubscriberCache();
}
