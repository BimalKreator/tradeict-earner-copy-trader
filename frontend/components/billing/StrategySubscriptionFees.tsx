"use client";

import { resolveApiBase } from "@/lib/apiBase";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CreditCard,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { COMPANY } from "@/lib/company";
import { fmtInr, fmtUsd, RATE_MISSING_MESSAGE, usdToInr } from "@/lib/currency";
import { useUsdInrRate } from "@/hooks/useUsdInrRate";
import { openRazorpayCheckout } from "@/lib/razorpay";
import {
  DetailRow,
  MoneyRowCard,
  ResponsiveMoneyTable,
} from "@/components/money/MoneyRowCard";

type InvoiceStatus = "PENDING" | "PAID" | "OVERDUE";

type StrategyFeeInvoice = {
  id: string;
  strategyId: string;
  strategyTitle: string;
  strategyMonthlyFeeInr?: number;
  month: number;
  year: number;
  amountDue: number;
  dueDate: string;
  status: InvoiceStatus;
  kind: "STRATEGY_FEE";
};

type SubscriptionRow = {
  id: string;
  strategyId: string;
  isStrategyFeePaid: boolean;
  strategy: { title: string; monthlyFee: number };
};

type WalletResponse = {
  balance: number;
  balanceUsd?: number;
};

type Toast = { kind: "success" | "error"; text: string } | null;

const dateFmt = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "2-digit",
});

function fmtDate(iso: string): string {
  try {
    return dateFmt.format(new Date(iso));
  } catch {
    return iso;
  }
}

function invoiceAmountInr(
  inv: StrategyFeeInvoice,
  rate: number | null,
): number | null {
  if (typeof inv.strategyMonthlyFeeInr === "number" && inv.strategyMonthlyFeeInr > 0) {
    return inv.strategyMonthlyFeeInr;
  }
  const converted = usdToInr(inv.amountDue, rate);
  return converted == null ? null : Math.ceil(converted);
}

async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;
  return fetch(`${resolveApiBase()}${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${token ?? ""}`,
    },
  });
}

