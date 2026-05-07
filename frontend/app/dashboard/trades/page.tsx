"use client";

import { useCallback, useEffect, useState } from "react";
import { History, Loader2, RefreshCw } from "lucide-react";
import Link from "next/link";

const API_BASE = process.env.NEXT_PUBLIC_API_URL;

type TradeRow = {
  id: string;
  createdAt: string;
  strategyId: string;
  strategyTitle: string;
  symbol: string;
  side: string;
  size: number;
  entryPrice: number;
  exitPrice: number | null;
  pnl: number | null;
  tradePnl: number;
  tradingFee: number;
  revenueShareAmt: number;
  status: "OPEN" | "CLOSED" | "FAILED";
};

const usdPriceFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 6,
});

const usdPnlFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  signDisplay: "always",
});

const usdFeeFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
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

function fmtPrice(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return usdPriceFmt.format(n);
}

function fmtPnl(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return usdPnlFmt.format(n);
}

function fmtFee(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return usdFeeFmt.format(n);
}

function fmtDate(iso: string): string {
  try {
    return dateFmt.format(new Date(iso));
  } catch {
    return iso;
  }
}

/** Prefer the engine's `tradePnl`; fall back to legacy `pnl` for older rows. */
function realizedPnl(row: TradeRow): number | null {
  if (Number.isFinite(row.tradePnl) && row.tradePnl !== 0) return row.tradePnl;
  if (row.pnl !== null && Number.isFinite(row.pnl)) return row.pnl;
  return null;
}

function pnlToneClass(n: number | null): string {
  if (n === null) return "text-white/60";
  if (n > 0) return "text-emerald-400";
  if (n < 0) return "text-red-300";
  return "text-white/60";
}

function sideToneClass(side: string): string {
  const s = side.toUpperCase();
  if (s === "BUY" || s === "LONG") return "bg-emerald-500/15 text-emerald-300";
  if (s === "SELL" || s === "SHORT") return "bg-red-500/15 text-red-300";
  return "bg-white/10 text-white/70";
}

