/** Fixed USD → INR rate for all user-facing balance displays. */
export const USD_TO_INR_RATE = 85;

/** @deprecated Use {@link USD_TO_INR_RATE}. */
export const FALLBACK_USD_INR_RATE = USD_TO_INR_RATE;

export function getUsdInrRate(_apiRate?: number | null): number {
  return USD_TO_INR_RATE;
}

export function usdToInr(usd: number): number {
  return usd * USD_TO_INR_RATE;
}

export function inrToUsdDisplay(inr: number): number {
  return inr / USD_TO_INR_RATE;
}

const usdFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const inrFmt = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const dateTimeFmt = new Intl.DateTimeFormat("en-IN", {
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

export function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return usdFmt.format(n);
}

/** Balance display — never show negative wallet/margin amounts. */
export function fmtUsdBalance(n: number | null | undefined): string {
  const safe = typeof n === "number" && Number.isFinite(n) ? Math.max(0, n) : 0;
  return fmtUsd(safe);
}

/** Converts a USD amount to INR at {@link USD_TO_INR_RATE} and formats it. */
export function formatINR(usdValue: number): string {
  if (!Number.isFinite(usdValue)) return "—";
  return inrFmt.format(usdValue * USD_TO_INR_RATE);
}

/** INR equivalent with approximate prefix for secondary balance lines. */
export function formatINRApprox(usdValue: number): string {
  const formatted = formatINR(usdValue);
  return formatted === "—" ? formatted : `≈ ${formatted}`;
}

export function fmtInr(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return inrFmt.format(n);
}

export function fmtDateTime(iso: string): string {
  try {
    return dateTimeFmt.format(new Date(iso));
  } catch {
    return iso;
  }
}

export function mapPaymentStatus(status: string): "PAID" | "PENDING" | "FAILED" {
  const s = status.toUpperCase();
  if (s === "APPROVED" || s === "PAID") return "PAID";
  if (s === "REJECTED" || s === "FAILED") return "FAILED";
  return "PENDING";
}