export function StrategySubscriptionFees() {
  const { rate: usdInrRate } = useUsdInrRate();
  const [invoices, setInvoices] = useState<StrategyFeeInvoice[]>([]);
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
        setError("Sign in to view strategy fees.");
        return;
      }
      if (!invRes.ok || !subRes.ok) {
        throw new Error("Failed to load strategy fee data.");
      }

      const invBody = (await invRes.json()) as { invoices?: StrategyFeeInvoice[] };
      const subBody = (await subRes.json()) as { subscriptions?: SubscriptionRow[] };

      setInvoices(
        Array.isArray(invBody.invoices)
          ? invBody.invoices.filter((row) => row.kind === "STRATEGY_FEE")
          : [],
      );
      setSubscriptions(Array.isArray(subBody.subscriptions) ? subBody.subscriptions : []);

      if (walletRes.ok) {
        setWallet((await walletRes.json()) as WalletResponse);
      } else {
        setWallet(null);
      }
      if (!silent) setError(null);
    } catch (e) {
      if (!silent) {
        setError(e instanceof Error ? e.message : "Failed to load strategy fees.");
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

  const payableInvoices = useMemo(
    () =>
      invoices.filter(
        (inv) => inv.status === "PENDING" || inv.status === "OVERDUE",
      ),
    [invoices],
  );

  const walletBalance = wallet?.balanceUsd ?? wallet?.balance ?? 0;

  const payFromWallet = useCallback(
    async (invoice: StrategyFeeInvoice) => {
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
        if (!res.ok) throw new Error(data.error ?? "Payment failed");
        setToast({
          kind: "success",
          text: `Paid strategy fee for ${invoice.strategyTitle}.`,
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
    [loadAll, walletBalance],
  );

  const payWithRazorpay = useCallback(
    async (invoice: StrategyFeeInvoice) => {
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
        if (!orderRes.ok) throw new Error(orderData.error ?? "Could not start payment");

        await new Promise<void>((resolve, reject) => {
          void openRazorpayCheckout({
            keyId: orderData.keyId ?? "",
            orderId: orderData.orderId ?? "",
            amountInr: orderData.amount ?? 0,
            currency: orderData.currency ?? "INR",
            name: COMPANY.legalName,
            description: `Strategy fee — ${invoice.strategyTitle}`,
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

        setToast({ kind: "success", text: `Strategy fee paid for ${invoice.strategyTitle}.` });
        setRefreshing(true);
        await loadAll(true);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Payment failed";
        if (msg !== "Payment cancelled") setToast({ kind: "error", text: msg });
      } finally {
        setRazorpayPayingId(null);
      }
    },
    [loadAll],
  );

  if (loading) {
    return (
      <section className="space-y-3">
        <h2 className="text-lg font-medium text-white">Strategy subscription fees</h2>
        <div className="flex justify-center rounded-xl border border-white/10 py-12">
          <Loader2 className="h-8 w-8 animate-spin text-white/30" />
        </div>
      </section>
    );
  }

  if (
    error &&
    invoices.length === 0 &&
    unpaidStrategyFeeSubs.length === 0
  ) {
    return null;
  }

  if (invoices.length === 0 && unpaidStrategyFeeSubs.length === 0) {
    return null;
  }

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium text-white">Strategy subscription fees</h2>
          <p className="mt-1 text-sm text-white/55">
            Monthly strategy access fees — separate from profit-share billing above.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setRefreshing(true);
            void loadAll(true);
          }}
          disabled={refreshing}
          className="inline-flex items-center gap-2 rounded-lg border border-white/15 px-3 py-2 text-sm text-white/80 hover:bg-white/5 disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
          Refresh
        </button>
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

      {(unpaidStrategyFeeSubs.length > 0 || payableInvoices.length > 0) && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-4 text-sm text-amber-100">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" aria-hidden />
          <p>You have pending strategy subscription fees.</p>
        </div>
      )}

      {payableInvoices.length > 0 ? (
        <div className="overflow-hidden rounded-xl border border-white/10">
          <ResponsiveMoneyTable
            table={
              <table className="w-full text-left text-sm">
                <thead className="border-b border-white/10 bg-white/[0.03] text-xs uppercase text-white/40">
                  <tr>
                    <th className="px-4 py-3">Strategy</th>
                    <th className="px-4 py-3 text-right">Amount</th>
                    <th className="px-4 py-3">Due</th>
                    <th className="px-4 py-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {payableInvoices.map((inv) => {
                    const amountInr = invoiceAmountInr(inv, usdInrRate);
                    const isPaying = payingId === inv.id;
                    const isRazorpayPaying = razorpayPayingId === inv.id;
                    const insufficient = walletBalance + 1e-9 < inv.amountDue;
                    return (
                      <tr key={inv.id} className="text-white/85">
                        <td className="px-4 py-3">{inv.strategyTitle}</td>
                        <td className="px-4 py-3 text-right">
                          <p className="font-semibold tabular-nums">
                            {amountInr != null ? fmtInr(amountInr) : "—"}
                          </p>
                          <p className="text-xs tabular-nums text-white/45">
                            {fmtUsd(inv.amountDue)}
                          </p>
                          {amountInr == null ? (
                            <p className="mt-0.5 text-[10px] text-amber-200/80">
                              {RATE_MISSING_MESSAGE}
                            </p>
                          ) : null}
                        </td>
                        <td className="px-4 py-3 tabular-nums text-white/65">
                          {fmtDate(inv.dueDate)}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex flex-col items-end gap-2">
                            <button
                              type="button"
                              onClick={() => void payWithRazorpay(inv)}
                              disabled={isRazorpayPaying || isPaying}
                              className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-white hover:bg-primary/90 disabled:opacity-50"
                            >
                              {isRazorpayPaying ? (
                                <>
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                  Processing…
                                </>
                              ) : (
                                <>
                                  <CreditCard className="h-3.5 w-3.5" />
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
            }
            cards={payableInvoices.map((inv) => {
              const amountInr = invoiceAmountInr(inv, usdInrRate);
              const isPaying = payingId === inv.id;
              const isRazorpayPaying = razorpayPayingId === inv.id;
              const insufficient = walletBalance + 1e-9 < inv.amountDue;
              return (
                <MoneyRowCard
                  key={inv.id}
                  primary={inv.strategyTitle}
                  secondary={
                    <span className="tabular-nums">Due {fmtDate(inv.dueDate)}</span>
                  }
                  amount={
                    <span className="text-right">
                      <span className="block font-semibold tabular-nums text-white">
                        {amountInr != null ? fmtInr(amountInr) : "—"}
                      </span>
                      <span className="block text-xs tabular-nums text-white/45">
                        {fmtUsd(inv.amountDue)}
                      </span>
                    </span>
                  }
                  details={
                    <div className="divide-y divide-white/5">
                      <DetailRow
                        label="Amount (INR)"
                        value={amountInr != null ? fmtInr(amountInr) : "—"}
                      />
                      <DetailRow
                        label="Amount (USD)"
                        value={fmtUsd(inv.amountDue)}
                      />
                      {amountInr == null ? (
                        <p className="py-1.5 text-[10px] text-amber-200/80">
                          {RATE_MISSING_MESSAGE}
                        </p>
                      ) : null}
                      <DetailRow label="Due" value={fmtDate(inv.dueDate)} />
                      <div className="flex flex-col items-stretch gap-2 pt-3">
                        <button
                          type="button"
                          onClick={() => void payWithRazorpay(inv)}
                          disabled={isRazorpayPaying || isPaying}
                          className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2 text-xs font-semibold uppercase tracking-wide text-white hover:bg-primary/90 disabled:opacity-50"
                        >
                          {isRazorpayPaying ? (
                            <>
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              Processing…
                            </>
                          ) : (
                            <>
                              <CreditCard className="h-3.5 w-3.5" />
                              Pay Now
                            </>
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => void payFromWallet(inv)}
                          disabled={isPaying || isRazorpayPaying || insufficient}
                          className={`text-center text-[10px] font-medium uppercase tracking-wide ${
                            insufficient
                              ? "text-white/35"
                              : "text-white/55 hover:text-white/80"
                          }`}
                        >
                          {isPaying ? "Wallet…" : "Use wallet"}
                        </button>
                      </div>
                    </div>
                  }
                />
              );
            })}
          />
        </div>
      ) : invoices.some((i) => i.status === "PAID") ? (
        <p className="text-sm text-white/45">
          <CheckCircle2 className="mr-1 inline h-4 w-4 text-emerald-400" />
          All strategy subscription fees are paid.
        </p>
      ) : null}
    </section>
  );
}
