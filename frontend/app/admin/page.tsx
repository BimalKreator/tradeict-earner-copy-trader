"use client";

import {
  Activity,
  Banknote,
  Loader2,
  Server,
  TrendingUp,
  Users,
  Wallet,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";

const API_BASE = process.env.NEXT_PUBLIC_API_URL;

type DashboardStats = {
  totalUsers: number;
  activeSubscribers: number;
  totalAUM: number;
  systemTodayPnl: number;
  systemMonthlyPnl: number;
  totalPendingRevenue: number;
  masterApiStatus: "connected" | "disconnected";
  masterApiStrategyTitle: string | null;
  pendingApprovals: number;
  leaderboard: Array<{
    rank: number;
    name: string | null;
    email: string;
    totalNetPnl: number;
  }>;
  recentLiveTrades: Array<{
    id: string;
    symbol: string;
    side: string;
    status: string;
    pnl: number;
    createdAt: string;
    userEmail: string;
    strategyTitle: string;
  }>;
};

function fmtUsd(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function pnlClass(n: number): string {
  if (n > 0) return "text-emerald-400";
  if (n < 0) return "text-red-400";
  return "text-slate-300";
}

export default function AdminDashboardPage() {
  const [data, setData] = useState<DashboardStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const headers = useMemo(
    () => ({ Authorization: `Bearer ${localStorage.getItem("token") ?? ""}` }),
    [],
  );

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(`${API_BASE}/admin/dashboard-stats`, { headers });
        if (!res.ok) throw new Error(`Request failed (${res.status})`);
        setData((await res.json()) as DashboardStats);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load dashboard");
      } finally {
        setLoading(false);
      }
    })();
  }, [headers]);

  return (
    <div className="mx-auto max-w-7xl space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">
          Admin Command Center
        </h1>
        <p className="mt-1 text-sm text-slate-400">
          Platform-wide capital, performance, and operational health.
        </p>
      </header>

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-24">
          <Loader2 className="h-8 w-8 animate-spin text-cyan-400" />
        </div>
      ) : data ? (
        <>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
            <AdminCard
              icon={<Users className="h-5 w-5 text-cyan-400" />}
              label="Users & Subscribers"
              value={
                <span>
                  <span className="text-white">{data.totalUsers}</span>
                  <span className="text-slate-500"> Total / </span>
                  <span className="text-emerald-400">{data.activeSubscribers}</span>
                  <span className="text-slate-500"> Active</span>
                </span>
              }
              hint="Registered users · active strategy subscriptions"
            />

            <AdminCard
              icon={<Wallet className="h-5 w-5 text-sky-400" />}
              label="Total AUM (Capital)"
              value={fmtUsd(data.totalAUM)}
              hint="Sum of linked Delta balances"
              valueClass="text-3xl text-white"
            />

            <AdminCard
              icon={<TrendingUp className="h-5 w-5 text-violet-400" />}
              label="System-Wide PnL"
              value={
                <div className="space-y-1">
                  <p className={`text-lg font-semibold tabular-nums ${pnlClass(data.systemTodayPnl)}`}>
                    Today {fmtUsd(data.systemTodayPnl)}
                  </p>
                  <p className={`text-sm tabular-nums ${pnlClass(data.systemMonthlyPnl)}`}>
                    Month {fmtUsd(data.systemMonthlyPnl)}
                  </p>
                </div>
              }
              hint="Realized PnL from closed trades (UTC)"
            />

            <AdminCard
              icon={<Banknote className="h-5 w-5 text-amber-400" />}
              label="Expected Revenue"
              value={fmtUsd(data.totalPendingRevenue)}
              hint="Unpaid invoice dues across all users"
              valueClass="text-amber-300"
            />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <AdminCard
              icon={<Server className="h-5 w-5 text-slate-300" />}
              label="Master API Health"
              value={
                data.masterApiStatus === "connected" ? "Connected" : "Disconnected"
              }
              hint={
                data.masterApiStrategyTitle
                  ? `Strategy: ${data.masterApiStrategyTitle}`
                  : "No master keys configured"
              }
              valueClass={
                data.masterApiStatus === "connected"
                  ? "text-emerald-400"
                  : "text-red-400"
              }
              trailing={
                <StatusDot connected={data.masterApiStatus === "connected"} />
              }
            />

            <AdminCard
              icon={<Activity className="h-5 w-5 text-amber-300" />}
              label="Pending Approvals"
              value={String(data.pendingApprovals)}
              hint="Profile update requests awaiting review"
              className="lg:col-span-2"
            />
          </div>

          <section className="rounded-xl border border-slate-800 bg-slate-900 p-5 shadow-lg shadow-black/20">
            <h2 className="text-sm font-medium uppercase tracking-wider text-slate-400">
              Top Users by Profit
            </h2>
            <div className="mt-4 space-y-2">
              {data.leaderboard.map((u) => (
                <div
                  key={`${u.rank}-${u.email}`}
                  className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-950/60 px-4 py-3 text-sm"
                >
                  <span className="text-slate-200">
                    <span className="mr-2 font-mono text-slate-500">#{u.rank}</span>
                    {u.name ?? u.email}
                  </span>
                  <span className={`font-semibold tabular-nums ${pnlClass(u.totalNetPnl)}`}>
                    {fmtUsd(u.totalNetPnl)}
                  </span>
                </div>
              ))}
              {data.leaderboard.length === 0 && (
                <p className="text-sm text-slate-500">No closed trade data yet.</p>
              )}
            </div>
          </section>

          <section className="rounded-xl border border-slate-800 bg-slate-900 p-5 shadow-lg shadow-black/20">
            <h2 className="text-sm font-medium uppercase tracking-wider text-slate-400">
              Recent Live Trades
            </h2>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-800 text-xs uppercase tracking-wider text-slate-500">
                    <th className="px-3 py-3 font-medium">Time</th>
                    <th className="px-3 py-3 font-medium">User</th>
                    <th className="px-3 py-3 font-medium">Strategy</th>
                    <th className="px-3 py-3 font-medium">Symbol</th>
                    <th className="px-3 py-3 font-medium">Side</th>
                    <th className="px-3 py-3 font-medium">Status</th>
                    <th className="px-3 py-3 font-medium text-right">Net PnL</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recentLiveTrades.map((t) => (
                    <tr
                      key={t.id}
                      className="border-b border-slate-800/80 transition hover:bg-slate-800/30"
                    >
                      <td className="px-3 py-3 text-slate-400">
                        {new Date(t.createdAt).toLocaleString()}
                      </td>
                      <td className="px-3 py-3 text-slate-200">{t.userEmail}</td>
                      <td className="px-3 py-3 text-slate-300">{t.strategyTitle}</td>
                      <td className="px-3 py-3 font-mono text-slate-300">{t.symbol}</td>
                      <td className="px-3 py-3 text-slate-300">{t.side}</td>
                      <td className="px-3 py-3">
                        <span className="rounded-md bg-slate-800 px-2 py-0.5 text-xs text-slate-300">
                          {t.status}
                        </span>
                      </td>
                      <td
                        className={`px-3 py-3 text-right font-medium tabular-nums ${pnlClass(t.pnl)}`}
                      >
                        {fmtUsd(t.pnl)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.recentLiveTrades.length === 0 && (
                <p className="mt-4 text-sm text-slate-500">No recent trades.</p>
              )}
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}

function AdminCard({
  icon,
  label,
  value,
  hint,
  valueClass = "text-2xl text-white",
  trailing,
  className = "",
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  hint: string;
  valueClass?: string;
  trailing?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-xl border border-slate-800 bg-slate-900 p-5 shadow-lg shadow-black/20 ${className}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 text-slate-400">
          {icon}
          <p className="text-xs font-medium uppercase tracking-wider">{label}</p>
        </div>
        {trailing}
      </div>
      <div className={`mt-3 font-semibold tabular-nums ${valueClass}`}>{value}</div>
      <p className="mt-2 text-xs text-slate-500">{hint}</p>
    </div>
  );
}

function StatusDot({ connected }: { connected: boolean }) {
  return (
    <span
      className={`relative mt-1 inline-flex h-3 w-3 rounded-full ${
        connected ? "bg-emerald-500" : "bg-red-500"
      }`}
    >
      {connected && (
        <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400 opacity-75" />
      )}
    </span>
  );
}
