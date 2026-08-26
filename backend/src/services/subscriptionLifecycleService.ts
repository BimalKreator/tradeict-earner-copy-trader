import {
  SubscriptionStatus,
  type PrismaClient,
} from "@prisma/client";
import { MANAGED_SUBSCRIPTION_STATUSES } from "../constants/subscription.js";
import {
  deployedCapitalFromMultiplier,
  deployedCapitalRangeError,
  parseDeployedCapital,
  parseMultiplierFromBody,
  resolveStrategyBaseCapital,
} from "../utils/subscriptionCapital.js";
import {
  pauseUserOnBot,
  resumeUserOnBot,
  updateUserCapitalOnBot,
} from "./botBridgeService.js";

const VOLUNTARY_PAUSED_STATUS = SubscriptionStatus.PAUSED_BY_USER;

const strategySelectPublic = {
  id: true,
  title: true,
  description: true,
  monthlyFee: true,
  minCapital: true,
  baseCapital: true,
  profitShare: true,
  slippage: true,
  performanceMetrics: true,
  syncActiveTrades: true,
  botStrategyType: true,
  createdAt: true,
} as const;

const subscriptionInclude = {
  strategy: { select: strategySelectPublic },
  exchangeAccount: { select: { id: true, nickname: true, exchange: true } },
} as const;

export type ModifyCapitalResult =
  | { ok: true; subscription: unknown }
  | { ok: false; status: number; error: string };

export type PauseResumeResult =
  | { ok: true; subscription: unknown }
  | { ok: false; status: number; error: string };

/** Bot-first capital update — DB multiplier changes only after bot ACK. */
export async function modifySubscriptionCapital(
  prisma: PrismaClient,
  args: {
    userId: string;
    strategyId: string;
    deployedCapital?: unknown;
    multiplier?: unknown;
  },
): Promise<ModifyCapitalResult> {
  const sub = await prisma.userStrategySubscription.findFirst({
    where: {
      userId: args.userId,
      strategyId: args.strategyId,
      status: { in: [...MANAGED_SUBSCRIPTION_STATUSES] },
    },
    select: {
      id: true,
      botSlaveId: true,
      multiplier: true,
      strategy: {
        select: {
          baseCapital: true,
          minCapital: true,
          botStrategyType: true,
        },
      },
    },
  });
  if (!sub) {
    return { ok: false, status: 404, error: "Subscription not found" };
  }

  const baseCapital = resolveStrategyBaseCapital(sub.strategy);
  const body = {
    deployedCapital: args.deployedCapital,
    multiplier: args.multiplier,
  };
  const multiplier = parseMultiplierFromBody(body, baseCapital);
  if (multiplier == null) {
    return {
      ok: false,
      status: 400,
      error: deployedCapitalRangeError(baseCapital),
    };
  }

  const newCapitalUsd =
    parseDeployedCapital(body.deployedCapital) ??
    deployedCapitalFromMultiplier(multiplier, baseCapital);

  const isBotStrategy =
    typeof sub.strategy.botStrategyType === "string" &&
    sub.strategy.botStrategyType.trim().length > 0;

  if (isBotStrategy && sub.botSlaveId) {
    const botSlaveIdNum = Number.parseInt(sub.botSlaveId, 10);
    if (!Number.isFinite(botSlaveIdNum)) {
      return {
        ok: false,
        status: 502,
        error: "Invalid botSlaveId — capital was not updated.",
      };
    }
    const botResult = await updateUserCapitalOnBot({
      botSlaveId: botSlaveIdNum,
      userAllocatedCapitalUsd: newCapitalUsd,
    });
    if (!botResult.success) {
      return {
        ok: false,
        status: 502,
        error:
          botResult.error ??
          "Bot did not acknowledge capital update — stored capital unchanged.",
      };
    }
  } else if (isBotStrategy && !sub.botSlaveId) {
    return {
      ok: false,
      status: 502,
      error: "Bot slave is not registered — capital was not updated.",
    };
  }

  const updated = await prisma.userStrategySubscription.update({
    where: { id: sub.id },
    data: { multiplier },
    include: subscriptionInclude,
  });

  return { ok: true, subscription: updated };
}

