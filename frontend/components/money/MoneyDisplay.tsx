"use client";

import {
  fmtRateLabel,
  fmtUsdSigned,
  formatINR,
  RATE_MISSING_MESSAGE,
  resolveUsdInrRate,
  pnlGlyph,
  pnlToneClass,
} from "@/lib/currency";

export type MoneyDisplayMode = "pnl" | "balance" | "neutral";

export type MoneyDisplayProps = {
  /** USD amount; null = unknown ("—"), 0 = truly zero. */
  usd: number | null | undefined;
  /** Platform rate from server (nullable when unset). */
  rate?: number | null;
  /** Invoice-pinned rate — takes precedence when set. */
  pinnedRate?: number | null;
  mode?: MoneyDisplayMode;
  align?: "left" | "right";
  /** Hide USD secondary line (e.g. INR-only deposit rows). */
  usdSecondary?: boolean;
  className?: string;
};

/**
 * INR primary (large) + USD secondary (small) with always-visible sign and ▲/▼ glyph.
 */
export function MoneyDisplay({
  usd,
  rate,
  pinnedRate,
  mode = "pnl",
  align = "right",
  usdSecondary = false,
  className = "",
}: MoneyDisplayProps) {
  const alignClass = align === "right" ? "text-right" : "text-left";

  if (usd === null || usd === undefined || !Number.isFinite(usd)) {
    return (
      <span className={`tabular-nums text-white/45 ${alignClass} ${className}`}>—</span>
    );
  }

  const effectiveRate = resolveUsdInrRate(pinnedRate ?? rate);
  const displayUsd = mode === "balance" ? Math.max(0, usd) : usd;
  const showPnlStyle = mode === "pnl";
  const glyph = showPnlStyle ? pnlGlyph(displayUsd) : "";
  const tone = showPnlStyle ? pnlToneClass(displayUsd) : "text-white";

  if (effectiveRate == null) {
    return (
      <div className={`tabular-nums ${alignClass} ${className}`}>
        <p className="text-base font-semibold leading-tight text-white/45">—</p>
        {!usdSecondary ? (
          <p className="mt-0.5 text-xs text-white/45">{fmtUsdSigned(displayUsd)}</p>
        ) : null}
        <p className="mt-0.5 text-[10px] text-amber-200/80">{RATE_MISSING_MESSAGE}</p>
      </div>
    );
  }

  const inrText = formatINR(displayUsd, effectiveRate);

  return (
    <div className={`tabular-nums ${alignClass} ${className}`}>
      <p className={`text-base font-semibold leading-tight ${tone}`}>
        {glyph ? (
          <span className="mr-0.5 text-[0.65em] align-middle" aria-hidden>
            {glyph}
          </span>
        ) : null}
        {inrText}
      </p>
      {!usdSecondary ? (
        <p className="mt-0.5 text-xs text-white/45">{fmtUsdSigned(displayUsd)}</p>
      ) : null}
      <p className="mt-0.5 text-[10px] text-white/35">{fmtRateLabel(effectiveRate)}</p>
    </div>
  );
}

/** Compact single-line amount for card fronts — amount never truncates. */
export function MoneyDisplayCompact({
  usd,
  rate,
  pinnedRate,
  mode = "pnl",
  className = "",
}: Omit<MoneyDisplayProps, "align" | "usdSecondary">) {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) {
    return <span className={`shrink-0 tabular-nums text-white/45 ${className}`}>—</span>;
  }

  const effectiveRate = resolveUsdInrRate(pinnedRate ?? rate);
  const displayUsd = mode === "balance" ? Math.max(0, usd) : usd;
  const showPnlStyle = mode === "pnl";
  const glyph = showPnlStyle ? pnlGlyph(displayUsd) : "";
  const tone = showPnlStyle ? pnlToneClass(displayUsd) : "text-white";

  if (effectiveRate == null) {
    return (
      <span className={`shrink-0 whitespace-nowrap tabular-nums text-white/45 ${className}`}>
        —
      </span>
    );
  }

  const inrText = formatINR(displayUsd, effectiveRate);

  return (
    <span className={`shrink-0 whitespace-nowrap tabular-nums ${className}`}>
      <span className={`font-semibold ${tone}`}>
        {glyph ? (
          <span className="mr-0.5 text-[0.65em]" aria-hidden>
            {glyph}
          </span>
        ) : null}
        {inrText}
      </span>
    </span>
  );
}

/** INR-only signed display (deposits billed in INR). */
export function InrMoneyDisplay({
  inr,
  className = "",
}: {
  inr: number | null | undefined;
  className?: string;
}) {
  if (inr === null || inr === undefined || !Number.isFinite(inr)) {
    return <span className={`tabular-nums text-white/45 ${className}`}>—</span>;
  }
  const tone = pnlToneClass(inr);
  const glyph = pnlGlyph(inr);
  const signed = new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
    signDisplay: "always",
  }).format(inr);

  return (
    <span className={`tabular-nums font-semibold ${tone} ${className}`}>
      {glyph ? (
        <span className="mr-0.5 text-[0.65em]" aria-hidden>
          {glyph}
        </span>
      ) : null}
      {signed}
    </span>
  );
}

export function isMoneyZero(usd: number | null | undefined): boolean {
  return usd !== null && usd !== undefined && Number.isFinite(usd) && usd === 0;
}

export function isMoneyUnknown(usd: number | null | undefined): boolean {
  return usd === null || usd === undefined || !Number.isFinite(usd);
}

export { pnlToneClass } from "@/lib/currency";
