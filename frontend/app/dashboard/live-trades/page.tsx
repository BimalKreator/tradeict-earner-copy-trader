"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, Loader2 } from "lucide-react";
import Link from "next/link";

const ENV_API_BASE =
  process.env.NEXT_PUBLIC_API_URL?.trim().replace(/\/$/, "") ?? "";

function resolveApiBase(): string {
  if (ENV_API_BASE) return ENV_API_BASE;
  if (typeof window !== "undefined") {
    return `${window.location.origin.replace(/\/$/, "")}/api`;
  }
  return "";
}

type LiveRow = {
  strategyId: string | null;
  strategyTitle: string;
  entryTime: string | null;
  token: string;
  entryPrice: number | null;
  livePnl: number | null;
  markPrice: number | null;
  side: string;
  size?: number | null;
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

function sumLivePnl(rows: LiveRow[]): number {
  return rows.reduce((acc, r) => {
    if (r.livePnl != null && Number.isFinite(r.livePnl)) return acc + r.livePnl;
    return acc;
  }, 0);
}

export default function DashboardLiveTradesPage() {
  const [rows, setRows] = useState<LiveRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);

  const totalPnl = useMemo(() => sumLivePnl(rows), [rows]);
  const pnlPositive = totalPnl > 0;
  const pnlNegative = totalPnl < 0;

  const load = useCallback(async (silent: boolean) => {
    const base = resolveApiBase();
    if (!base) {
      if (!silent) {
        setError("API URL is not configured.");
        setLoading(false);
      }
      return;
    }
    try {
      const res = await fetch(`${base}/live-trades/me?t=${Date.now()}`, {
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${localStorage.getItem("token") ?? ""}`,
          "Cache-Control": "no-cache",
          Pragma: "no-cache",
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
      const raw =
        typeof data === "object" &&
        data !== null &&
        "positions" in data &&
        Array.isArray((data as { positions: unknown }).positions)
          ? (data as { positions: unknown[] }).positions
          : [];
      const list: LiveRow[] = raw.map((item) => {
        const r = item as Record<string, unknown>;
        return {
          strategyId:
            typeof r.strategyId === "string" ? r.strategyId : null,
          strategyTitle: String(r.strategyTitle ?? "—"),
          entryTime:
            typeof r.entryTime === "string" ? r.entryTime : null,
          token: String(r.token ?? ""),
          entryPrice:
            typeof r.entryPrice === "number" ? r.entryPrice : null,
          livePnl: typeof r.livePnl === "number" ? r.livePnl : null,
          markPrice:
            typeof r.markPrice === "number" ? r.markPrice : null,
          side: String(r.side ?? ""),
          size: typeof r.size === "number" ? r.size : null,
        };
      });
      setRows(list);
      setLastRefreshed(new Date());
      if (!silent) {
        setError(null);
        setUnauthorized(false);
      }
    } catch (e) {
      if (!silent) {
        setError(e instanceof Error ? e.message : "Failed to load positions");
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- on-mount fetch
    void load(false);
  }, [load]);

  useEffect(() => {
    const id = window.setInterval(() => {
      void load(true);
    }, 500);
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
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="rounded-xl border border-glassBorder bg-primary/10 p-3">
            <Activity className="h-6 w-6 text-primary" aria-hidden />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">
              Live trades
            </h1>
            <p className="mt-1 text-sm text-white/55">
              All open positions on your Delta account (copy trades and manual
              entries). PnL matches Delta terminal UPNL when available.
            </p>
            {lastRefreshed && !loading ? (
              <p className="mt-0.5 text-xs text-white/40">
                Last refresh: {lastRefreshed.toLocaleTimeString()}
              </p>
            ) : null}
          </div>
        </div>

        {!loading && rows.length > 0 ? (
          <div
            className={`rounded-xl border px-5 py-3 text-right ${
              pnlPositive
                ? "border-emerald-500/35 bg-emerald-500/10"
                : pnlNegative
                  ? "border-red-500/35 bg-red-500/10"
                  : "border-white/10 bg-white/[0.03]"
            }`}
          >
            <p className="text-[10px] font-medium uppercase tracking-wider text-white/45">
              Total live PnL
            </p>
            <p
              className={`text-2xl font-bold tabular-nums ${
                pnlPositive
                  ? "text-emerald-400"
                  : pnlNegative
                    ? "text-red-400"
                    : "text-white/80"
              }`}
            >
              {fmtPnl(totalPnl)}
            </p>
          </div>
        ) : null}
      </header>

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      <section className="glass-card overflow-hidden border border-glassBorder">
        <div className="scroll-table overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="border-b border-glassBorder bg-white/[0.03]">
              <tr>
                <th className="px-4 py-3 font-medium text-white/70">Source</th>
                <th className="px-4 py-3 font-medium text-white/70">Token</th>
                <th className="px-4 py-3 font-medium text-white/70">Side</th>
                <th className="px-4 py-3 font-medium text-white/70">
                  Entry price
                </th>
                <th className="px-4 py-3 font-medium text-white/70">
                  <span title="Delta mark price (same as Terminal — not LTP)">
                    Mark price
                  </span>
                </th>
                <th className="px-4 py-3 font-medium text-white/70">
                  Live PnL
                </th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-14 text-center">
                    <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-12 text-center text-white/50"
                  >
                    No open positions on your linked Delta account.
                  </td>
                </tr>
              ) : (
                rows.map((r, i) => (
                  <tr
                    key={`${r.token}-${r.side}-${i}`}
                    className="border-b border-white/[0.06] last:border-0 hover:bg-white/[0.02]"
                  >
                    <td className="max-w-[180px] truncate px-4 py-3 text-white/85">
                      {r.strategyTitle}
                    </td>
                    <td className="px-4 py-3 font-medium text-white">
                      {r.token}
                    </td>
                    <td className="px-4 py-3 text-white/70">{r.side}</td>
                    <td className="px-4 py-3 tabular-nums text-white/80">
                      {fmtPrice(r.entryPrice)}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-white/80">
                      {fmtPrice(r.markPrice)}
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
