"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertCircle,
  CheckCircle2,
  CircleDollarSign,
  CreditCard,
  Info,
  Loader2,
  Plus,
  RefreshCw,
  Wallet as WalletIcon,
} from "lucide-react";
import { COMPANY } from "@/lib/company";
import { openRazorpayCheckout } from "@/lib/razorpay";

const API_BASE = process.env.NEXT_PUBLIC_API_URL;
const USD_INR_RATE = Number.parseFloat(
  process.env.NEXT_PUBLIC_RAZORPAY_USD_INR_RATE ?? "83",
);

type LiveCycleStrategy = {
  strategyId: string;
  strategyTitle: string;
  profitShare: number;
  cumulativePnl: number;
  estimatedDue: number;
};

type LiveCycleResponse = {
  totals: { cumulativePnl: number; estimatedDue: number };
  byStrategy: LiveCycleStrategy[];
};

type WalletResponse = {
  exists: boolean;
  balance: number;
  pendingFees: number;
  overdueDays: number;
};

type InvoiceStatus = "PENDING" | "PAID" | "OVERDUE";

type InvoiceRow = {
  id: string;
  strategyId: string;
  strategyTitle: string;
  month: number;
  year: number;
  totalPnl: number;
  amountDue: number;
  dueDate: string;
  status: InvoiceStatus;
  createdAt: string;
  updatedAt: string;
};

type Toast = { kind: "success" | "error"; text: string } | null;

const usdSignedFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  signDisplay: "always",
});

const usdFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

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

function fmtSigned(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return usdSignedFmt.format(n);
}

function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return usdFmt.format(n);
}

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

