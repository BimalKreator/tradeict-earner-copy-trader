/** Maximum copy-trade multiplier (contracts scale vs master). */
export const MAX_SUBSCRIPTION_MULTIPLIER = 10_000;
export const MIN_SUBSCRIPTION_MULTIPLIER = 0.1;

export const STRATEGY_PAYMENT_MODE = {
  PAY_NOW: "PAY_NOW",
  PAY_LATER: "PAY_LATER",
} as const;

export type StrategyPaymentMode =
  (typeof STRATEGY_PAYMENT_MODE)[keyof typeof STRATEGY_PAYMENT_MODE];

/** Pay-later grace period before strategy fee must be settled. */
export const STRATEGY_FEE_CYCLE_DAYS = 30;
