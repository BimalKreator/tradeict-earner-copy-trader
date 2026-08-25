"use client";

import { resolveApiBase } from "@/lib/apiBase";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertCircle,
  CheckCircle2,
  CircleDollarSign,
  Loader2,
  Plus,
  RefreshCw,
} from "lucide-react";
import { RevenueInvoiceTable } from "@/components/billing/RevenueInvoiceTable";
import { MoneyDisplay, MoneyDisplayCompact } from "@/components/money/MoneyDisplay";
import {
  DetailRow,
  MoneyRowCard,
  ResponsiveMoneyTable,
} from "@/components/money/MoneyRowCard";
import type { RevenueInvoiceRow } from "@/lib/revenueInvoiceTypes";
import {
  fmtWalletBalance,
  fmtUsd,
  formatINR,
  formatINRApprox,
  RATE_MISSING_MESSAGE,
  resolveUsdInrRate,
  mapPaymentStatus,
  usdToInr,
} from "@/lib/currency";
import { formatIstDateTime } from "@/lib/istDates";

type WalletResponse = {
  exists: boolean;
  balance: number;
  balanceUsd?: number;
  balanceInr?: number | null;
  availableBalance?: number;
  lockedBalance?: number;
  usdInrRate?: number | null;
  usdInrRateUpdatedAt?: string | null;
  pendingFees: number;
  overdueDays: number;
};

type PaymentHistoryRow = {
  id: string;
  date: string;
  method: string;
  amount: number;
  fee: number;
  netCredit: number;
  totalInr: number;
  status: string;
  referenceId: string | null;
};

type LedgerTransactionRow = {
  id: string;
  date: string;
  amount: number;
  type: string;
  status: string;
  utrNumber: string | null;
  note: string | null;
};

type HistoryRow = {
  id: string;
  date: string;
  description: string;
  amountUsd: number;
  inr: number | null;
  status: string;
  ledgerType?: string;
};

type Toast = { kind: "success" | "error"; text: string } | null;

function ledgerDescription(tx: LedgerTransactionRow): string {
  switch (tx.type) {
    case "WITHDRAWAL_REQUEST":
      return "Wallet withdrawal request";
    case "ADMIN_ADJUSTMENT":
      return tx.note?.trim() || "Admin wallet adjustment";
    case "PAYMENT":
      return tx.utrNumber?.trim()
        ? `Deposit request · UTR ${tx.utrNumber.trim()}`
        : "Deposit request";
    case "FEE":
      return "Platform fee";
    default:
      return tx.type.replace(/_/g, " ").toLowerCase();
  }
}

function ledgerAmountUsd(tx: LedgerTransactionRow): number {
  if (tx.type === "WITHDRAWAL_REQUEST") return -tx.amount;
  if (tx.type === "ADMIN_ADJUSTMENT") {
    if (tx.note?.trim().toUpperCase().startsWith("REMOVE:")) return -tx.amount;
    return tx.amount;
  }
  return tx.amount;
}

function paymentStatusBadge(status: string): string {
  const mapped = mapPaymentStatus(status);
  switch (mapped) {
    case "PAID":
      return "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30";
    case "FAILED":
      return "bg-red-500/15 text-red-300 ring-1 ring-red-500/30";
    default:
      return "bg-amber-500/15 text-amber-200 ring-1 ring-amber-500/30";
  }
}

function historyStatusLabel(status: string, ledgerType?: string): string {
  if (ledgerType === "WITHDRAWAL_REQUEST") {
    const s = status.toUpperCase();
    if (s === "COMPLETED" || s === "REJECTED" || s === "PENDING") return s;
    return status;
  }
  return mapPaymentStatus(status);
}

function historyStatusBadge(status: string, ledgerType?: string): string {
  if (ledgerType === "WITHDRAWAL_REQUEST") {
    switch (status.toUpperCase()) {
      case "COMPLETED":
        return "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30";
      case "REJECTED":
        return "bg-red-500/15 text-red-300 ring-1 ring-red-500/30";
      case "PENDING":
      default:
        return "bg-amber-500/15 text-amber-200 ring-1 ring-amber-500/30";
    }
  }
  return paymentStatusBadge(status);
}

function mergeTransactionHistory(
  payments: PaymentHistoryRow[],
  ledger: LedgerTransactionRow[],
  rate: number | null,
): HistoryRow[] {
  const paymentRows: HistoryRow[] = payments.map((tx) => {
    const usd = tx.netCredit;
    const converted = usdToInr(usd, rate);
    const inr = tx.amount > 0 ? tx.amount : converted;
    const label = `${tx.method} · ${tx.referenceId ? `Ref ${tx.referenceId}` : "Wallet top-up"}`;
    return {
      id: `payment-${tx.id}`,
      date: tx.date,
      description: label,
      amountUsd: usd,
      inr,
      status: tx.status,
    };
  });

  const ledgerRows: HistoryRow[] = ledger.map((tx) => ({
    id: `ledger-${tx.id}`,
    date: tx.date,
    description: ledgerDescription(tx),
    amountUsd: ledgerAmountUsd(tx),
    inr: usdToInr(Math.abs(tx.amount), rate),
    status: tx.status,
    ledgerType: tx.type,
  }));

  return [...paymentRows, ...ledgerRows].sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
  );
}

