"use client";

import { useCallback, useEffect, useState } from "react";
import { GitCompare, Loader2, RefreshCw } from "lucide-react";
import Link from "next/link";

const API_BASE = process.env.NEXT_PUBLIC_API_URL;

type ArbitrageTradeRow = {
  id: string;
  token: string;
  qty: number;
  buyPrice: number;
  sellPrice: number;
  buyDex: string;
  sellDex: string;
  feePercent: number;
  feeAmount: number;
  netProfit: number;
  createdAt: string;
};

type ArbitrageTradesResponse = {
  totalEarnings: number;
  baseCapital?: number;
  trades: ArbitrageTradeRow[];
};

type ArbitrageWithdrawalRow = {
  id: string;
  amount: number;
  date: string;
  createdAt: string;
};

type ArbitrageWithdrawalsResponse = {
  baseCapital?: number;
  withdrawals: ArbitrageWithdrawalRow[];
};

const usdFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
});

const usdPnlFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  signDisplay: "always",
});

const usdBalanceFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const pctFmt = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const dateFmt = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return usdFmt.format(n);
}

function fmtPnl(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return usdPnlFmt.format(n);
}

function fmtBalance(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return usdBalanceFmt.format(n);
}

function fmtDate(iso: string): string {
  try {
    return dateFmt.format(new Date(iso));
  } catch {
    return iso;
  }
}

