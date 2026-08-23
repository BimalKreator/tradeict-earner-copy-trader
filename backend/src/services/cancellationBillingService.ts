import type { PrismaClient } from "@prisma/client";
import {
  closeSlaveStructure,
  findBotSlaveId,
} from "./botBridgeService.js";
import {
  schedulePendingFinalInvoice,
  type FinalInvoiceScheduleInfo,
} from "./billingCronService.js";

export type CancellationBillingReason =
  | "SUBSCRIPTION_CANCELLED"
  | "API_DISCONNECTED"
  | "ADMIN_MANUAL";

export class StructureCloseBlockedError extends Error {
  readonly failedBaskets: number[];

  constructor(reason: string, failedBaskets: number[]) {
    super(reason);
    this.name = "StructureCloseBlockedError";
    this.failedBaskets = failedBaskets;
  }
}

export class BotUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BotUnreachableError";
  }
}

function isBotStrategyType(botStrategyType: string | null | undefined): boolean {
  return (
    typeof botStrategyType === "string" && botStrategyType.trim().length > 0
  );
}

export async function resolveBotSlaveIdForSubscription(
  prisma: PrismaClient,
  args: {
    userId: string;
    strategyId: string;
    botSlaveId: string | null | undefined;
  },
): Promise<number | null> {
  if (args.botSlaveId) {
    const parsed = Number.parseInt(args.botSlaveId, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return findBotSlaveId({
    userId: args.userId,
    strategyId: args.strategyId,
  });
}

async function assertBotCloseSucceeded(
  closeResult: Awaited<ReturnType<typeof closeSlaveStructure>>,
  userId: string,
  reason: string,
): Promise<void> {
  if (closeResult.status === 0) {
    throw new BotUnreachableError(
      closeResult.error ??
        "Delta Bot is unreachable. Cancellation was not completed.",
    );
  }

  if (closeResult.blocked || closeResult.status === 409) {
    const failedBaskets = closeResult.failedBaskets ?? [];
    console.error(
      `[Cancellation] BLOCKED user=${userId} reason=${reason} failedBaskets=[${failedBaskets.join(",")}]`,
    );
    throw new StructureCloseBlockedError(
      closeResult.error ?? "Structure close blocked — basket close failed",
      failedBaskets,
    );
  }

  if (!closeResult.success) {
    throw new Error(
      closeResult.error ?? `Structure close failed (HTTP ${closeResult.status})`,
    );
  }
}

export type CloseStructureBillingResult = {
  closeCounts: Record<string, unknown> | null;
  finalInvoiceSchedule: FinalInvoiceScheduleInfo;
};

/**
 * Close the user's bot structure (when a slave exists), mark subscription cancelled,
 * and defer the final ACCRUED invoice until Delta ledger rows have settled.
 */
export async function closeStructureAndFinaliseBilling(
  prisma: PrismaClient,
  args: {
    userId: string;
    subscriptionId: string;
    botSlaveId: number | null;
    reason: CancellationBillingReason;
  },
): Promise<CloseStructureBillingResult> {
  let closeCounts: Record<string, unknown> | null = null;

  if (args.botSlaveId != null) {
    const closeResult = await closeSlaveStructure({
      botSlaveId: args.botSlaveId,
      userId: args.userId,
      reason: args.reason,
    });
    await assertBotCloseSucceeded(closeResult, args.userId, args.reason);
    closeCounts = closeResult.counts ?? null;
  }

  const finalInvoiceSchedule = await schedulePendingFinalInvoice(prisma, {
    userId: args.userId,
    subscriptionId: args.subscriptionId,
  });

  return { closeCounts, finalInvoiceSchedule };
}

/** Resolve bot slave from the user's active bot-strategy subscription. */
export async function closeStructureAndFinaliseBillingForUser(
  prisma: PrismaClient,
  userId: string,
  reason: CancellationBillingReason,
): Promise<CloseStructureBillingResult> {
  const sub = await prisma.userStrategySubscription.findFirst({
    where: {
      userId,
      OR: [{ isActive: true }, { status: "ACTIVE" }],
      strategy: {
        AND: [
          { botStrategyType: { not: null } },
          { NOT: { botStrategyType: "" } },
        ],
      },
    },
    orderBy: { joinedDate: "desc" },
    select: {
      id: true,
      userId: true,
      strategyId: true,
      botSlaveId: true,
      strategy: { select: { botStrategyType: true } },
    },
  });

  if (!sub || !isBotStrategyType(sub.strategy.botStrategyType)) {
    throw new Error("No active bot-strategy subscription for this user");
  }

  const botSlaveId = await resolveBotSlaveIdForSubscription(prisma, {
    userId: sub.userId,
    strategyId: sub.strategyId,
    botSlaveId: sub.botSlaveId,
  });

  return closeStructureAndFinaliseBilling(prisma, {
    userId: sub.userId,
    subscriptionId: sub.id,
    botSlaveId,
    reason,
  });
}

export async function closeAndBillForBotSubscription(
  prisma: PrismaClient,
  sub: {
    id: string;
    userId: string;
    strategyId: string;
    botSlaveId: string | null | undefined;
    strategy: { botStrategyType: string | null };
  },
  reason: CancellationBillingReason,
): Promise<CloseStructureBillingResult | null> {
  if (!isBotStrategyType(sub.strategy.botStrategyType)) {
    return null;
  }

  const botSlaveId = await resolveBotSlaveIdForSubscription(prisma, {
    userId: sub.userId,
    strategyId: sub.strategyId,
    botSlaveId: sub.botSlaveId,
  });

  return closeStructureAndFinaliseBilling(prisma, {
    userId: sub.userId,
    subscriptionId: sub.id,
    botSlaveId,
    reason,
  });
}

export function mapCancellationBillingError(
  err: unknown,
): { status: number; body: Record<string, unknown> } | null {
  if (err instanceof StructureCloseBlockedError) {
    return {
      status: 409,
      body: {
        error: err.message,
        failedBaskets: err.failedBaskets,
      },
    };
  }
  if (err instanceof BotUnreachableError) {
    return {
      status: 503,
      body: { error: err.message },
    };
  }
  return null;
}