async function authFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
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

export default function DashboardWalletPage() {
  const [wallet, setWallet] = useState<WalletResponse | null>(null);
  const [paymentHistory, setPaymentHistory] = useState<PaymentHistoryRow[]>([]);
  const [ledgerTransactions, setLedgerTransactions] = useState<LedgerTransactionRow[]>([]);
  const [revenueInvoices, setRevenueInvoices] = useState<RevenueInvoiceRow[]>([]);
  const [platformRate, setPlatformRate] = useState<number | null>(null);
  const [rateUpdatedAt, setRateUpdatedAt] = useState<string | null>(null);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);
  const [toast, setToast] = useState<Toast>(null);

  const loadAll = useCallback(async (silent: boolean) => {
    try {
      const [walletRes, invoiceRes, historyRes, ledgerRes] = await Promise.all([
        authFetch("/wallet/me"),
        authFetch("/me/revenue/invoices"),
        authFetch("/payments/history"),
        authFetch("/user/transactions"),
      ]);

      if (
        walletRes.status === 401 ||
        invoiceRes.status === 401 ||
        historyRes.status === 401 ||
        ledgerRes.status === 401
      ) {
        if (!silent) {
          setUnauthorized(true);
          setWallet(null);
          setPaymentHistory([]);
          setLedgerTransactions([]);
          setRevenueInvoices([]);
        }
        return;
      }

      if (!walletRes.ok || !invoiceRes.ok || !historyRes.ok || !ledgerRes.ok) {
        const codes = [
          walletRes.status,
          invoiceRes.status,
          historyRes.status,
          ledgerRes.status,
        ]
          .filter((c) => c >= 400)
          .join("/");
        throw new Error(`Request failed (${codes})`);
      }

      const w = (await walletRes.json()) as WalletResponse;
      const inv = (await invoiceRes.json()) as { invoices?: RevenueInvoiceRow[] };
      const hist = (await historyRes.json()) as {
        transactions?: PaymentHistoryRow[];
        usdInrRate?: number;
      };
      const ledger = (await ledgerRes.json()) as {
        transactions?: LedgerTransactionRow[];
      };

      setWallet(w);
      setPlatformRate(resolveUsdInrRate(w.usdInrRate ?? hist.usdInrRate));
      setRateUpdatedAt(w.usdInrRateUpdatedAt ?? null);
      setPaymentHistory(
        Array.isArray(hist.transactions) ? hist.transactions : [],
      );
      setLedgerTransactions(
        Array.isArray(ledger.transactions) ? ledger.transactions : [],
      );
      setRevenueInvoices(Array.isArray(inv.invoices) ? inv.invoices : []);
      if (!silent) {
        setError(null);
        setUnauthorized(false);
      }
    } catch (e) {
      if (!silent) {
        setError(e instanceof Error ? e.message : "Failed to load wallet data");
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

  const balanceUsd =
    wallet?.availableBalance ?? wallet?.balanceUsd ?? wallet?.balance ?? 0;

  const usdInrRate = resolveUsdInrRate(platformRate ?? wallet?.usdInrRate);

  const transactionHistory = useMemo(
    () => mergeTransactionHistory(paymentHistory, ledgerTransactions, usdInrRate),
    [ledgerTransactions, paymentHistory, usdInrRate],
  );

  if (unauthorized) {
    return (
      <div className="rounded-xl border border-amber-500/35 bg-amber-500/10 px-6 py-10 text-center">
        <p className="text-sm text-white/70">Sign in to view your wallet.</p>
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
              Wallet
            </h1>
            <p className="mt-1 text-sm text-white/55">
              Balances in USD and INR, transaction history, and revenue-share invoices.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center rounded-full border border-cyan-500/35 bg-cyan-500/10 px-3 py-1.5 text-xs font-medium text-cyan-200">
            {usdInrRate != null
              ? `1 USD = ${usdInrRate.toLocaleString("en-IN")} INR`
              : RATE_MISSING_MESSAGE}
          </span>
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
          <p className="mt-3 text-sm text-white/55">Loading wallet…</p>
        </div>
      ) : (
        <>
          <section className="grid gap-4 sm:grid-cols-2">
            <article className="glass-card border border-glassBorder p-6 sm:col-span-2 lg:col-span-1">
              <p className="text-xs font-medium uppercase tracking-widest text-primary">
                Available balance
              </p>
              <p className="mt-4 text-4xl font-bold tabular-nums text-white">
                {fmtWalletBalance(balanceUsd)}
              </p>
              <p className="mt-1 text-sm tabular-nums text-white/50">
                {formatINRApprox(balanceUsd, usdInrRate)}
              </p>
              {wallet && wallet.pendingFees > 0 ? (
                <p className="mt-3 text-xs text-amber-200">
                  Pending fees: {fmtUsd(wallet.pendingFees)} (
                  {formatINR(wallet.pendingFees, usdInrRate)})
                </p>
              ) : null}
              <Link
                href="/dashboard/payments"
                className="mt-6 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition hover:bg-primary/90"
              >
                <Plus className="h-4 w-4" aria-hidden />
                Add funds
              </Link>
            </article>
            <article className="glass-card border border-glassBorder p-6 sm:col-span-2 lg:col-span-1">
              <p className="text-xs font-medium uppercase tracking-widest text-primary">
                Exchange rate
              </p>
              <p className="mt-4 text-2xl font-semibold text-white tabular-nums">
                {usdInrRate != null
                  ? `1 USD = ${usdInrRate.toLocaleString("en-IN")} INR`
                  : "—"}
              </p>
              <p className="mt-3 text-sm text-white/55">
                {usdInrRate != null
                  ? `Platform USD/INR rate set by Tradeict${
                      rateUpdatedAt
                        ? ` on ${new Date(rateUpdatedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`
                        : ""
                    }. Each invoice is charged at the rate pinned on that invoice when it was issued.`
                  : RATE_MISSING_MESSAGE}
              </p>
            </article>
          </section>

          <section className="glass-card border border-glassBorder overflow-hidden">
            <div className="border-b border-glassBorder bg-white/[0.03] px-5 py-3">
              <h2 className="text-sm font-semibold text-white">Transactions</h2>
              <p className="text-xs text-white/45">
                Deposits, withdrawals, and payments — USD with INR equivalent
              </p>
            </div>
            <ResponsiveMoneyTable
              table={
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-glassBorder bg-white/[0.02]">
                    <tr>
                      <th className="px-4 py-3 font-medium text-white/70">Date &amp; time</th>
                      <th className="px-4 py-3 font-medium text-white/70">Description</th>
                      <th className="px-4 py-3 text-right font-medium text-white/70">Amount</th>
                      <th className="px-4 py-3 font-medium text-white/70">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {transactionHistory.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="px-4 py-14 text-center text-white/55">
                          No transactions yet.{" "}
                          <Link href="/dashboard/payments" className="text-cyan-400 hover:underline">
                            Add funds
                          </Link>
                        </td>
                      </tr>
                    ) : (
                      transactionHistory.map((tx) => {
                        const displayStatus = historyStatusLabel(tx.status, tx.ledgerType);
                        return (
                          <tr
                            key={tx.id}
                            className="border-b border-white/[0.06] last:border-0 hover:bg-white/[0.02]"
                          >
                            <td className="whitespace-nowrap px-4 py-3 tabular-nums text-white/70">
                              {formatIstDateTime(tx.date)}
                            </td>
                            <td
                              className="max-w-[240px] truncate px-4 py-3 text-white/85"
                              title={tx.description}
                            >
                              {tx.description}
                            </td>
                            <td className="px-4 py-3 text-right">
                              <MoneyDisplay usd={tx.amountUsd} rate={usdInrRate} align="right" />
                            </td>
                            <td className="px-4 py-3">
                              <span
                                className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium uppercase ${historyStatusBadge(tx.status, tx.ledgerType)}`}
                              >
                                {displayStatus}
                              </span>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              }
              cards={
                transactionHistory.length === 0 ? (
                  <div className="px-4 py-14 text-center text-white/55">
                    No transactions yet.{" "}
                    <Link href="/dashboard/payments" className="text-cyan-400 hover:underline">
                      Add funds
                    </Link>
                  </div>
                ) : (
                  transactionHistory.map((tx) => {
                    const displayStatus = historyStatusLabel(tx.status, tx.ledgerType);
                    return (
                      <MoneyRowCard
                        key={tx.id}
                        primary={tx.description}
                        secondary={
                          <span className="tabular-nums">{formatIstDateTime(tx.date)}</span>
                        }
                        amount={
                          <MoneyDisplayCompact usd={tx.amountUsd} rate={usdInrRate} />
                        }
                        status={
                          <span
                            className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium uppercase ${historyStatusBadge(tx.status, tx.ledgerType)}`}
                          >
                            {displayStatus}
                          </span>
                        }
                        details={
                          <MoneyDisplay usd={tx.amountUsd} rate={usdInrRate} align="right" />
                        }
                      />
                    );
                  })
                )
              }
            />
          </section>

          <RevenueInvoiceTable
            invoices={revenueInvoices}
            loading={loading}
            walletBalance={balanceUsd}
            onPaid={() => {
              setRefreshing(true);
              void loadAll(true);
            }}
          />
        </>
      )}
    </div>
  );
}
