export type PaymentMethodKind = "RAZORPAY" | "UPI" | "BANK";

export type FeeBreakdown = {
  baseAmountInr: number;
  feeAmountInr: number;
  totalAmountInr: number;
  netBaseInr: number;
};

export function inrToUsd(inr: number, usdInrRate: number): number {
  const rate = Number.isFinite(usdInrRate) && usdInrRate > 0 ? usdInrRate : 83;
  return inr / rate;
}

export function usdToInr(usd: number, usdInrRate: number): number {
  const rate = Number.isFinite(usdInrRate) && usdInrRate > 0 ? usdInrRate : 83;
  return usd * rate;
}

export function roundInr(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * RAZORPAY: user pays base + fee; wallet credits base (INR → USD).
 * UPI manual: fee deducted from base before wallet credit.
 * BANK: no fee; full base credited.
 */
export function calculateFeeBreakdown(
  baseAmountInr: number,
  pgFeePercent: number,
  method: PaymentMethodKind,
): FeeBreakdown {
  const base = roundInr(Math.max(0, baseAmountInr));
  if (method === "BANK") {
    return {
      baseAmountInr: base,
      feeAmountInr: 0,
      totalAmountInr: base,
      netBaseInr: base,
    };
  }

  const feeAmountInr = roundInr((base * pgFeePercent) / 100);

  if (method === "UPI") {
    return {
      baseAmountInr: base,
      feeAmountInr,
      totalAmountInr: base,
      netBaseInr: roundInr(Math.max(0, base - feeAmountInr)),
    };
  }

  return {
    baseAmountInr: base,
    feeAmountInr,
    totalAmountInr: roundInr(base + feeAmountInr),
    netBaseInr: base,
  };
}