export default function DashboardTradesPage() {
  const [rows, setRows] = useState<TradeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [downloading, setDownloading] = useState(false);

  const load = useCallback(async (silent: boolean) => {
    // No synchronous setState before the first await — that would trip
    // `react-hooks/set-state-in-effect` when called from useEffect.
    try {
      const token =
        typeof window !== "undefined" ? localStorage.getItem("token") : null;
      const res = await fetch(`${API_BASE}/user/trades?limit=200`, {
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${token ?? ""}`,
        },
      });
      if (res.status === 401) {
        if (!silent) {
          setUnauthorized(true);
          setRows([]);
        }
        return;
      }
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const data: unknown = await res.json();
      const list =
        typeof data === "object" &&
        data !== null &&
        "trades" in data &&
        Array.isArray((data as { trades: unknown }).trades)
          ? ((data as { trades: TradeRow[] }).trades)
          : [];
      setRows(list);
      if (!silent) {
        setError(null);
        setUnauthorized(false);
      }
    } catch (e) {
      if (!silent) {
        setError(e instanceof Error ? e.message : "Failed to load trades");
      }
    } finally {
      if (silent) setRefreshing(false);
      else setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Initial data fetch on mount. setState inside `load` is gated behind
    // an `await`, so it never runs synchronously from this effect body.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- on-mount fetch is a legitimate effect side-effect
    void load(false);
  }, [load]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    void load(true);
  }, [load]);

  const handleDownloadHistory = useCallback(async () => {
    const token =
      typeof window !== "undefined" ? localStorage.getItem("token") : null;
    if (!token) {
      setError("Please sign in to download trade history.");
      return;
    }
    setDownloading(true);
    setError(null);
    setSuccess(null);
    try {
      const qs = new URLSearchParams();
      if (fromDate) qs.set("startDate", fromDate);
      if (toDate) qs.set("endDate", toDate);
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      const res = await fetch(`${API_BASE}/user/trades/export${suffix}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        throw new Error(`Download failed (${res.status})`);
      }
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `trade_history_${Date.now()}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      setSuccess("Trade history downloaded successfully.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to download trade history.");
    } finally {
      setDownloading(false);
    }
  }, [fromDate, toDate]);

  const totalPnl = rows.reduce((acc, r) => {
    const v = realizedPnl(r);
    return acc + (v ?? 0);
  }, 0);
  const totalTradingFee = rows.reduce(
    (acc, r) => acc + (Number.isFinite(r.tradingFee) ? r.tradingFee : 0),
    0,
  );
  const totalRevenueShare = rows.reduce(
    (acc, r) =>
      acc + (Number.isFinite(r.revenueShareAmt) ? r.revenueShareAmt : 0),
    0,
  );

  if (unauthorized) {
    return (
      <div className="rounded-xl border border-amber-500/35 bg-amber-500/10 px-6 py-10 text-center">
        <p className="text-sm text-white/70">Sign in to view your trades.</p>
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
            <History className="h-6 w-6 text-primary" aria-hidden />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">
              Trade history
            </h1>
            <p className="mt-1 text-sm text-white/55">
              Every position the trade engine has copied to your account, with
              realized PnL and the per-trade revenue-share fee.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-white/55">
            From Date
            <input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="mt-1 block rounded-lg border border-glassBorder bg-white/[0.03] px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40"
            />
          </label>
          <label className="text-xs text-white/55">
            To Date
            <input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="mt-1 block rounded-lg border border-glassBorder bg-white/[0.03] px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40"
            />
          </label>
          <button
            type="button"
            onClick={() => void handleDownloadHistory()}
            disabled={downloading}
            className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-cyan-500/45 bg-cyan-500/15 px-4 py-2 text-sm font-medium text-cyan-100 transition hover:bg-cyan-500/25 disabled:opacity-50"
          >
            {downloading ? "Downloading..." : "Download History"}
          </button>
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

      {!loading && rows.length > 0 ? (
        <section className="grid gap-4 sm:grid-cols-4">
          <div className="glass-card border border-glassBorder p-5">
            <p className="text-xs font-medium uppercase tracking-wider text-white/50">
              Trades
            </p>
            <p className="mt-2 text-2xl font-semibold text-white tabular-nums">
              {rows.length}
            </p>
          </div>
          <div className="glass-card border border-glassBorder p-5">
            <p className="text-xs font-medium uppercase tracking-wider text-white/50">
              Net PnL
            </p>
            <p
              className={`mt-2 text-2xl font-semibold tabular-nums ${pnlToneClass(totalPnl)}`}
            >
              {fmtPnl(totalPnl)}
            </p>
          </div>
          <div className="glass-card border border-glassBorder p-5">
            <p className="text-xs font-medium uppercase tracking-wider text-white/50">
              Total Trading Fees
            </p>
            <p className="mt-2 text-2xl font-semibold text-white/90 tabular-nums">
              {fmtFee(totalTradingFee)}
            </p>
          </div>
          <div className="glass-card border border-glassBorder p-5">
            <p className="text-xs font-medium uppercase tracking-wider text-white/50">
              Revenue Share
            </p>
            <p className="mt-2 text-2xl font-semibold text-white/90 tabular-nums">
              {fmtFee(totalRevenueShare)}
            </p>
          </div>
        </section>
      ) : null}

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}
      {success && (
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
          {success}
        </div>
      )}

      <section className="glass-card border border-glassBorder overflow-hidden">
        <div className="scroll-table overflow-x-auto">
          <table className="w-full min-w-[1060px] text-left text-sm">
            <thead className="border-b border-glassBorder bg-white/[0.03]">
              <tr>
                <th className="px-4 py-3 font-medium text-white/70">Date</th>
                <th className="px-4 py-3 font-medium text-white/70">
                  Strategy
                </th>
                <th className="px-4 py-3 font-medium text-white/70">Symbol</th>
                <th className="px-4 py-3 font-medium text-white/70">Side</th>
                <th className="px-4 py-3 font-medium text-white/70">
                  Entry price
                </th>
                <th className="px-4 py-3 font-medium text-white/70">
                  Exit price
                </th>
                <th className="px-4 py-3 text-right font-medium text-white/70">
                  Net PnL
                </th>
                <th className="px-4 py-3 text-right font-medium text-white/70">
                  Trading Fee
                </th>
                <th className="px-4 py-3 text-right font-medium text-white/70">
                  Revenue Share
                </th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={9} className="px-4 py-14 text-center">
                    <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={9}
                    className="px-4 py-16 text-center text-white/55"
                  >
                    <p className="text-sm">No trades executed yet.</p>
                    <p className="mt-1 text-xs text-white/40">
                      Once you subscribe to a strategy and the trade engine
                      mirrors a master entry, it will appear here.
                    </p>
                    <Link
                      href="/dashboard/strategies"
                      className="mt-4 inline-flex rounded-lg bg-primary px-4 py-2 text-xs font-medium text-white hover:bg-primary/90"
                    >
                      Browse strategies
                    </Link>
                  </td>
                </tr>
              ) : (
                rows.map((r) => {
                  const realized = realizedPnl(r);
                  const isOpen = r.status === "OPEN";
                  return (
                    <tr
                      key={r.id}
                      className="border-b border-white/[0.06] last:border-0 hover:bg-white/[0.02]"
                    >
                      <td className="whitespace-nowrap px-4 py-3 tabular-nums text-white/55">
                        {fmtDate(r.createdAt)}
                      </td>
                      <td className="max-w-[220px] truncate px-4 py-3 text-white/85">
                        <span title={r.strategyTitle}>{r.strategyTitle}</span>
                      </td>
                      <td className="px-4 py-3 font-medium text-white">
                        {r.symbol}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium uppercase tracking-wide ${sideToneClass(r.side)}`}
                        >
                          {r.side}
                        </span>
                      </td>
                      <td className="px-4 py-3 tabular-nums text-white/80">
                        {fmtPrice(r.entryPrice)}
                      </td>
                      <td className="px-4 py-3 tabular-nums text-white/80">
                        {isOpen ? (
                          <span className="text-white/40">open</span>
                        ) : (
                          fmtPrice(r.exitPrice)
                        )}
                      </td>
                      <td
                        className={`px-4 py-3 text-right tabular-nums font-semibold ${pnlToneClass(realized)}`}
                      >
                        {isOpen && realized === null ? (
                          <span className="text-white/40">—</span>
                        ) : (
                          fmtPnl(realized)
                        )}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-white/85">
                        {fmtFee(r.tradingFee)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-white/85">
                        {fmtFee(r.revenueShareAmt)}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      {!loading && rows.length > 0 ? (
        <p className="text-xs text-white/40">
          Showing {rows.length} most recent trade{rows.length === 1 ? "" : "s"}.
        </p>
      ) : null}
    </div>
  );
}
