"use client";

import { useCallback, useEffect, useState } from "react";
import { Activity, Loader2 } from "lucide-react";
import Link from "next/link";

const API_BASE = process.env.NEXT_PUBLIC_API_URL;

type LiveRow = {
  strategyId: string;
  strategyTitle: string;
  entryTime: string | null;
  token: string;
  entryPrice: number | null;
  stopLoss: number | null;
  target: number | null;
  livePnl: number | null;
  markPrice: number | null;
  side: string;
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

function fmtPrice(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return usdPriceFmt.format(n);
}

function fmtPnl(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return usdPnlFmt.format(n);
}

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function DashboardLiveTradesPage() {
  const [rows, setRows] = useState<LiveRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = Boolean(opts?.silent);
    if (!silent) {
      setLoading(true);
      setError(null);
      setUnauthorized(false);
    }
    try {
      const res = await fetch(`${API_BASE}/live-trades/me`, {
        headers: {
          Authorization: `Bearer ${localStorage.getItem("token") ?? ""}`,
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
        "positions" in data &&
        Array.isArray((data as { positions: unknown }).positions)
          ? ((data as { positions: LiveRow[] }).positions)
          : [];
      setRows(list);
      setLastRefreshed(new Date());
    } catch (e) {
      if (!silent) {
        setError(e instanceof Error ? e.message : "Failed to load positions");
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const id = window.setInterval(() => {
      void load({ silent: true });
    }, 8000);
    return () => window.clearInterval(id);
  }, [load]);

  if (unauthorized) {
    return (
      <div className="rounded-xl border border-amber-500/35 bg-amber-500/10 px-6 py-10 text-center">
        <p className="text-sm text-white/70">Sign in to view live positions.</p>
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
      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="rounded-xl border border-glassBorder bg-primary/10 p-3">
            <Activity className="h-6 w-6 text-primary" aria-hidden />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">
              Live trades
            </h1>
            <p className="mt-1 text-sm text-white/55">
              Open copy positions on Delta (mark price &amp; PnL from your linked exchange account).
            </p>
            {lastRefreshed && !loading ? (
              <p className="mt-0.5 text-xs text-white/40">
                Last refresh: {lastRefreshed.toLocaleTimeString()}
              </p>
            ) : null}
          </div>
        </div>
      </header>

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      <section className="glass-card border border-glassBorder overflow-hidden">
        <div className="scroll-table overflow-x-auto">
          <table className="w-full min-w-[920px] text-left text-sm">
            <thead className="border-b border-glassBorder bg-white/[0.03]">
              <tr>
                <th className="px-4 py-3 font-medium text-white/70">Strategy</th>
                <th className="px-4 py-3 font-medium text-white/70">
                  Entry time
                </th>
                <th className="px-4 py-3 font-medium text-white/70">Token</th>
                <th className="px-4 py-3 font-medium text-white/70">Side</th>
                <th className="px-4 py-3 font-medium text-white/70">
                  Entry price
                </th>
                <th className="px-4 py-3 font-medium text-white/70">SL</th>
                <th className="px-4 py-3 font-medium text-white/70">Target</th>
                <th className="px-4 py-3 font-medium text-white/70">
                  Live PnL
                </th>
                <th className="px-4 py-3 font-medium text-white/70">
                  Mark price
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
                    className="px-4 py-12 text-center text-white/50"
                  >
                    No open positions. Subscribe to a strategy and wait for the
                    trade engine to mirror entries on Delta.
                  </td>
                </tr>
              ) : (
                rows.map((r, i) => (
                  <tr
                    key={`${r.strategyId}-${r.token}-${r.side}-${i}`}
                    className="border-b border-white/[0.06] last:border-0 hover:bg-white/[0.02]"
                  >
                    <td className="max-w-[160px] truncate px-4 py-3 text-white/85">
                      {r.strategyTitle}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 tabular-nums text-white/55">
                      {fmtTime(r.entryTime)}
                    </td>
                    <td className="px-4 py-3 font-medium text-white">
                      {r.token}
                    </td>
                    <td className="px-4 py-3 text-white/70">{r.side}</td>
                    <td className="px-4 py-3 tabular-nums text-white/80">
                      {fmtPrice(r.entryPrice)}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-white/70">
                      {fmtPrice(r.stopLoss)}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-white/70">
                      {fmtPrice(r.target)}
                    </td>
                    <td
                      className={`px-4 py-3 tabular-nums font-medium ${
                        r.livePnl != null && r.livePnl >= 0
                          ? "text-emerald-400"
                          : r.livePnl != null
                            ? "text-red-300"
                            : "text-white/60"
                      }`}
                    >
                      {fmtPnl(r.livePnl)}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-white/80">
                      {fmtPrice(r.markPrice)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
