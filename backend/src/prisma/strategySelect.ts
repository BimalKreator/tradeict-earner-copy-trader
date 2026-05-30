import type { Prisma } from "@prisma/client";

/**
 * Narrow Strategy selects so SQL never references legacy columns removed from the database
 * (e.g. Cosmic-era fields). Always prefer these over unconstrained `findUnique` / `findMany`.
 */
export const STRATEGY_SELECT_ADMIN_LIST: Prisma.StrategySelect = {
  id: true,
  title: true,
  description: true,
  masterApiKey: true,
  masterApiSecret: true,
  performanceMetrics: true,
  slippage: true,
  monthlyFee: true,
  profitShare: true,
  minCapital: true,
  isActive: true,
  syncActiveTrades: true,
  autoExitEnabled: true,
  autoExitTarget: true,
  autoExitStopLoss: true,
  createdAt: true,
  futureHedgeConfig: {
    select: {
      isAutoEnabled: true,
      baseLots: true,
      emaPeriod: true,
      adjustmentPct: true,
      targetProfitUsd: true,
    },
  },
};

/** Admin JSON responses must omit `masterApiSecret`. */
export const STRATEGY_SELECT_ADMIN_SAFE: Prisma.StrategySelect = {
  id: true,
  title: true,
  description: true,
  masterApiKey: true,
  performanceMetrics: true,
  slippage: true,
  monthlyFee: true,
  profitShare: true,
  minCapital: true,
  isActive: true,
  syncActiveTrades: true,
  autoExitEnabled: true,
  autoExitTarget: true,
  autoExitStopLoss: true,
  createdAt: true,
  futureHedgeConfig: {
    select: {
      isAutoEnabled: true,
      baseLots: true,
      emaPeriod: true,
      adjustmentPct: true,
      targetProfitUsd: true,
    },
  },
};

/** Copy engine only runs for strategies with `isActive === true`. */
export const STRATEGY_WHERE_COPY_ENABLED: Prisma.StrategyWhereInput = {
  isActive: true,
};

export const STRATEGY_SELECT_AUTO_EXIT: Prisma.StrategySelect = {
  id: true,
  title: true,
  masterApiKey: true,
  masterApiSecret: true,
  autoExitEnabled: true,
  autoExitTarget: true,
  autoExitStopLoss: true,
};

export const STRATEGY_SELECT_LATE_JOIN: Prisma.StrategySelect = {
  id: true,
  isActive: true,
  syncActiveTrades: true,
  masterApiKey: true,
  masterApiSecret: true,
  slippage: true,
};

export const STRATEGY_SELECT_SLIPPAGE: Prisma.StrategySelect = {
  slippage: true,
};

export const STRATEGY_SELECT_WS_CREDS: Prisma.StrategySelect = {
  masterApiKey: true,
  masterApiSecret: true,
  isActive: true,
};

export const STRATEGY_SELECT_IS_ACTIVE: Prisma.StrategySelect = {
  isActive: true,
};

export const STRATEGY_SELECT_SUBSCRIBE_GATE: Prisma.StrategySelect = {
  id: true,
  syncActiveTrades: true,
};
