export const MAX_SUBSCRIPTION_MULTIPLIER = 10_000;
export const MIN_SUBSCRIPTION_MULTIPLIER = 0.1;

export function clampMultiplier(v: number): number {
  return Math.min(
    MAX_SUBSCRIPTION_MULTIPLIER,
    Math.max(MIN_SUBSCRIPTION_MULTIPLIER, Math.round(v * 10) / 10),
  );
}

export type SubscriptionFeeQuote = {
  originalFeeInr: number;
  discountAmountInr: number;
  finalFeeInr: number;
  discountPercentage: number | null;
  couponCode: string | null;
};
