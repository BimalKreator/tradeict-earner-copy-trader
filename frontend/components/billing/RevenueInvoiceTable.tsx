"use client";

import { CreditCard, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { BillingDisclosure } from "@/components/billing/BillingDisclosure";
import { fmtInr, fmtUsd, formatINRApprox } from "@/lib/currency";
import { formatIstCalendarDate, formatIstMonthYear } from "@/lib/istDates";
import {
  isRevenueInvoicePayable,
  payRevenueInvoiceFromWallet,
  payRevenueInvoiceWithRazorpay,
  revenueInvoiceCollectibleInr,
} from "@/lib/revenueInvoicePayment";
import type { RevenueInvoiceRow } from "@/lib/revenueInvoiceTypes";

type Toast = { kind: "success" | "error"; text: string } | null;

type RevenueInvoiceTableProps = {
  invoices: RevenueInvoiceRow[];
  loading?: boolean;
  walletBalance?: number | null;
  showDisclosure?: boolean;
  title?: string;
  onPaid?: () => void;
  className?: string;
};

function MoneyCell({ usd, muted = false }: { usd: number; muted?: boolean }) {
  return (
    <div className={muted ? "text-white/70" : ""}>
      <div className="font-medium tabular-nums">{fmtUsd(usd)}</div>
      <div className="text-xs tabular-nums text-white/45">{formatINRApprox(usd)}</div>
    </div>
  );
}

function statusBadge(status: string): string {
  switch (status) {
    case "PAID":
      return "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30";
    case "INVOICED":
      return "bg-amber-500/15 text-amber-200 ring-1 ring-amber-500/30";
    case "VOID":
      return "bg-red-500/15 text-red-300 ring-1 ring-red-500/30";
    default:
      return "bg-white/10 text-white/70";
  }
}

export function RevenueInvoiceTable({
  invoices,
  loading = false,
  walletBalance = null,
  showDisclosure = true,
  title = "Profit share invoices",
  onPaid,
  className = "",
}: RevenueInvoiceTableProps) {
  const [payingId, setPayingId] = useState<string | null>(null);
  const [razorpayPayingId, setRazorpayPayingId] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast>(null);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 5000);
    return () => window.clearTimeout(t);
  }, [toast]);

  const handleWalletPay = useCallback(
    async (invoice: RevenueInvoiceRow) => {
      if (walletBalance != null && walletBalance + 1e-9 < invoice.collectibleAmount) {
        setToast({
          kind: "error",
          text: `Insufficient wallet balance — top up at least ${fmtUsd(invoice.collectibleAmount - walletBalance)}.`,
        });
        return;
      }
      setPayingId(invoice.id);
      try {
        await payRevenueInvoiceFromWallet(invoice);
        setToast({
          kind: "success",
          text: `Paid ${fmtUsd(invoice.collectibleAmount)} for ${formatIstMonthYear(invoice.periodMonth, invoice.periodYear)}.`,
        });
        onPaid?.();
      } catch (e) {
        setToast({
          kind: "error",
          text: e instanceof Error ? e.message : "Payment failed",
        });
      } finally {
        setPayingId(null);
      }
    },
    [onPaid, walletBalance],
  );

  const handleRazorpayPay = useCallback(
    async (invoice: RevenueInvoiceRow) => {
      setRazorpayPayingId(invoice.id);
      try {
        await payRevenueInvoiceWithRazorpay(invoice);
        setToast({
          kind: "success",
          text: `Invoice paid for ${formatIstMonthYear(invoice.periodMonth, invoice.periodYear)}.`,
        });
        onPaid?.();
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Payment failed";
        if (msg !== "Payment cancelled") {
          setToast({ kind: "error", text: msg });
        }
      } finally {
        setRazorpayPayingId(null);
      }
    },
    [onPaid],
  );

  return (
    <section className={`space-y-3 ${className}`}>
      <div>
        <h2 className="text-lg font-medium text-white">{title}</h2>
        {showDisclosure ? <BillingDisclosure className="mt-2 text-sm text-white/55" /> : null}
      </div>

      {toast ? (
        <div
          className={`rounded-lg border px-4 py-3 text-sm ${
            toast.kind === "success"
              ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-100"
              : "border-red-500/40 bg-red-500/10 text-red-100"
          }`}
          role="status"
        >
          {toast.text}
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-xl border border-white/10">
        {loading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-white/30" />
          </div>
        ) : invoices.length === 0 ? (
          <p className="px-6 py-10 text-center text-sm text-white/45">
            No monthly revenue invoices yet. Invoices are generated for closed structures each
            IST calendar month.
          </p>
        ) : (
          <table className="w-full min-w-[880px] text-left text-sm">
            <thead className="border-b border-white/10 bg-white/[0.03] text-xs uppercase text-white/40">
              <tr>
                <th className="px-4 py-3">Period</th>
                <th className="px-4 py-3">Closed</th>
                <th className="px-4 py-3">Realized P&L</th>
                <th className="px-4 py-3">Billable profit</th>
                <th className="px-4 py-3">Share %</th>
                <th className="px-4 py-3">Commission</th>
                <th className="px-4 py-3">Due</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {invoices.map((inv) => {
                const payable = isRevenueInvoicePayable(inv);
                const collectibleInr = revenueInvoiceCollectibleInr(inv);
                const isPaying = payingId === inv.id;
                const isRazorpayPaying = razorpayPayingId === inv.id;
                const insufficient =
                  walletBalance != null &&
                  walletBalance + 1e-9 < inv.collectibleAmount;
                return (
                  <tr key={inv.id} className="text-white/85">
                    <td className="px-4 py-3">
                      {formatIstMonthYear(inv.periodMonth, inv.periodYear)}
                    </td>
                    <td className="px-4 py-3 tabular-nums">{inv.structuresClosed}</td>
                    <td className="px-4 py-3">
                      <MoneyCell usd={inv.realizedPnl} muted />
                    </td>
                    <td className="px-4 py-3">
                      <MoneyCell usd={inv.billableProfit} muted />
                    </td>
                    <td className="px-4 py-3 tabular-nums">{inv.profitSharePct.toFixed(1)}%</td>
                    <td className="px-4 py-3">
                      <div>
                        <MoneyCell usd={inv.collectibleAmount} muted />
                        {inv.creditNoteAmount != null && inv.creditNoteAmount > 0 ? (
                          <p className="mt-0.5 text-xs text-white/40">
                            Credit −{fmtUsd(inv.creditNoteAmount)}
                          </p>
                        ) : null}
                        {collectibleInr > 0 ? (
                          <p className="mt-0.5 text-xs tabular-nums text-white/45">
                            {fmtInr(collectibleInr)} (pinned rate)
                          </p>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-4 py-3 tabular-nums text-white/65">
                      {inv.dueDate ? formatIstCalendarDate(inv.dueDate) : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium uppercase ${statusBadge(inv.status)}`}
                      >
                        {inv.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {payable ? (
                        <div className="flex flex-col items-end gap-2">
                          <button
                            type="button"
                            onClick={() => void handleRazorpayPay(inv)}
                            disabled={isRazorpayPaying || isPaying}
                            className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-white hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
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
                            onClick={() => void handleWalletPay(inv)}
                            disabled={isPaying || isRazorpayPaying || insufficient}
                            className={`text-[10px] font-medium uppercase tracking-wide ${
                              insufficient
                                ? "text-white/35"
                                : "text-white/55 hover:text-white/80"
                            }`}
                          >
                            {isPaying ? "Wallet…" : "Use wallet"}
                          </button>
                        </div>
                      ) : (
                        <span className="text-white/35">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
