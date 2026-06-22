"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  CheckCircle2,
  CreditCard,
  Loader2,
  RefreshCw,
  Wallet,
} from "lucide-react";
import { COMPANY } from "@/lib/company";
import {
  fmtInr,
  fmtUsd,
  usdToInr,
} from "@/lib/currency";
import { openRazorpayCheckout } from "@/lib/razorpay";

const API_BASE = process.env.NEXT_PUBLIC_API_URL;

type InvoiceStatus = "PENDING" | "PAID" | "OVERDUE";
type InvoiceKind = "REVENUE_SHARE" | "STRATEGY_FEE";

type InvoiceRow = {
  id: string;
  strategyId: string;
  strategyTitle: string;
  strategyMonthlyFeeInr?: number;
  month: number;
  year: number;
  totalPnl: number;
  amountDue: number;
  dueDate: string;
  status: InvoiceStatus;
  kind: InvoiceKind;
  createdAt: string;
  updatedAt: string;
};

type SubscriptionRow = {
  id: string;
  strategyId: string;
  isStrategyFeePaid: boolean;
  strategyFeeCycleEndsAt: string | null;
  strategy: {
    id: string;
    title: string;
    monthlyFee: number;
  };
};

type WalletResponse = {
  balance: number;
  balanceUsd?: number;
};

type Toast = { kind: "success" | "error"; text: string } | null;

const monthLabelFmt = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "long",
});

const dateFmt = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "2-digit",
});

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function fmtMonth(month: number, year: number): string {
  try {
    return monthLabelFmt.format(new Date(Date.UTC(year, month - 1, 1)));
  } catch {
    return `${year}-${String(month).padStart(2, "0")}`;
  }
}

function fmtDate(iso: string): string {
  try {
    return dateFmt.format(new Date(iso));
  } catch {
    return iso;
  }
}

function statusBadgeClasses(status: InvoiceStatus): string {
  switch (status) {
    case "PAID":
      return "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30";
    case "OVERDUE":
      return "bg-red-500/15 text-red-300 ring-1 ring-red-500/30";
    case "PENDING":
    default:
      return "bg-amber-500/15 text-amber-200 ring-1 ring-amber-500/30";
  }
}

function dueDateLabel(
  iso: string,
  status: InvoiceStatus,
): { label: string; tone: string } {
  if (status === "PAID") {
    return { label: "—", tone: "text-white/45" };
  }
  const due = new Date(iso).getTime();
  if (!Number.isFinite(due)) {
    return { label: "—", tone: "text-white/45" };
  }
  const deltaDays = Math.round((due - Date.now()) / MS_PER_DAY);
  if (deltaDays > 1) {
    return { label: `Due in ${deltaDays} days`, tone: "text-amber-300" };
  }
  if (deltaDays === 1) {
    return { label: "Due tomorrow", tone: "text-amber-300" };
  }
  if (deltaDays === 0) {
    return { label: "Due today", tone: "text-amber-300" };
  }
  const overdueBy = Math.abs(deltaDays);
  return {
    label: `Overdue by ${overdueBy} day${overdueBy === 1 ? "" : "s"}`,
    tone: "text-red-300",
  };
}

function invoicePeriodLabel(inv: InvoiceRow): string {
  if (inv.kind === "STRATEGY_FEE") {
    return "Strategy fee";
  }
  return fmtMonth(inv.month, inv.year);
}

function invoiceAmountInr(inv: InvoiceRow): number {
  if (
    inv.kind === "STRATEGY_FEE" &&
    typeof inv.strategyMonthlyFeeInr === "number" &&
    inv.strategyMonthlyFeeInr > 0
  ) {
    return inv.strategyMonthlyFeeInr;
  }
  return Math.ceil(usdToInr(inv.amountDue));
}

async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;
  return fetch(`${API_BASE}${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${token ?? ""}`,
    },
  });
}

