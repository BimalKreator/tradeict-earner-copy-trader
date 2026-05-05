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
  syncActiveTrades: true,
  createdAt: true,
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
  syncActiveTrades: true,
  createdAt: true,
};

export const STRATEGY_SELECT_LATE_JOIN: Prisma.StrategySelect = {
  id: true,
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
};

export const STRATEGY_SELECT_SUBSCRIBE_GATE: Prisma.StrategySelect = {
  id: true,
  syncActiveTrades: true,
};
