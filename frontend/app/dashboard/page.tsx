"use client";

import { Activity, BarChart3, DollarSign, Loader2, Target } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";

const API_BASE = process.env.NEXT_PUBLIC_API_URL;

type Overview = {
  totalPortfolioValueUsd: number;
  activeSubscriptions: number;
  quickStats: { todaysPnl: number; totalWinRate: number };
  activeStrategyPerformance: { strategyId: string; strategyTitle: string; pnl: number }[];
};

export default function DashboardPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const token = useMemo(
    () => (typeof window !== "undefined" ? localStorage.getItem("token") : null),
    [],
  );

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(`${API_BASE}/user/dashboard-overview`, {
          headers: { Authorization: `Bearer ${token ?? ""}` },
        });
        if (!res.ok) throw new Error(`Failed to load dashboard (${res.status})`);
        setData((await res.json()) as Overview);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load dashboard");
      } finally {
        setLoading(false);
      }
    })();
  }, [token]);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">
          Trading Terminal
        </h1>
        <p className="mt-1 text-sm text-white/55">
          One-view performance cockpit for your copy-trading account.
        </p>
      </header>
      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}
      {loading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      ) : (
        <>
          <section className="grid gap-4 lg:grid-cols-3">
            <div className="glass-card border border-glassBorder p-5 lg:col-span-2">
              <p className="text-xs uppercase tracking-wider text-white/45">Total Portfolio Value</p>
              <div className="mt-2 flex items-center gap-3">
                <DollarSign className="h-7 w-7 text-primary" />
                <p className="text-3xl font-semibold text-white tabular-nums">
                  ${Number(data?.totalPortfolioValueUsd ?? 0).toFixed(2)}
                </p>
              </div>
              <p className="mt-2 text-xs text-white/45">
                Live Delta balance from your linked account.
              </p>
            </div>
            <div className="glass-card border border-glassBorder p-5">
              <p className="text-xs uppercase tracking-wider text-white/45">Active Strategies</p>
              <p className="mt-3 text-3xl font-semibold text-cyan-300 tabular-nums">
                {data?.activeSubscriptions ?? 0}
              </p>
              <p className="mt-2 text-xs text-white/45">Currently deployed subscriptions.</p>
            </div>
          </section>

          <section className="glass-card border border-glassBorder p-5">
            <div className="flex items-center gap-2">
              <BarChart3 className="h-5 w-5 text-primary" />
              <h2 className="text-lg font-semibold text-white">Active Strategy Performance</h2>
            </div>
            <div className="mt-4 space-y-3">
              {(data?.activeStrategyPerformance ?? []).map((s) => {
                const magnitude = Math.min(100, Math.max(6, Math.abs(s.pnl) / 10));
                return (
                  <div key={s.strategyId}>
                    <div className="mb-1 flex items-center justify-between text-sm">
                      <span className="text-white/85">{s.strategyTitle}</span>
                      <span className={`tabular-nums ${s.pnl >= 0 ? "text-emerald-300" : "text-red-300"}`}>
                        ${s.pnl.toFixed(2)}
                      </span>
                    </div>
                    <div className="h-2 rounded-full bg-white/10">
                      <div
                        className={`h-2 rounded-full ${s.pnl >= 0 ? "bg-emerald-400" : "bg-red-400"}`}
                        style={{ width: `${magnitude}%` }}
                      />
                    </div>
                  </div>
                );
              })}
              {(data?.activeStrategyPerformance ?? []).length === 0 && (
                <p className="text-sm text-white/50">No active strategy performance data yet.</p>
              )}
            </div>
          </section>

          <section className="grid gap-4 md:grid-cols-2">
            <QuickCard
              icon={<Activity className="h-5 w-5 text-primary" />}
              label="Today's PnL"
              value={`$${Number(data?.quickStats.todaysPnl ?? 0).toFixed(2)}`}
              tone={(data?.quickStats.todaysPnl ?? 0) >= 0 ? "good" : "bad"}
            />
            <QuickCard
              icon={<Target className="h-5 w-5 text-primary" />}
              label="Total Win Rate"
              value={`${Number(data?.quickStats.totalWinRate ?? 0).toFixed(2)}%`}
              tone="neutral"
            />
          </section>
        </>
      )}
    </div>
  );
}

function QuickCard({
  icon,
  label,
  value,
  tone,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  tone: "good" | "bad" | "neutral";
}) {
  return (
    <div className="glass-card border border-glassBorder p-5">
      <div className="flex items-center gap-2 text-white/70">
        {icon}
        <p className="text-xs uppercase tracking-wider">{label}</p>
      </div>
      <p
        className={`mt-2 text-2xl font-semibold tabular-nums ${
          tone === "good" ? "text-emerald-300" : tone === "bad" ? "text-red-300" : "text-white"
        }`}
      >
        {value}
      </p>
    </div>
  );
}