export function BillingDashboard() {
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [subscriptions, setSubscriptions] = useState<SubscriptionRow[]>([]);
  const [wallet, setWallet] = useState<WalletResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast>(null);
  const [payingId, setPayingId] = useState<string | null>(null);
  const [razorpayPayingId, setRazorpayPayingId] = useState<string | null>(null);

  const loadAll = useCallback(async (silent: boolean) => {
    try {
      const [invRes, subRes, walletRes] = await Promise.all([
        authFetch("/user/invoices"),
        authFetch("/subscriptions/mine"),
        authFetch("/wallet/me"),
      ]);

      if (invRes.status === 401 || subRes.status === 401) {
        setError("Sign in to view billing.");
        return;
      }

      if (!invRes.ok || !subRes.ok) {
        throw new Error("Failed to load billing data.");
      }

      const invBody = (await invRes.json()) as { invoices?: InvoiceRow[] };
      const subBody = (await subRes.json()) as {
        subscriptions?: SubscriptionRow[];
      };

      setInvoices(
        Array.isArray(invBody.invoices)
          ? invBody.invoices.map((row) => ({
              ...row,
              kind: row.kind ?? "REVENUE_SHARE",
            }))
          : [],
      );
      setSubscriptions(
        Array.isArray(subBody.subscriptions) ? subBody.subscriptions : [],
      );

      if (walletRes.ok) {
        const w = (await walletRes.json()) as WalletResponse;
        setWallet(w);
      } else {
        setWallet(null);
      }

      if (!silent) setError(null);
    } catch (e) {
      if (!silent) {
        setError(e instanceof Error ? e.message : "Failed to load billing.");
      }
    } finally {
      if (silent) setRefreshing(false);
      else setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll(false);
  }, [loadAll]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 5000);
    return () => window.clearTimeout(t);
  }, [toast]);

  const unpaidStrategyFeeSubs = useMemo(
    () => subscriptions.filter((s) => s.isStrategyFeePaid === false),
    [subscriptions],
  );

  const pendingStrategyFeeInvoices = useMemo(
    () =>
      invoices.filter(
        (inv) =>
          inv.kind === "STRATEGY_FEE" &&
          (inv.status === "PENDING" || inv.status === "OVERDUE"),
      ),
    [invoices],
  );

  const pendingRevenueInvoices = useMemo(
    () =>
      invoices.filter(
        (inv) =>
          inv.kind !== "STRATEGY_FEE" &&
          (inv.status === "PENDING" || inv.status === "OVERDUE"),
      ),
    [invoices],
  );

  const payableInvoices = useMemo(
    () => [...pendingStrategyFeeInvoices, ...pendingRevenueInvoices],
    [pendingRevenueInvoices, pendingStrategyFeeInvoices],
  );

  const showStrategyFeeBanner =
    unpaidStrategyFeeSubs.length > 0 || pendingStrategyFeeInvoices.length > 0;

  const walletBalance = wallet?.balanceUsd ?? wallet?.balance ?? 0;

  const payFromWallet = useCallback(
    async (invoice: InvoiceRow) => {
      if (!wallet) {
        setToast({
          kind: "error",
          text: "Wallet not loaded. Refresh or top up from the Wallet page.",
        });
        return;
      }
      if (walletBalance + 1e-9 < invoice.amountDue) {
        setToast({
          kind: "error",
          text: `Insufficient wallet balance — top up at least ${fmtUsd(invoice.amountDue - walletBalance)}.`,
        });
        return;
      }

      setPayingId(invoice.id);
      try {
        const res = await authFetch(`/billing/pay-invoice/${invoice.id}`, {
          method: "POST",
        });
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) {
          throw new Error(data.error ?? "Payment failed");
        }
        const label =
          invoice.kind === "STRATEGY_FEE"
            ? `Strategy fee for ${invoice.strategyTitle}`
            : `${invoicePeriodLabel(invoice)} (${invoice.strategyTitle})`;
        setToast({
          kind: "success",
          text: `Paid ${fmtUsd(invoice.amountDue)} for ${label}.`,
        });
        setRefreshing(true);
        await loadAll(true);
      } catch (e) {
        setToast({
          kind: "error",
          text: e instanceof Error ? e.message : "Payment failed",
        });
      } finally {
        setPayingId(null);
      }
    },
    [loadAll, wallet, walletBalance],
  );

  const payWithRazorpay = useCallback(
    async (invoice: InvoiceRow) => {
      setRazorpayPayingId(invoice.id);
      try {
        const orderRes = await authFetch("/payments/create-order", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            purpose: "invoice",
            invoiceId: invoice.id,
            currency: "INR",
          }),
        });
        const orderData = (await orderRes.json().catch(() => ({}))) as {
          error?: string;
          orderId?: string;
          keyId?: string;
          amount?: number;
          currency?: string;
        };
        if (!orderRes.ok) {
          throw new Error(orderData.error ?? "Could not start payment");
        }

        const description =
          invoice.kind === "STRATEGY_FEE"
            ? `Strategy fee — ${invoice.strategyTitle}`
            : `Revenue share — ${invoicePeriodLabel(invoice)} (${invoice.strategyTitle})`;

        await new Promise<void>((resolve, reject) => {
          void openRazorpayCheckout({
            keyId: orderData.keyId ?? "",
            orderId: orderData.orderId ?? "",
            amountInr: orderData.amount ?? 0,
            currency: orderData.currency ?? "INR",
            name: COMPANY.legalName,
            description,
            onSuccess: async (rzpResponse) => {
              try {
                const verifyRes = await authFetch("/payments/verify", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(rzpResponse),
                });
                const verifyBody = (await verifyRes.json().catch(() => ({}))) as {
                  error?: string;
                };
                if (!verifyRes.ok) {
                  throw new Error(verifyBody.error ?? "Payment verification failed");
                }
                resolve();
              } catch (err) {
                reject(err);
              }
            },
            onDismiss: () => reject(new Error("Payment cancelled")),
          });
        });

        setToast({
          kind: "success",
          text:
            invoice.kind === "STRATEGY_FEE"
              ? `Strategy fee paid for ${invoice.strategyTitle}.`
              : `Invoice paid for ${invoice.strategyTitle}.`,
        });
        setRefreshing(true);
        await loadAll(true);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Payment failed";
        if (msg !== "Payment cancelled") {
          setToast({ kind: "error", text: msg });
        }
      } finally {
        setRazorpayPayingId(null);
      }
    },
    [loadAll],
  );

  return (
    <div className="space-y-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">
            Billing
          </h1>
          <p className="mt-1 text-sm text-white/55">
            Strategy fees, revenue-share invoices, and payment history.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href="/dashboard/wallet"
            className="inline-flex items-center gap-2 rounded-lg border border-glassBorder bg-white/[0.03] px-4 py-2 text-sm font-medium text-white/80 hover:bg-white/[0.06]"
          >
            <Wallet className="h-4 w-4" aria-hidden />
            Wallet
          </Link>
          <button
            type="button"
            onClick={() => {
              setRefreshing(true);
              void loadAll(true);
            }}
            disabled={loading || refreshing}
            className="inline-flex items-center gap-2 rounded-lg border border-glassBorder bg-white/[0.03] px-4 py-2 text-sm font-medium text-white/80 hover:bg-white/[0.06] disabled:opacity-50"
          >
            <RefreshCw
              className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`}
              aria-hidden
            />
            Refresh
          </button>
        </div>
      </header>

      {toast ? (
        <div
          className={`flex items-start gap-3 rounded-lg border px-4 py-3 text-sm ${
            toast.kind === "success"
              ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-100"
              : "border-red-500/40 bg-red-500/10 text-red-100"
          }`}
          role="status"
        >
          {toast.kind === "success" ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          ) : (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          )}
          <span>{toast.text}</span>
        </div>
      ) : null}

      {error ? (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      ) : null}

      {showStrategyFeeBanner && !loading ? (
        <div
          className="flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-4 text-sm text-amber-100"
          role="alert"
        >
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" aria-hidden />
          <div>
            <p className="font-medium text-amber-50">
              You have pending strategy fees.
            </p>
            <p className="mt-1 text-amber-100/90">
              Please pay them before your cycle ends to avoid service interruption.
            </p>
          </div>
        </div>
      ) : null}

      {loading ? (
        <div className="glass-card border border-glassBorder px-6 py-16 text-center">
          <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />
          <p className="mt-3 text-sm text-white/55">Loading billing…</p>
        </div>
      ) : (
        <>
          {payableInvoices.length > 0 ? (
            <section className="glass-card border border-glassBorder overflow-hidden">
              <div className="border-b border-glassBorder bg-white/[0.03] px-5 py-3">
                <h2 className="text-sm font-semibold text-white">Pending dues</h2>
                <p className="text-xs text-white/45">
                  {payableInvoices.length} invoice
                  {payableInvoices.length === 1 ? "" : "s"} awaiting payment
                </p>
              </div>
              <div className="scroll-table overflow-x-auto">
                <table className="w-full min-w-[880px] text-left text-sm">
                  <thead className="border-b border-glassBorder bg-white/[0.02]">
                    <tr>
                      <th className="px-4 py-3 font-medium text-white/70">Type</th>
                      <th className="px-4 py-3 font-medium text-white/70">Strategy</th>
                      <th className="px-4 py-3 text-right font-medium text-white/70">
                        Amount
                      </th>
                      <th className="px-4 py-3 font-medium text-white/70">Due</th>
                      <th className="px-4 py-3 text-right font-medium text-white/70">
                        Action
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {payableInvoices.map((inv) => {
                      const due = dueDateLabel(inv.dueDate, inv.status);
                      const amountInr = invoiceAmountInr(inv);
                      const isPaying = payingId === inv.id;
                      const isRazorpayPaying = razorpayPayingId === inv.id;
                      const insufficient =
                        wallet !== null && walletBalance + 1e-9 < inv.amountDue;
                      return (
                        <tr
                          key={inv.id}
                          className="border-b border-white/[0.06] last:border-0 hover:bg-white/[0.02]"
                        >
                          <td className="px-4 py-3 text-white/80">
                            {inv.kind === "STRATEGY_FEE" ? (
                              <span className="inline-flex rounded-full bg-violet-500/15 px-2 py-0.5 text-xs font-medium text-violet-200 ring-1 ring-violet-500/30">
                                Strategy fee
                              </span>
                            ) : (
                              <span className="text-white/65">
                                {invoicePeriodLabel(inv)}
                              </span>
                            )}
                          </td>
                          <td className="max-w-[220px] truncate px-4 py-3 text-white">
                            {inv.strategyTitle}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <p className="font-semibold tabular-nums text-white">
                              {fmtInr(amountInr)}
                            </p>
                            <p className="text-xs tabular-nums text-white/45">
                              {fmtUsd(inv.amountDue)}
                            </p>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex flex-col gap-0.5">
                              <span className="tabular-nums text-white/65">
                                {fmtDate(inv.dueDate)}
                              </span>
                              <span className={`text-xs ${due.tone}`}>
                                {due.label}
                              </span>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-right">
                            <div className="flex flex-col items-end gap-2">
                              <button
                                type="button"
                                onClick={() => void payWithRazorpay(inv)}
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
                                onClick={() => void payFromWallet(inv)}
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
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          <section className="glass-card border border-glassBorder overflow-hidden">
            <div className="border-b border-glassBorder bg-white/[0.03] px-5 py-3">
              <h2 className="text-sm font-semibold text-white">All invoices</h2>
              <p className="text-xs text-white/45">
                {invoices.length === 0
                  ? "No invoices yet."
                  : `${invoices.length} total`}
              </p>
            </div>
            <div className="scroll-table overflow-x-auto">
              <table className="w-full min-w-[920px] text-left text-sm">
                <thead className="border-b border-glassBorder bg-white/[0.02]">
                  <tr>
                    <th className="px-4 py-3 font-medium text-white/70">Period / type</th>
                    <th className="px-4 py-3 font-medium text-white/70">Strategy</th>
                    <th className="px-4 py-3 text-right font-medium text-white/70">
                      PnL / fee
                    </th>
                    <th className="px-4 py-3 text-right font-medium text-white/70">
                      Amount
                    </th>
                    <th className="px-4 py-3 font-medium text-white/70">Status</th>
                    <th className="px-4 py-3 font-medium text-white/70">Due</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.length === 0 ? (
                    <tr>
                      <td
                        colSpan={6}
                        className="px-4 py-14 text-center text-white/55"
                      >
                        No invoices yet.
                      </td>
                    </tr>
                  ) : (
                    invoices.map((inv) => {
                      const due = dueDateLabel(inv.dueDate, inv.status);
                      const amountInr = invoiceAmountInr(inv);
                      return (
                        <tr
                          key={inv.id}
                          className="border-b border-white/[0.06] last:border-0"
                        >
                          <td className="whitespace-nowrap px-4 py-3 text-white/80">
                            {invoicePeriodLabel(inv)}
                          </td>
                          <td className="max-w-[220px] truncate px-4 py-3 text-white/80">
                            {inv.strategyTitle}
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums text-white/70">
                            {inv.kind === "STRATEGY_FEE"
                              ? fmtInr(amountInr)
                              : fmtUsd(inv.totalPnl)}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <p className="font-semibold tabular-nums text-white">
                              {inv.kind === "STRATEGY_FEE"
                                ? fmtInr(amountInr)
                                : fmtUsd(inv.amountDue)}
                            </p>
                            {inv.kind === "STRATEGY_FEE" ? (
                              <p className="text-xs text-white/45">
                                {fmtUsd(inv.amountDue)}
                              </p>
                            ) : null}
                          </td>
                          <td className="px-4 py-3">
                            <span
                              className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium uppercase ${statusBadgeClasses(inv.status)}`}
                            >
                              {inv.status}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <span className={`text-xs ${due.tone}`}>{due.label}</span>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
