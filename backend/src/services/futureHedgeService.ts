import type { FutureHedgeConfig, Prisma, PrismaClient, Strategy } from "@prisma/client";
import { FUTURE_HEDGE_STRATEGY_TITLE } from "../constants/strategyTitles.js";

export { FUTURE_HEDGE_STRATEGY_TITLE };

export type FutureHedgeConfigDto = {
  id: string;
  strategyId: string;
  isAutoEnabled: boolean;
  baseLots: number;
  emaPeriod: number;
  adjustmentPct: number;
  targetProfitUsd: number;
  isBreakevenExitEnabled: boolean;
  breakevenPrice1: number | null;
  breakevenPrice2: number | null;
  currentBatchId: string | null;
  lastEntryPrice: number | null;
  createdAt: string;
  updatedAt: string;
};

export type FutureHedgeAdminPayload = {
  strategy: {
    id: string;
    title: string;
    description: string;
  };
  config: FutureHedgeConfigDto;
};

export function mapFutureHedgeConfig(row: FutureHedgeConfig): FutureHedgeConfigDto {
  return {
    id: row.id,
    strategyId: row.strategyId,
    isAutoEnabled: row.isAutoEnabled,
    baseLots: row.baseLots,
    emaPeriod: row.emaPeriod,
    adjustmentPct: row.adjustmentPct,
    targetProfitUsd: row.targetProfitUsd,
    isBreakevenExitEnabled: row.isBreakevenExitEnabled,
    breakevenPrice1: row.breakevenPrice1,
    breakevenPrice2: row.breakevenPrice2,
    currentBatchId: row.currentBatchId,
    lastEntryPrice: row.lastEntryPrice,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

type FutureHedgeStrategyRow = Strategy & {
  futureHedgeConfig: FutureHedgeConfig | null;
  _count?: { subscriptions: number };
};

function scoreFutureHedgeStrategyCandidate(row: {
  masterApiKey: string;
  masterApiSecret: string;
  futureHedgeConfig: FutureHedgeConfig | null;
  _count?: { subscriptions: number };
  createdAt: Date;
}): number {
  let score = 0;
  if (row.masterApiKey?.trim() && row.masterApiSecret?.trim()) score += 10_000;
  if (row.futureHedgeConfig) score += 1_000;
  score += (row._count?.subscriptions ?? 0) * 10;
  score -= row.createdAt.getTime() / 1e15;
  return score;
}

/** When duplicate title rows exist, pick the one wired to master Delta keys / subscribers. */
export async function resolveCanonicalFutureHedgeStrategy(
  prisma: PrismaClient,
): Promise<FutureHedgeStrategyRow | null> {
  const rows = await prisma.strategy.findMany({
    where: { title: FUTURE_HEDGE_STRATEGY_TITLE },
    orderBy: { createdAt: "asc" },
    include: {
      futureHedgeConfig: true,
      _count: { select: { subscriptions: true } },
    },
  });
  if (rows.length === 0) return null;
  if (rows.length === 1) return rows[0]!;
  return rows.reduce((best, cur) =>
    scoreFutureHedgeStrategyCandidate(cur) > scoreFutureHedgeStrategyCandidate(best)
      ? cur
      : best,
  );
}

export async function resolveCanonicalFutureHedgeStrategyId(
  prisma: PrismaClient,
): Promise<string | null> {
  const row = await resolveCanonicalFutureHedgeStrategy(prisma);
  return row?.id ?? null;
}

/** Map any Future Hedge strategy id to the canonical copy-engine row. */
export async function normalizeFutureHedgeStrategyId(
  prisma: PrismaClient,
  strategyId: string,
): Promise<string> {
  const row = await prisma.strategy.findUnique({
    where: { id: strategyId },
    select: { title: true },
  });
  if (row?.title !== FUTURE_HEDGE_STRATEGY_TITLE) return strategyId;
  const canonicalId = await resolveCanonicalFutureHedgeStrategyId(prisma);
  return canonicalId ?? strategyId;
}

/** Find or create the platform strategy row and its hedge config. */
export async function resolveFutureHedgeStrategy(
  prisma: PrismaClient,
): Promise<Strategy & { futureHedgeConfig: FutureHedgeConfig | null }> {
  let strategy = await resolveCanonicalFutureHedgeStrategy(prisma);

  if (!strategy) {
    strategy = await prisma.strategy.create({
      data: {
        title: FUTURE_HEDGE_STRATEGY_TITLE,
        description:
          "Automated futures hedge driven by EMA signals with batched lot adjustments.",
        monthlyFee: 0,
        minCapital: 0,
        profitShare: 0,
        slippage: 0.5,
        futureHedgeConfig: { create: {} },
      },
      include: { futureHedgeConfig: true },
    });
    return strategy;
  }

  if (!strategy.futureHedgeConfig) {
    const config = await prisma.futureHedgeConfig.create({
      data: { strategyId: strategy.id },
    });
    return { ...strategy, futureHedgeConfig: config };
  }

  return strategy;
}

/** Alias for callers that need the platform's default / primary strategy row. */
export const resolvePrimaryStrategy = resolveFutureHedgeStrategy;

export type FutureHedgeConfigUpdateInput = {
  isAutoEnabled?: boolean;
  baseLots?: number;
  emaPeriod?: number;
  adjustmentPct?: number;
  targetProfitUsd?: number;
  isBreakevenExitEnabled?: boolean;
  breakevenPrice1?: number | null;
  breakevenPrice2?: number | null;
  currentBatchId?: string | null;
};

export function validateFutureHedgeUpdate(
  input: FutureHedgeConfigUpdateInput,
): string | null {
  if (input.baseLots !== undefined) {
    if (!Number.isInteger(input.baseLots) || input.baseLots < 1) {
      return "baseLots must be an integer >= 1";
    }
  }
  if (input.emaPeriod !== undefined) {
    if (!Number.isInteger(input.emaPeriod) || input.emaPeriod < 1) {
      return "emaPeriod must be an integer >= 1";
    }
  }
  if (input.adjustmentPct !== undefined) {
    if (
      !Number.isFinite(input.adjustmentPct) ||
      input.adjustmentPct <= 0 ||
      input.adjustmentPct > 100
    ) {
      return "adjustmentPct must be greater than 0 and at most 100";
    }
  }
  if (input.targetProfitUsd !== undefined) {
    if (!Number.isFinite(input.targetProfitUsd) || input.targetProfitUsd <= 0) {
      return "targetProfitUsd must be a positive number";
    }
  }
  if (input.breakevenPrice1 !== undefined && input.breakevenPrice1 !== null) {
    if (!Number.isFinite(input.breakevenPrice1) || input.breakevenPrice1 <= 0) {
      return "breakevenPrice1 must be a positive number or null";
    }
  }
  if (input.breakevenPrice2 !== undefined && input.breakevenPrice2 !== null) {
    if (!Number.isFinite(input.breakevenPrice2) || input.breakevenPrice2 <= 0) {
      return "breakevenPrice2 must be a positive number or null";
    }
  }
  if (input.isBreakevenExitEnabled === true) {
    const p1 = input.breakevenPrice1;
    const p2 = input.breakevenPrice2;
    const hasP1 = p1 != null && Number.isFinite(p1) && p1 > 0;
    const hasP2 = p2 != null && Number.isFinite(p2) && p2 > 0;
    if (!hasP1 && !hasP2) {
      return "At least one breakeven price is required when breakeven exit is enabled";
    }
  }
  if (input.currentBatchId !== undefined && input.currentBatchId !== null) {
    if (typeof input.currentBatchId !== "string" || !input.currentBatchId.trim()) {
      return "currentBatchId must be a non-empty string or null";
    }
  }
  return null;
}

/** Admin strategy PUT: nested `futureHedgeConfig` object (subset of hedge fields). */
export function parseFutureHedgeConfigBody(
  body: unknown,
): FutureHedgeConfigUpdateInput | null {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  return parseFutureHedgeBody(body as Record<string, unknown>);
}

export async function upsertFutureHedgeConfigForStrategy(
  prisma: PrismaClient,
  strategyId: string,
  input: FutureHedgeConfigUpdateInput,
): Promise<FutureHedgeConfig> {
  const validationError = validateFutureHedgeUpdate(input);
  if (validationError) {
    throw new Error(validationError);
  }
  if (Object.keys(input).length === 0) {
    throw new Error("No future hedge config fields to update");
  }

  const updateData: Prisma.FutureHedgeConfigUpdateInput = {};
  if (input.isAutoEnabled !== undefined) {
    updateData.isAutoEnabled = input.isAutoEnabled;
  }
  if (input.baseLots !== undefined) updateData.baseLots = input.baseLots;
  if (input.emaPeriod !== undefined) updateData.emaPeriod = input.emaPeriod;
  if (input.adjustmentPct !== undefined) {
    updateData.adjustmentPct = input.adjustmentPct;
  }
  if (input.targetProfitUsd !== undefined) {
    updateData.targetProfitUsd = input.targetProfitUsd;
  }
  if (input.isBreakevenExitEnabled !== undefined) {
    updateData.isBreakevenExitEnabled = input.isBreakevenExitEnabled;
  }
  if (input.breakevenPrice1 !== undefined) {
    updateData.breakevenPrice1 = input.breakevenPrice1;
  }
  if (input.breakevenPrice2 !== undefined) {
    updateData.breakevenPrice2 = input.breakevenPrice2;
  }
  if (input.currentBatchId !== undefined) {
    updateData.currentBatchId = input.currentBatchId;
  }

  return prisma.futureHedgeConfig.upsert({
    where: { strategyId },
    create: {
      strategyId,
      isAutoEnabled: input.isAutoEnabled ?? false,
      baseLots: input.baseLots ?? 1,
      emaPeriod: input.emaPeriod ?? 200,
      adjustmentPct: input.adjustmentPct ?? 0.5,
      targetProfitUsd: input.targetProfitUsd ?? 10,
      ...(input.currentBatchId !== undefined
        ? { currentBatchId: input.currentBatchId }
        : {}),
    },
    update: updateData,
  });
}

export function parseFutureHedgeBody(body: Record<string, unknown>): FutureHedgeConfigUpdateInput {
  const out: FutureHedgeConfigUpdateInput = {};

  if (typeof body.isAutoEnabled === "boolean") {
    out.isAutoEnabled = body.isAutoEnabled;
  }
  if (typeof body.baseLots === "number") {
    out.baseLots = Math.trunc(body.baseLots);
  }
  if (typeof body.emaPeriod === "number") {
    out.emaPeriod = Math.trunc(body.emaPeriod);
  }
  if (typeof body.adjustmentPct === "number") {
    out.adjustmentPct = body.adjustmentPct;
  }
  if (typeof body.targetProfitUsd === "number") {
    out.targetProfitUsd = body.targetProfitUsd;
  }
  if (typeof body.isBreakevenExitEnabled === "boolean") {
    out.isBreakevenExitEnabled = body.isBreakevenExitEnabled;
  }
  if (body.breakevenPrice1 === null) {
    out.breakevenPrice1 = null;
  } else if (typeof body.breakevenPrice1 === "number") {
    out.breakevenPrice1 = body.breakevenPrice1;
  }
  if (body.breakevenPrice2 === null) {
    out.breakevenPrice2 = null;
  } else if (typeof body.breakevenPrice2 === "number") {
    out.breakevenPrice2 = body.breakevenPrice2;
  }
  if (body.currentBatchId === null) {
    out.currentBatchId = null;
  } else if (typeof body.currentBatchId === "string") {
    out.currentBatchId = body.currentBatchId.trim() || null;
  }

  return out;
}