/** Idempotent pause — bot PATCH is_active=false, then local status. */
export async function pauseSubscriptionForUser(
  prisma: PrismaClient,
  args: { userId: string; strategyId: string },
): Promise<PauseResumeResult> {
  const sub = await prisma.userStrategySubscription.findFirst({
    where: {
      userId: args.userId,
      strategyId: args.strategyId,
      status: {
        in: [SubscriptionStatus.ACTIVE, VOLUNTARY_PAUSED_STATUS],
      },
    },
    select: {
      id: true,
      botSlaveId: true,
      strategy: { select: { botStrategyType: true } },
    },
  });
  if (!sub) {
    return { ok: false, status: 404, error: "Active subscription not found" };
  }

  const isBotStrategy =
    typeof sub.strategy.botStrategyType === "string" &&
    sub.strategy.botStrategyType.trim().length > 0;

  if (isBotStrategy) {
    if (!sub.botSlaveId?.trim()) {
      return {
        ok: false,
        status: 502,
        error: "Bot slave is not registered — pause refused.",
      };
    }
    const botSlaveIdNum = Number.parseInt(sub.botSlaveId, 10);
    if (!Number.isFinite(botSlaveIdNum)) {
      return {
        ok: false,
        status: 502,
        error: "Invalid botSlaveId — pause refused.",
      };
    }
    const botResult = await pauseUserOnBot({ botSlaveId: botSlaveIdNum });
    if (!botResult.success) {
      return {
        ok: false,
        status: 502,
        error:
          botResult.error ??
          "Bot did not acknowledge pause — subscription left active.",
      };
    }
  }

  const updated = await prisma.userStrategySubscription.update({
    where: { id: sub.id },
    data: { isActive: false, status: VOLUNTARY_PAUSED_STATUS },
    include: subscriptionInclude,
  });

  return { ok: true, subscription: updated };
}

export async function resumeSubscriptionForUser(
  prisma: PrismaClient,
  args: { userId: string; strategyId: string },
): Promise<PauseResumeResult> {
  const sub = await prisma.userStrategySubscription.findFirst({
    where: {
      userId: args.userId,
      strategyId: args.strategyId,
      status: VOLUNTARY_PAUSED_STATUS,
    },
    select: {
      id: true,
      botSlaveId: true,
      exchangeAccountId: true,
      strategy: { select: { botStrategyType: true } },
    },
  });
  if (!sub) {
    return { ok: false, status: 404, error: "Paused subscription not found" };
  }
  if (!sub.exchangeAccountId) {
    return {
      ok: false,
      status: 400,
      error: "Deploy this strategy first (missing exchange account).",
    };
  }

  const isBotStrategy =
    typeof sub.strategy.botStrategyType === "string" &&
    sub.strategy.botStrategyType.trim().length > 0;

  if (isBotStrategy) {
    if (!sub.botSlaveId?.trim()) {
      return {
        ok: false,
        status: 502,
        error: "Bot slave is not registered — resume refused.",
      };
    }
    const botSlaveIdNum = Number.parseInt(sub.botSlaveId, 10);
    if (!Number.isFinite(botSlaveIdNum)) {
      return {
        ok: false,
        status: 502,
        error: "Invalid botSlaveId — resume refused.",
      };
    }
    const botResult = await resumeUserOnBot({ botSlaveId: botSlaveIdNum });
    if (!botResult.success) {
      return {
        ok: false,
        status: 502,
        error:
          botResult.error ??
          "Bot did not acknowledge resume — subscription left paused.",
      };
    }
  }

  const updated = await prisma.userStrategySubscription.update({
    where: { id: sub.id },
    data: {
      isActive: true,
      status: SubscriptionStatus.ACTIVE,
      syncStatus: "PENDING",
      syncError: null,
    },
    include: subscriptionInclude,
  });

  return { ok: true, subscription: updated };
}
