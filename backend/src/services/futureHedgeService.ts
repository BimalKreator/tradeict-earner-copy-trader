import type { FutureHedgeConfig, PrismaClient, Strategy } from "@prisma/client";

export const FUTURE_HEDGE_STRATEGY_TITLE = "Future Hedge Strategy";

export type FutureHedgeConfigDto = {
  id: string;
  strategyId: string;
  isAutoEnabled: boolean;
  baseLots: number;
  emaPeriod: number;
  adjustmentPct: number;
  targetProfitUsd: number;
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
    currentBatchId: row.currentBatchId,
    lastEntryPrice: row.lastEntryPrice,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Find or create the platform strategy row and its hedge config. */
export async function resolveFutureHedgeStrategy(
  prisma: PrismaClient,
): Promise<Strategy & { futureHedgeConfig: FutureHedgeConfig | null }> {
  let strategy = await prisma.strategy.findFirst({
    where: { title: FUTURE_HEDGE_STRATEGY_TITLE },
    include: { futureHedgeConfig: true },
  });

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

export type FutureHedgeConfigUpdateInput = {
  isAutoEnabled?: boolean;
  baseLots?: number;
  emaPeriod?: number;
  adjustmentPct?: number;
  targetProfitUsd?: number;
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
  if (input.currentBatchId !== undefined && input.currentBatchId !== null) {
    if (typeof input.currentBatchId !== "string" || !input.currentBatchId.trim()) {
      return "currentBatchId must be a non-empty string or null";
    }
  }
  return null;
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
  if (body.currentBatchId === null) {
    out.currentBatchId = null;
  } else if (typeof body.currentBatchId === "string") {
    out.currentBatchId = body.currentBatchId.trim() || null;
  }

  return out;
}
