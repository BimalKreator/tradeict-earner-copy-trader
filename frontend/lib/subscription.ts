export const MAX_SUBSCRIPTION_MULTIPLIER = 10_000;
export const MIN_SUBSCRIPTION_MULTIPLIER = 0.1;

export function clampMultiplier(v: number): number {
  return Math.min(
    MAX_SUBSCRIPTION_MULTIPLIER,
    Math.max(MIN_SUBSCRIPTION_MULTIPLIER, Math.round(v * 10) / 10),
  );
}

export function resolveStrategyBaseCapital(strategy: {
  baseCapital?: number | null;
  minCapital?: number | null;
}): number {
  const base = strategy.baseCapital;
  if (typeof base === "number" && Number.isFinite(base) && base > 0) {
    return base;
  }
  const min = strategy.minCapital;
  if (typeof min === "number" && Number.isFinite(min) && min > 0) {
    return min;
  }
  return 10;
}

export function deployedCapitalFromMultiplier(
  multiplier: number,
  baseCapital: number,
): number {
  const base = resolveStrategyBaseCapital({ baseCapital, minCapital: baseCapital });
  if (!Number.isFinite(multiplier)) return base;
  return Math.round(multiplier * base * 100) / 100;
}

export function multiplierFromDeployedCapital(
  deployedCapital: number,
  baseCapital: number,
): number {
  const base = resolveStrategyBaseCapital({ baseCapital, minCapital: baseCapital });
  const mult = deployedCapital / base;
  return clampMultiplier(mult);
}

export function parseDeployedCapital(value: unknown): number | null {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
}

export type SubscriptionFeeQuote = {
  originalFeeInr: number;
  discountAmountInr: number;
  finalFeeInr: number;
  discountPercentage: number | null;
  couponCode: string | null;
};