function pnlToneClass(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "text-white/70";
  if (n > 0) return "text-emerald-400";
  if (n < 0) return "text-red-300";
  return "text-white/70";
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

/** Returns `{ label, tone }` for a relative-to-now due date. */
function dueDateLabel(
  iso: string,
  status: InvoiceStatus,
): { label: string; tone: string } {
  if (status === "PAID") {
    return { label: "—", tone: "text-white/45" };
  }
  const now = Date.now();
  const due = new Date(iso).getTime();
  if (!Number.isFinite(due)) {
    return { label: "—", tone: "text-white/45" };
  }
  const deltaDays = Math.round((due - now) / MS_PER_DAY);
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

async function authFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
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

export default function DashboardBillingPage() {
  const [liveCycle, setLiveCycle] = useState<LiveCycleResponse | null>(null);
  const [wallet, setWallet] = useState<WalletResponse | null>(null);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);
  const [payingId, setPayingId] = useState<string | null>(null);
  const [razorpayPayingId, setRazorpayPayingId] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast>(null);

  const loadAll = useCallback(async (silent: boolean) => {
    try {
      const [cycleRes, walletRes, invoiceRes] = await Promise.all([
        authFetch("/billing/live-cycle/all"),
        authFetch("/wallet/me"),
        authFetch("/user/invoices"),
      ]);

      if (
        cycleRes.status === 401 ||
        walletRes.status === 401 ||
        invoiceRes.status === 401
      ) {
        if (!silent) {
          setUnauthorized(true);
          setLiveCycle(null);
          setWallet(null);
          setInvoices([]);
        }
        return;
      }

      if (!cycleRes.ok || !walletRes.ok || !invoiceRes.ok) {
        const codes = [cycleRes.status, walletRes.status, invoiceRes.status]
          .filter((c) => c >= 400)
          .join("/");
        throw new Error(`Request failed (${codes})`);
      }

      const cycle = (await cycleRes.json()) as LiveCycleResponse;
      const w = (await walletRes.json()) as WalletResponse;
      const inv = (await invoiceRes.json()) as { invoices?: InvoiceRow[] };

      setLiveCycle(cycle);
      setWallet(w);
      setInvoices(Array.isArray(inv.invoices) ? inv.invoices : []);
      if (!silent) {
        setError(null);
        setUnauthorized(false);
      }
    } catch (e) {
      if (!silent) {
        setError(e instanceof Error ? e.message : "Failed to load billing data");
      }
    } finally {
      if (silent) setRefreshing(false);
      else setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Initial data fetch on mount. setState inside `loadAll` is gated behind
    // an `await`, so it never runs synchronously from this effect body.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- on-mount fetch is a legitimate effect side-effect
    void loadAll(false);
  }, [loadAll]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    void loadAll(true);
  }, [loadAll]);

  // Auto-dismiss toast.
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 5000);
    return () => window.clearTimeout(t);
  }, [toast]);

  const payInvoice = useCallback(
    async (invoice: InvoiceRow) => {
      if (!wallet) return;
      if (wallet.balance + 1e-9 < invoice.amountDue) {
        setToast({
          kind: "error",
          text: `Insufficient wallet balance — top up at least ${fmtUsd(invoice.amountDue - wallet.balance)} to pay this invoice.`,
        });
        return;
      }

      setPayingId(invoice.id);
      try {
        const res = await authFetch(`/billing/pay-invoice/${invoice.id}`, {
          method: "POST",
        });
        const data: unknown = await res.json().catch(() => ({}));
        if (!res.ok) {
          const msg =
            typeof data === "object" &&
            data !== null &&
            "error" in data &&
            typeof (data as { error?: unknown }).error === "string"
              ? (data as { error: string }).error
              : `Payment failed (${res.status})`;
          throw new Error(msg);
        }
        setToast({
          kind: "success",
          text: `Paid ${fmtUsd(invoice.amountDue)} for ${fmtMonth(invoice.month, invoice.year)} (${invoice.strategyTitle}).`,
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
    [loadAll, wallet],
  );

  const payInvoiceWithRazorpay = useCallback(
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
        const orderData: unknown = await orderRes.json().catch(() => ({}));
        if (!orderRes.ok) {
          const msg =
            typeof orderData === "object" &&
            orderData !== null &&
            "error" in orderData &&
            typeof (orderData as { error?: unknown }).error === "string"
              ? (orderData as { error: string }).error
              : `Could not create order (${orderRes.status})`;
          throw new Error(msg);
        }
        if (
          typeof orderData !== "object" ||
          orderData === null ||
          !("orderId" in orderData) ||
          !("keyId" in orderData) ||
          typeof (orderData as { orderId?: unknown }).orderId !== "string" ||
          typeof (orderData as { keyId?: unknown }).keyId !== "string"
        ) {
          throw new Error("Invalid order response from server");
        }
        const { orderId, keyId, amount, currency } = orderData as {
          orderId: string;
          keyId: string;
          amount: number;
          currency: string;
        };

        await new Promise<void>((resolve, reject) => {
          void openRazorpayCheckout({
            keyId,
            orderId,
            amountInr: amount,
            currency,
            name: COMPANY.legalName,
            description: `Revenue share — ${fmtMonth(invoice.month, invoice.year)} (${invoice.strategyTitle})`,
            onSuccess: async (rzpResponse) => {
              try {
                const verifyRes = await authFetch("/payments/verify", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(rzpResponse),
                });
                const verifyBody: unknown = await verifyRes.json().catch(() => ({}));
                if (!verifyRes.ok) {
                  const msg =
                    typeof verifyBody === "object" &&
                    verifyBody !== null &&
                    "error" in verifyBody &&
                    typeof (verifyBody as { error?: unknown }).error === "string"
                      ? (verifyBody as { error: string }).error
                      : `Verification failed (${verifyRes.status})`;
                  throw new Error(msg);
                }
                setToast({
                  kind: "success",
                  text: `Payment successful. Invoice for ${fmtMonth(invoice.month, invoice.year)} is now settled.`,
                });
                setRefreshing(true);
                await loadAll(true);
                resolve();
              } catch (e) {
                reject(e);
              }
            },
            onDismiss: () => reject(new Error("Payment cancelled")),
          }).catch(reject);
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Razorpay payment failed";
        if (msg !== "Payment cancelled") {
          setToast({ kind: "error", text: msg });
        }
      } finally {
        setRazorpayPayingId(null);
      }
    },
    [loadAll],
  );

  const pendingCount = useMemo(
    () => invoices.filter((i) => i.status === "PENDING" || i.status === "OVERDUE").length,
    [invoices],
  );

  if (unauthorized) {
    return (
      <div className="rounded-xl border border-amber-500/35 bg-amber-500/10 px-6 py-10 text-center">
        <p className="text-sm text-white/70">Sign in to view your billing dashboard.</p>
        <Link
          href="/login"
          className="mt-4 inline-flex rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-white hover:bg-primary/90"
        >
          Go to login
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="rounded-xl border border-glassBorder bg-primary/10 p-3">
            <CircleDollarSign className="h-6 w-6 text-primary" aria-hidden />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">
              Billing &amp; Revenue Share
            </h1>
            <p className="mt-1 text-sm text-white/55">
              High-water mark monthly revenue-share. Live month-to-date math,
              wallet balance, and historical invoices.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={refreshing || loading}
          className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-glassBorder bg-white/[0.03] px-4 py-2 text-sm font-medium text-white/80 transition hover:bg-white/[0.06] disabled:opacity-50"
        >
          <RefreshCw
            className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`}
            aria-hidden
          />
          Refresh
        </button>
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
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          )}
          <span>{toast.text}</span>
        </div>
      ) : null}

      {error ? (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="glass-card border border-glassBorder px-6 py-16 text-center">
          <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />
          <p className="mt-3 text-sm text-white/55">Loading billing data…</p>
        </div>
      ) : (
        <>
          <section className="grid gap-4 lg:grid-cols-2">
            {/* ---------- Live Cycle Card ---------- */}
            <article className="glass-card border border-glassBorder p-6">
              <div className="flex items-start justify-between gap-3">
                <p className="text-xs font-medium uppercase tracking-widest text-primary">
                  This month
                </p>
                <span className="group relative inline-flex">
                  <Info
                    className="h-4 w-4 cursor-help text-white/40"
                    aria-hidden
                  />
                  <span className="pointer-events-none absolute right-0 top-6 z-10 w-72 rounded-lg border border-glassBorder bg-background/95 p-3 text-xs leading-relaxed text-white/70 opacity-0 shadow-2xl backdrop-blur transition group-hover:opacity-100">
                    Dues are calculated on the 1st of the next month from your
                    cumulative monthly PnL and cannot drop below zero — losses
                    don&apos;t carry forward, and a losing month produces a $0
                    invoice.
                  </span>
                </span>
              </div>
              <h2 className="mt-2 text-lg font-semibold text-white">
                Live cumulative cycle
              </h2>

              <dl className="mt-6 grid gap-4 sm:grid-cols-2">
                <div>
                  <dt className="text-xs uppercase tracking-wider text-white/45">
                    Cumulative PnL
                  </dt>
                  <dd
                    className={`mt-1 text-2xl font-semibold tabular-nums ${pnlToneClass(liveCycle?.totals.cumulativePnl ?? null)}`}
                  >
                    {fmtSigned(liveCycle?.totals.cumulativePnl ?? 0)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wider text-white/45">
                    Est. revenue share due
                  </dt>
                  <dd className="mt-1 text-2xl font-semibold text-white tabular-nums">
                    {fmtUsd(liveCycle?.totals.estimatedDue ?? 0)}
                  </dd>
                </div>
              </dl>

              {liveCycle && liveCycle.byStrategy.length > 1 ? (
                <div className="mt-6 space-y-2 border-t border-white/[0.06] pt-4">
                  <p className="text-xs uppercase tracking-wider text-white/45">
                    By strategy
                  </p>
                  <ul className="space-y-1.5">
                    {liveCycle.byStrategy.map((s) => (
                      <li
                        key={s.strategyId}
                        className="flex items-center justify-between gap-3 text-sm"
                      >
                        <span className="truncate text-white/80">
                          {s.strategyTitle}
                        </span>
                        <span className="flex items-center gap-3 tabular-nums">
                          <span className={pnlToneClass(s.cumulativePnl)}>
                            {fmtSigned(s.cumulativePnl)}
                          </span>
                          <span className="text-white/55">
                            → {fmtUsd(s.estimatedDue)}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {!liveCycle || liveCycle.byStrategy.length === 0 ? (
                <p className="mt-6 text-xs text-white/45">
                  No active subscriptions. Subscribe to a strategy to start
                  accruing.
                </p>
              ) : null}
            </article>

            {/* ---------- Wallet Card ---------- */}
            <article className="glass-card border border-glassBorder p-6">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2">
                  <WalletIcon
                    className="h-4 w-4 text-primary"
                    aria-hidden
                  />
                  <p className="text-xs font-medium uppercase tracking-widest text-primary">
                    Wallet
                  </p>
                </div>
              </div>
              <h2 className="mt-2 text-lg font-semibold text-white">
                Available balance
              </h2>
              <p className="mt-6 text-3xl font-semibold text-white tabular-nums">
                {fmtUsd(wallet?.balance ?? 0)}
              </p>
              {wallet && wallet.pendingFees > 0 ? (
                <p className="mt-1 text-xs text-amber-200">
                  Pending fees: {fmtUsd(wallet.pendingFees)}
                </p>
              ) : null}

              <Link
                href="/dashboard/funds"
                className="mt-6 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition hover:bg-primary/90"
              >
                <Plus className="h-4 w-4" aria-hidden />
                Add funds
              </Link>

              <p className="mt-5 text-xs leading-relaxed text-white/55">
                Invoices are auto-deducted from your wallet balance on the 1st
                of every month. If your balance is insufficient, the invoice
                stays <span className="text-amber-200">PENDING</span> for 5
                days; after that, the strategy is paused until you settle it.
              </p>
            </article>
          </section>

          {/* ---------- Invoices Table ---------- */}
          <section className="glass-card border border-glassBorder overflow-hidden">
            <div className="flex items-center justify-between border-b border-glassBorder bg-white/[0.03] px-5 py-3">
              <div>
                <h2 className="text-sm font-semibold text-white">Invoices</h2>
                <p className="text-xs text-white/45">
                  {invoices.length === 0
                    ? "No invoices generated yet."
                    : pendingCount > 0
                      ? `${pendingCount} unpaid · ${invoices.length} total`
                      : `${invoices.length} total`}
                </p>
              </div>
            </div>

            <div className="scroll-table overflow-x-auto">
              <table className="w-full min-w-[920px] text-left text-sm">
                <thead className="border-b border-glassBorder bg-white/[0.02]">
                  <tr>
                    <th className="px-4 py-3 font-medium text-white/70">
                      Period
                    </th>
                    <th className="px-4 py-3 font-medium text-white/70">
                      Strategy
                    </th>
                    <th className="px-4 py-3 text-right font-medium text-white/70">
                      Total PnL
                    </th>
                    <th className="px-4 py-3 text-right font-medium text-white/70">
                      Amount
                    </th>
                    <th className="px-4 py-3 font-medium text-white/70">
                      Status
                    </th>
                    <th className="px-4 py-3 font-medium text-white/70">
                      Due
                    </th>
                    <th className="px-4 py-3 text-right font-medium text-white/70">
                      Action
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.length === 0 ? (
                    <tr>
                      <td
                        colSpan={7}
                        className="px-4 py-14 text-center text-white/55"
                      >
                        <p className="text-sm">No invoices yet.</p>
                        <p className="mt-1 text-xs text-white/40">
                          Your first invoice will be generated on the 1st of
                          next month.
                        </p>
                      </td>
                    </tr>
                  ) : (
                    invoices.map((inv) => {
                      const due = dueDateLabel(inv.dueDate, inv.status);
                      const isPayable =
                        inv.status === "PENDING" || inv.status === "OVERDUE";
                      const insufficient =
                        wallet !== null &&
                        wallet.balance + 1e-9 < inv.amountDue;
                      const isPaying = payingId === inv.id;
                      const isRazorpayPaying = razorpayPayingId === inv.id;
                      const estInr = Math.ceil(inv.amountDue * USD_INR_RATE);
                      return (
                        <tr
                          key={inv.id}
                          className="border-b border-white/[0.06] last:border-0 hover:bg-white/[0.02]"
                        >
                          <td className="whitespace-nowrap px-4 py-3 text-white/80">
                            {fmtMonth(inv.month, inv.year)}
                          </td>
                          <td className="max-w-[220px] truncate px-4 py-3 text-white/80">
                            <span title={inv.strategyTitle}>
                              {inv.strategyTitle}
                            </span>
                          </td>
                          <td
                            className={`px-4 py-3 text-right tabular-nums ${pnlToneClass(inv.totalPnl)}`}
                          >
                            {fmtSigned(inv.totalPnl)}
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums font-semibold text-white">
                            {fmtUsd(inv.amountDue)}
                          </td>
                          <td className="px-4 py-3">
                            <span
                              className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium uppercase tracking-wide ${statusBadgeClasses(inv.status)}`}
                            >
                              {inv.status}
                            </span>
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
                            {isPayable ? (
                              <div className="flex flex-col items-end gap-2">
                                <button
                                  type="button"
                                  onClick={() => {
                                    void payInvoiceWithRazorpay(inv);
                                  }}
                                  disabled={isRazorpayPaying || isPaying}
                                  className="inline-flex items-center gap-2 rounded-lg bg-cyan-600 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-white shadow-lg shadow-cyan-500/20 transition hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-50"
                                  title={`Pay via Razorpay (~₹${estInr.toLocaleString("en-IN")})`}
                                >
                                  {isRazorpayPaying ? (
                                    <>
                                      <Loader2
                                        className="h-3.5 w-3.5 animate-spin"
                                        aria-hidden
                                      />
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
                                  onClick={() => {
                                    void payInvoice(inv);
                                  }}
                                  disabled={isPaying || isRazorpayPaying || insufficient}
                                  className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[10px] font-medium uppercase tracking-wide transition disabled:cursor-not-allowed disabled:opacity-50 ${
                                    insufficient
                                      ? "text-white/35"
                                      : "text-white/55 hover:text-white/80"
                                  }`}
                                  title={
                                    insufficient
                                      ? "Insufficient wallet balance"
                                      : `Pay ${fmtUsd(inv.amountDue)} from wallet`
                                  }
                                >
                                  {isPaying ? "Wallet…" : "Use wallet"}
                                </button>
                              </div>
                            ) : (
                              <span className="text-xs text-white/40">
                                {inv.status === "PAID" ? "Settled" : "—"}
                              </span>
                            )}
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
