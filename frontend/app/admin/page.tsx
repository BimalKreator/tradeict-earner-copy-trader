"use client";

import { useEffect, useMemo, useState } from "react";

const API_BASE = process.env.NEXT_PUBLIC_API_URL;

type DashboardStats = {
  totalUsers: number;
  activeStrategies: number;
  totalPnlNet: number;
  totalRevenue: number;
  pendingApprovals: number;
  leaderboard: Array<{ rank: number; name: string | null; email: string; totalNetPnl: number }>;
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
    <div className="mx-auto max-w-6xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">
          Admin Command Center
        </h1>
        <p className="mt-1 text-sm text-white/55">System-wide operations, approvals, and performance.</p>
      </header>
      {error && <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">{error}</div>}
      {loading ? (
        <div className="text-sm text-white/60">Loading dashboard...</div>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-4">
            <Card label="Total Users" value={String(data?.totalUsers ?? 0)} />
            <Card label="Active Subscriptions" value={String(data?.activeStrategies ?? 0)} />
            <Card label="System-wide Net PnL" value={`$${Number(data?.totalPnlNet ?? 0).toFixed(2)}`} />
            <Card label="Total Admin Revenue" value={`$${Number(data?.totalRevenue ?? 0).toFixed(2)}`} />
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="glass-card border border-glassBorder p-4">
              <p className="text-xs uppercase tracking-wider text-white/45">Pending Approvals</p>
              <p className="mt-2 text-3xl font-semibold text-amber-300">{data?.pendingApprovals ?? 0}</p>
              <p className="mt-1 text-xs text-white/50">Users waiting for profile change approval.</p>
            </div>
            <div className="glass-card border border-glassBorder p-4 lg:col-span-2">
              <p className="text-xs uppercase tracking-wider text-white/45">Top Users by Profit</p>
              <div className="mt-3 space-y-2">
                {(data?.leaderboard ?? []).map((u) => (
                  <div key={`${u.rank}-${u.email}`} className="flex items-center justify-between rounded-md border border-white/10 px-3 py-2 text-sm">
                    <span className="text-white/80">#{u.rank} {u.name ?? u.email}</span>
                    <span className={`tabular-nums ${u.totalNetPnl >= 0 ? "text-emerald-300" : "text-red-300"}`}>${u.totalNetPnl.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="glass-card border border-glassBorder p-4">
            <p className="text-xs uppercase tracking-wider text-white/45">Recent Live Trades</p>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="text-white/60">
                  <tr>
                    <th className="px-2 py-2">Time</th>
                    <th className="px-2 py-2">User</th>
                    <th className="px-2 py-2">Strategy</th>
                    <th className="px-2 py-2">Symbol</th>
                    <th className="px-2 py-2">Side</th>
                    <th className="px-2 py-2">Status</th>
                    <th className="px-2 py-2">Net PnL</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.recentLiveTrades ?? []).map((t) => (
                    <tr key={t.id} className="border-t border-white/10">
                      <td className="px-2 py-2 text-white/60">{new Date(t.createdAt).toLocaleString()}</td>
                      <td className="px-2 py-2 text-white">{t.userEmail}</td>
                      <td className="px-2 py-2 text-white/80">{t.strategyTitle}</td>
                      <td className="px-2 py-2 text-white/80">{t.symbol}</td>
                      <td className="px-2 py-2 text-white/80">{t.side}</td>
                      <td className="px-2 py-2 text-white/70">{t.status}</td>
                      <td className={`px-2 py-2 tabular-nums ${t.pnl >= 0 ? "text-emerald-300" : "text-red-300"}`}>${t.pnl.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Card({ label, value }: { label: string; value: string }) {
  return (
    <div className="glass-card border border-glassBorder p-5">
      <p className="text-xs uppercase tracking-wider text-white/45">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-white tabular-nums">{value}</p>
    </div>
  );
}