function fmtDateShort(iso: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function pnlClass(n: number): string {
  if (n > 0) return "text-emerald-400";
  if (n < 0) return "text-red-400";
  return "text-white/60";
}

export default function ArbitrageTradesPage() {
  const [rows, setRows] = useState<ArbitrageTradeRow[]>([]);
  const [grossEarnings, setGrossEarnings] = useState(0);
  const [baseCapital, setBaseCapital] = useState(0);
  const [withdrawals, setWithdrawals] = useState<ArbitrageWithdrawalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);

  const totalWithdrawn = withdrawals.reduce(
    (sum, w) => sum + (Number.isFinite(w.amount) ? w.amount : 0),
    0,
  );
  const netEarnings = grossEarnings - totalWithdrawn;
  const currentCapital = baseCapital + netEarnings;

  const load = useCallback(async (silent: boolean) => {
    try {
      const token =
        typeof window !== "undefined" ? localStorage.getItem("token") : null;
      const headers = { Authorization: `Bearer ${token ?? ""}` };

      const [tradesRes, withdrawalsRes] = await Promise.all([
        fetch(`${API_BASE}/user/arbitrage-trades?limit=500`, {
          cache: "no-store",
          headers,
        }),
        fetch(`${API_BASE}/user/arbitrage-withdrawals`, {
          cache: "no-store",
          headers,
        }),
      ]);

      if (tradesRes.status === 401 || withdrawalsRes.status === 401) {
        if (!silent) {
          setUnauthorized(true);
          setRows([]);
          setWithdrawals([]);
        }
        return;
      }
      if (!tradesRes.ok) throw new Error(`Trades request failed (${tradesRes.status})`);

      const data = (await tradesRes.json()) as ArbitrageTradesResponse;
      setRows(data.trades ?? []);
      setGrossEarnings(
        typeof data.totalEarnings === "number" && Number.isFinite(data.totalEarnings)
          ? data.totalEarnings
          : 0,
      );
      setBaseCapital(
        typeof data.baseCapital === "number" && Number.isFinite(data.baseCapital)
          ? data.baseCapital
          : 0,
      );

      if (withdrawalsRes.ok) {
        const wd = (await withdrawalsRes.json()) as ArbitrageWithdrawalsResponse;
        setWithdrawals(
          Array.isArray(wd.withdrawals) ? wd.withdrawals : [],
        );
        if (
          (typeof data.baseCapital !== "number" || !Number.isFinite(data.baseCapital)) &&
          typeof wd.baseCapital === "number" &&
          Number.isFinite(wd.baseCapital)
        ) {
          setBaseCapital(wd.baseCapital);
        }
      } else {
        setWithdrawals([]);
      }

      if (!silent) {
        setError(null);
        setUnauthorized(false);
      }
    } catch (e) {
      if (!silent) {
        setError(e instanceof Error ? e.message : "Failed to load arbitrage trades");
      }
    } finally {
      if (silent) setRefreshing(false);
      else setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  if (unauthorized) {
    return (
      <div className="rounded-xl border border-amber-500/35 bg-amber-500/10 px-6 py-10 text-center">
        <p className="text-sm text-white/70">Sign in to view your arbitrage trades.</p>
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
          <div className="rounded-xl border border-glassBorder bg-teal-500/10 p-3">
            <GitCompare className="h-6 w-6 text-teal-400" aria-hidden />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">
              Arbitrage Trades
            </h1>
            <p className="mt-1 text-sm text-white/55">
              Cross-DEX arbitrage executions and earnings on your account.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            setRefreshing(true);
            void load(true);
          }}
          disabled={loading || refreshing}
          className="inline-flex items-center gap-2 rounded-lg border border-glassBorder bg-white/[0.03] px-4 py-2 text-sm text-white/80 hover:bg-white/10 disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </header>

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      <div className="rounded-xl border border-teal-500/30 bg-gradient-to-br from-teal-500/10 to-slate-900/80 p-6 shadow-lg shadow-black/20">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium uppercase tracking-wider text-teal-300/80">
              Total Arbitrage Earnings
            </p>
            <p
              className={`mt-2 text-3xl font-semibold tabular-nums md:text-4xl ${pnlClass(netEarnings)}`}
            >
              {loading ? "—" : fmtPnl(netEarnings)}
            </p>
            <p className="mt-2 text-sm text-white/50">
              Cumulative net profit from trades minus recorded withdrawals.
            </p>
          </div>
          <div className="shrink-0 sm:text-right">
            <p className="text-xs font-medium uppercase tracking-wider text-teal-300/80">
              Current Capital
            </p>
            <p
              className={`mt-2 text-3xl font-semibold tabular-nums md:text-4xl ${pnlClass(currentCapital)}`}
            >
              {loading ? "—" : fmtBalance(currentCapital)}
            </p>
            <p className="mt-2 text-sm text-white/50">
              Base capital plus net trade earnings
            </p>
          </div>
        </div>
        {!loading && (grossEarnings !== 0 || totalWithdrawn !== 0 || baseCapital !== 0) ? (
          <dl className="mt-4 grid gap-2 border-t border-white/10 pt-4 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-white/45">Base capital</dt>
              <dd className="mt-0.5 font-medium tabular-nums text-white">
                {fmtBalance(baseCapital)}
              </dd>
            </div>
            <div>
              <dt className="text-white/45">Gross trade profit</dt>
              <dd className={`mt-0.5 font-medium tabular-nums ${pnlClass(grossEarnings)}`}>
                {fmtPnl(grossEarnings)}
              </dd>
            </div>
            <div>
              <dt className="text-white/45">Total withdrawn</dt>
              <dd className="mt-0.5 font-medium tabular-nums text-amber-300/90">
                −{fmtUsd(totalWithdrawn)}
              </dd>
            </div>
          </dl>
        ) : null}
      </div>

      <div className="overflow-hidden rounded-xl border border-glassBorder bg-white/[0.02] shadow-lg shadow-black/20">
        <div className="border-b border-glassBorder bg-black/25 px-4 py-3">
          <h2 className="text-sm font-semibold text-white">Withdrawal history</h2>
          <p className="mt-0.5 text-xs text-white/45">
            Withdrawals recorded on your account by an administrator.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[320px] text-left text-sm">
            <thead className="border-b border-glassBorder bg-black/20">
              <tr>
                <th className="px-4 py-3 text-xs font-medium uppercase tracking-wider text-white/45">
                  Date
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-white/45">
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={2} className="px-4 py-10 text-center">
                    <Loader2 className="mx-auto h-6 w-6 animate-spin text-teal-400" />
                  </td>
                </tr>
              ) : withdrawals.length === 0 ? (
                <tr>
                  <td colSpan={2} className="px-4 py-10 text-center text-white/50">
                    No withdrawals recorded yet.
                  </td>
                </tr>
              ) : (
                withdrawals.map((w) => (
                  <tr
                    key={w.id}
                    className="border-b border-glassBorder/60 last:border-0 hover:bg-white/[0.03]"
                  >
                    <td className="px-4 py-3 text-white/80">{fmtDateShort(w.date)}</td>
                    <td className="px-4 py-3 text-right font-medium tabular-nums text-amber-300">
                      {fmtUsd(w.amount)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-glassBorder bg-white/[0.02] shadow-lg shadow-black/20">
        <div className="border-b border-glassBorder bg-black/25 px-4 py-3">
          <h2 className="text-sm font-semibold text-white">Trade history</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1000px] text-left text-sm">
            <thead className="border-b border-glassBorder bg-black/30">
              <tr>
                <th className="px-4 py-3 text-xs font-medium uppercase tracking-wider text-white/45">
                  Token
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-white/45">
                  Qty
                </th>
                <th className="px-4 py-3 text-xs font-medium uppercase tracking-wider text-white/45">
                  Buy
                </th>
                <th className="px-4 py-3 text-xs font-medium uppercase tracking-wider text-white/45">
                  Sell
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-white/45">
                  Fees Charged
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-white/45">
                  Net Profit
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-white/45">
                  Time
                </th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-16 text-center">
                    <Loader2 className="mx-auto h-8 w-8 animate-spin text-teal-400" />
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-16 text-center text-white/50">
                    No arbitrage trades yet. Trades appear here when your account executes
                    opportunities from the scanner.
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr
                    key={r.id}
                    className="border-b border-glassBorder/60 hover:bg-white/[0.03]"
                  >
                    <td className="px-4 py-3 font-medium text-white">{r.token}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-white/80">
                      {r.qty.toFixed(6)}
                    </td>
                    <td className="px-4 py-3">
                      <p className="tabular-nums text-emerald-400">{fmtUsd(r.buyPrice)}</p>
                      <p className="text-xs text-white/45">{r.buyDex}</p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="tabular-nums text-amber-300">{fmtUsd(r.sellPrice)}</p>
                      <p className="text-xs text-white/45">{r.sellDex}</p>
                    </td>
                    <td className="px-4 py-3 text-right text-white/70">
                      <span className="tabular-nums">{fmtUsd(r.feeAmount)}</span>
                      <span className="block text-xs text-white/40">
                        {pctFmt.format(r.feePercent)}%
                      </span>
                    </td>
                    <td className={`px-4 py-3 text-right font-medium tabular-nums ${pnlClass(r.netProfit)}`}>
                      {fmtPnl(r.netProfit)}
                    </td>
                    <td className="px-4 py-3 text-right text-white/55">{fmtDate(r.createdAt)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
