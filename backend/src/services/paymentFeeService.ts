import { Prisma } from "@prisma/client";

/**
 * INR amounts to 2 decimal places (paise) using banker's rounding.
 * Prefer this over Math.ceil / Math.round when converting money to INR.
 */
export function roundInr(n: number): number {
  const d = new Prisma.Decimal(Number.isFinite(n) ? n : 0);
  return d
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_EVEN)
    .toNumber();
}

export type PaymentMethodKind = "RAZORPAY" | "UPI" | "BANK";

export type FeeBreakdown = {
  baseAmountInr: number;
  feeAmountInr: number;
  totalAmountInr: number;
  netBaseInr: number;
};

export function inrToUsd(inr: number, usdInrRate: number): number {
  if (!Number.isFinite(usdInrRate) || usdInrRate <= 0) {
    throw new Error("usdInrRate must be a positive finite number");
  }
  return inr / usdInrRate;
}

export function usdToInr(usd: number, usdInrRate: number): number {
  if (!Number.isFinite(usdInrRate) || usdInrRate <= 0) {
    throw new Error("usdInrRate must be a positive finite number");
  }
  return usd * usdInrRate;
}

/**
 * RAZORPAY: user pays base + fee; wallet credits base (INR → USD).
 * UPI manual: fee deducted from base before wallet credit.
 * BANK: no fee; full base credited.
 *
 * Fee is computed on the true (ROUND_HALF_EVEN) base — never on a ceil'd base.
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
