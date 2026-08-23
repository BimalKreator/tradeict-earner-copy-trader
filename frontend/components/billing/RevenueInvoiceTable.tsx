"use client";

import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { BillingDisclosure } from "@/components/billing/BillingDisclosure";
import { HwmInvoiceExplainer } from "@/components/money/HwmInvoiceExplainer";
import { fmtUsd } from "@/lib/currency";
import { formatIstMonthYear } from "@/lib/istDates";
import {
  isRevenueInvoicePayable,
  payRevenueInvoiceFromWallet,
  payRevenueInvoiceWithRazorpay,
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
          <div className="divide-y divide-white/5">
            {invoices.map((inv) => {
              const payable = isRevenueInvoicePayable(inv);
              const isPaying = payingId === inv.id;
              const isRazorpayPaying = razorpayPayingId === inv.id;
              const insufficient =
                walletBalance != null && walletBalance + 1e-9 < inv.collectibleAmount;
              return (
                <HwmInvoiceExplainer
                  key={inv.id}
                  invoice={inv}
                  payable={payable}
                  isWalletPaying={isPaying}
                  isRazorpayPaying={isRazorpayPaying}
                  walletInsufficient={insufficient}
                  onPayRazorpay={() => void handleRazorpayPay(inv)}
                  onPayWallet={() => void handleWalletPay(inv)}
                />
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
