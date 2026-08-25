/**
 * USD ↔ INR display helpers.
 * Never invent a rate — without a positive server/invoice rate, INR is null / "—".
 */

export const RATE_MISSING_MESSAGE =
  "Conversion rate not set — contact support";

/** Returns a positive rate or null — never a guessed fallback. */
export function resolveUsdInrRate(
  apiRate?: number | null,
): number | null {
  if (typeof apiRate === "number" && Number.isFinite(apiRate) && apiRate > 0) {
    return apiRate;
  }
  return null;
}

/** @deprecated Prefer {@link resolveUsdInrRate}; returns null when missing. */
export function getUsdInrRate(apiRate?: number | null): number | null {
  return resolveUsdInrRate(apiRate);
}

export function usdToInr(
  usd: number,
  rate?: number | null,
): number | null {
  const r = resolveUsdInrRate(rate);
  if (r == null || !Number.isFinite(usd)) return null;
  return usd * r;
}

export function inrToUsdDisplay(
  inr: number,
  rate?: number | null,
): number | null {
  const r = resolveUsdInrRate(rate);
  if (r == null || !Number.isFinite(inr)) return null;
  return inr / r;
}

const usdFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const usdSignedFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  signDisplay: "always",
});

const inrFmt = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const inrSignedFmt = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  signDisplay: "always",
});

export type PnlDirection = "up" | "down" | "flat" | "unknown";

export function pnlDirection(n: number | null | undefined): PnlDirection {
  if (n === null || n === undefined || !Number.isFinite(n)) return "unknown";
  if (n > 0) return "up";
  if (n < 0) return "down";
  return "flat";
}

export function pnlToneClass(n: number | null | undefined): string {
  switch (pnlDirection(n)) {
    case "up":
      return "text-emerald-300";
    case "down":
      return "text-red-300";
    default:
      return "text-white/75";
  }
}

export function pnlGlyph(n: number | null | undefined): string {
  switch (pnlDirection(n)) {
    case "up":
      return "▲";
    case "down":
      return "▼";
    default:
      return "";
  }
}

export function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return usdFmt.format(n);
}

/** Signed USD — always shows +/−; null is unknown, zero is truly zero. */
export function fmtUsdSigned(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return usdSignedFmt.format(n);
}

/** Signed INR — always shows +/−. */
export function fmtInrSigned(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return inrSignedFmt.format(n);
}

/** Percent display — "—" when value is unknown (distinct from 0%). */
export function fmtPct(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

/** Fixed-decimal number for API metrics (e.g. USDT balance). */
export function fmtNumber(n: number | null | undefined, decimals = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n.toFixed(decimals);
}

/** Wallet balance only — never show negative available balance. */
export function fmtWalletBalance(n: number | null | undefined): string {
  const safe = typeof n === "number" && Number.isFinite(n) ? Math.max(0, n) : 0;
  return fmtUsd(safe);
}

/** @deprecated Use {@link fmtWalletBalance}. */
export const fmtUsdBalance = fmtWalletBalance;

export function fmtRateLabel(rate: number | null | undefined): string {
  const r = resolveUsdInrRate(rate);
  if (r == null) return "";
  return `(at ₹${r.toLocaleString("en-IN")}/$)`;
}

/** Converts USD to INR at the given rate and formats with sign. No rate → "—". */
export function formatINR(
  usdValue: number | null | undefined,
  rate?: number | null,
): string {
  if (usdValue === null || usdValue === undefined || !Number.isFinite(usdValue)) {
    return "—";
  }
  const r = resolveUsdInrRate(rate);
  if (r == null) return "—";
  return inrSignedFmt.format(usdValue * r);
}

/** INR equivalent with approximate prefix and pinned rate label. */
export function formatINRApprox(
  usdValue: number | null | undefined,
  rate?: number | null,
): string {
  if (usdValue === null || usdValue === undefined || !Number.isFinite(usdValue)) {
    return "—";
  }
  const r = resolveUsdInrRate(rate);
  if (r == null) return RATE_MISSING_MESSAGE;
  const inr = inrSignedFmt.format(usdValue * r);
  return `≈ ${inr} ${fmtRateLabel(r)}`;
}

export function fmtInr(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return inrFmt.format(n);
}

/** @deprecated Use {@link formatIstDateTime} from `@/lib/istDates`. */
export function fmtDateTime(iso: string): string {
  try {
    return new Intl.DateTimeFormat("en-IN", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(iso));
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
