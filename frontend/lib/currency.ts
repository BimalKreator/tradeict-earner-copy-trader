const DEFAULT_RATE = Number.parseFloat(
  process.env.NEXT_PUBLIC_RAZORPAY_USD_INR_RATE ?? "83",
);

export function getUsdInrRate(fallback?: number): number {
  if (typeof fallback === "number" && Number.isFinite(fallback) && fallback > 0) {
    return fallback;
  }
  return Number.isFinite(DEFAULT_RATE) && DEFAULT_RATE > 0 ? DEFAULT_RATE : 83;
}

export function usdToInr(usd: number, rate: number): number {
  return usd * rate;
}

export function inrToUsdDisplay(inr: number, rate: number): number {
  return inr / rate;
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
