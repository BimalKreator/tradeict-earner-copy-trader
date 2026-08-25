"use client";

import { ChevronDown, ChevronRight, CreditCard, Loader2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { fmtInr, fmtUsd, formatINRApprox } from "@/lib/currency";
import { formatIstMonthYear } from "@/lib/istDates";
import { revenueInvoiceCollectibleInr } from "@/lib/revenueInvoicePayment";
import type { RevenueInvoiceRow } from "@/lib/revenueInvoiceTypes";

type HwmInvoiceExplainerProps = {
  invoice: RevenueInvoiceRow;
  payable: boolean;
  onPayRazorpay?: () => void;
  onPayWallet?: () => void;
  isRazorpayPaying?: boolean;
  isWalletPaying?: boolean;
  walletInsufficient?: boolean;
};

function MoneyValue({ usd, prefix = "" }: { usd: number; prefix?: string }) {
  const signed = prefix ? `${prefix}${fmtUsd(Math.abs(usd))}` : fmtUsd(usd);
  return (
    <span className="tabular-nums">
      <span className="font-medium text-white">{signed}</span>
      <span className="ml-1 text-xs text-white/45">{formatINRApprox(usd)}</span>
    </span>
  );
}

function CalcRow({
  label,
  value,
  fieldHint,
}: {
  label: string;
  value: ReactNode;
  fieldHint?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5 text-sm">
      <span className="text-white/60">
        {label}
        {fieldHint ? (
          <span className="ml-1 text-xs text-white/35">({fieldHint})</span>
        ) : null}
      </span>
      <span className="text-right">{value}</span>
    </div>
  );
}

export function HwmInvoiceExplainer({
  invoice,
  payable,
  onPayRazorpay,
  onPayWallet,
  isRazorpayPaying = false,
  isWalletPaying = false,
  walletInsufficient = false,
}: HwmInvoiceExplainerProps) {
  const [expanded, setExpanded] = useState(false);

  const x = invoice.realizedPnl;
  const y = invoice.hwmBefore;
  const z = invoice.hwmAfter;
  const b = invoice.billableProfit;
  const s = invoice.profitSharePct;
  const f = invoice.collectibleAmount;
  const freePortion = Math.max(0, x - b);
  const cumulativeEnd = invoice.cumulativeRealizedPnl ?? z;
  const gapBelowBest = Math.max(0, y - cumulativeEnd);
  const collectibleInr = revenueInvoiceCollectibleInr(invoice);

  const summarySentence =
    b === 0 ? (
      <>
        You earned {fmtUsd(x)} this month, but you are still {fmtUsd(gapBelowBest)} below your
        best ever of {fmtUsd(y)}. <strong className="text-white">Nothing to pay this month.</strong>
      </>
    ) : (
      <>
        You earned {fmtUsd(x)} this month. Your previous best was {fmtUsd(y)}, and{" "}
        {fmtUsd(freePortion)} of this month&apos;s profit only brought you back to that level —
        that part is free. So you are billed on {fmtUsd(b)} only.
      </>
    );

  return (
    <div className="border-b border-white/5 last:border-0">
      <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-start sm:justify-between">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-start gap-2 text-left"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? (
            <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-white/45" />
          ) : (
            <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-white/45" />
          )}
          <div className="min-w-0">
            <p className="font-medium text-white">
              {formatIstMonthYear(invoice.periodMonth, invoice.periodYear)}
            </p>
            <p className="mt-1 text-sm text-white/70">
              <MoneyValue usd={f} />
              {collectibleInr != null && collectibleInr > 0 ? (
                <span className="ml-2 text-xs text-white/45">({fmtInr(collectibleInr)} INR)</span>
              ) : null}
            </p>
            <p className="mt-1 text-xs text-white/45">
              {expanded ? "Tap to hide calculation" : "Tap to see how this was calculated"}
            </p>
          </div>
        </button>

        {payable ? (
          <div className="flex shrink-0 flex-col items-stretch gap-2 sm:items-end">
            <button
              type="button"
              onClick={() => onPayRazorpay?.()}
              disabled={isRazorpayPaying || isWalletPaying}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-white hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isRazorpayPaying ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  Processing…
                </>
              ) : (
                <>
                  <CreditCard className="h-3.5 w-3.5" aria-hidden />
                  Pay Now
                </>
              )}
            </button>
            <button
              type="button"
              onClick={() => onPayWallet?.()}
              disabled={isWalletPaying || isRazorpayPaying || walletInsufficient}
              className={`text-[10px] font-medium uppercase tracking-wide ${
                walletInsufficient ? "text-white/35" : "text-white/55 hover:text-white/80"
              }`}
            >
              {isWalletPaying ? "Wallet…" : "Use wallet"}
            </button>
          </div>
        ) : null}
      </div>

      {expanded ? (
        <div className="border-t border-white/10 bg-white/[0.02] px-4 py-4">
          <div className="divide-y divide-white/5">
            <CalcRow
              label="Profit booked this month"
              fieldHint="realizedPnl"
              value={<MoneyValue usd={x} prefix="+" />}
            />
            <CalcRow
              label="Your previous best"
              fieldHint="hwmBefore"
              value={<MoneyValue usd={y} />}
            />
            <CalcRow
              label="New high reached"
              fieldHint="hwmAfter"
              value={<MoneyValue usd={z} />}
            />
          </div>
          <div className="my-3 border-t border-dashed border-white/15" />
          <div className="divide-y divide-white/5">
            <CalcRow
              label="Charged only on"
              fieldHint="billableProfit"
              value={<MoneyValue usd={b} />}
            />
            <CalcRow
              label="Our share"
              fieldHint="profitSharePct"
              value={<span className="tabular-nums text-white">{s.toFixed(1)}%</span>}
            />
            <CalcRow
              label="Your fee"
              fieldHint="commissionAmount"
              value={<MoneyValue usd={f} />}
            />
          </div>
          <p className="mt-4 text-sm leading-relaxed text-white/65">{summarySentence}</p>
        </div>
      ) : null}
    </div>
  );
}
