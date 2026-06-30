"use client";

import {
  ArrowLeft,
  BarChart3,
  Calendar,
  Flame,
  LineChart as LineChartIcon,
  Loader2,
  Percent,
  TrendingDown,
  TrendingUp,
  Trophy,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import CalendarHeatmap from "react-calendar-heatmap";
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { StrategySubscriptionCheckout } from "@/components/strategies/StrategySubscriptionCheckout";
import {
  formatPercent,
  mockSubscriberCount,
  resolvePerformanceMetrics,
  type StrategyPerformanceMetrics,
} from "@/lib/strategyPerformance";

import "../../analytics/analytics-heatmap.css";

const API_BASE = process.env.NEXT_PUBLIC_API_URL;

type StrategyDetail = {
  id: string;
  title: string;
  description: string;
  monthlyFee: number;
  minCapital: number;
  profitShare: number;
  performanceMetrics: unknown;
};

const tooltipStyles = {
  contentStyle: {
    backgroundColor: "rgb(3 7 18)",
    border: "1px solid rgb(31 41 55)",
    borderRadius: "8px",
    fontSize: "12px",
    color: "#f3f4f6",
  },
  labelStyle: { color: "#9ca3af" },
};

function heatmapDateRange(rows: { date: string }[]): { start: Date; end: Date } {
  if (rows.length === 0) {
    const now = new Date();
    return {
      start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
      end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)),
    };
  }
  const ts = rows.map((r) =>
    Date.parse(r.date.includes("T") ? r.date : `${r.date}T12:00:00Z`),
  );
  const minD = new Date(Math.min(...ts));
  const maxD = new Date(Math.max(...ts));
  return {
    start: new Date(Date.UTC(minD.getUTCFullYear(), minD.getUTCMonth(), 1)),
    end: new Date(Date.UTC(maxD.getUTCFullYear(), maxD.getUTCMonth() + 1, 0)),
  };
}

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  accent = "text-gray-100",
}: {
  icon: typeof Calendar;
  label: string;
  value: string;
  sub?: string;
  accent?: string;
}) {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-950 p-4">
      <div className="flex items-center gap-2 text-gray-500">
        <Icon className="h-4 w-4 shrink-0 text-primary" aria-hidden />
        <span className="text-[10px] font-semibold uppercase tracking-wider">{label}</span>
      </div>
      <p className={`mt-3 text-2xl font-semibold tabular-nums ${accent}`}>{value}</p>
      {sub ? <p className="mt-1 text-xs text-gray-500">{sub}</p> : null}
    </div>
  );
}

export default function StrategyPerformancePage() {
  const params = useParams();
  const router = useRouter();
  const chartUid = useId().replace(/:/g, "");
  const idParam = params.id;
  const id = typeof idParam === "string" ? idParam : idParam?.[0];

  const [strategy, setStrategy] = useState<StrategyDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);
  const [inMyStrategies, setInMyStrategies] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    setUnauthorized(false);
    const token =
      typeof window !== "undefined" ? localStorage.getItem("token") : null;
    if (!token) {
      setUnauthorized(true);
      setStrategy(null);
      setLoading(false);
      return;
    }
    try {
      const res = await fetch(
        `${API_BASE}/subscriptions/strategies/${encodeURIComponent(id)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (res.status === 401) {
        setUnauthorized(true);
        setStrategy(null);
        return;
      }
      if (res.status === 404) {
        setError("Strategy not found.");
        setStrategy(null);
        return;
      }
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      setStrategy((await res.json()) as StrategyDetail);

      const mineRes = await fetch(`${API_BASE}/subscriptions/mine`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (mineRes.ok) {
        const mineData = (await mineRes.json()) as {
          subscriptions?: { strategyId: string }[];
        };
        const subs = mineData.subscriptions ?? [];
        setInMyStrategies(subs.some((s) => s.strategyId === id));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load strategy");
      setStrategy(null);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const metrics: StrategyPerformanceMetrics = useMemo(
    () => resolvePerformanceMetrics(strategy?.performanceMetrics),
    [strategy?.performanceMetrics],
  );

  const lineData = useMemo(
    () =>
      metrics.pnlChart.values.map((v, i) => ({
        name: metrics.pnlChart.labels[i] ?? String(i + 1),
        pnl: v,
      })),
    [metrics],
  );

  const barData = useMemo(() => {
    const { labels, profit, loss } = metrics.maxProfitLoss;
    const len = Math.max(labels.length, profit.length, loss.length);
    return Array.from({ length: len }, (_, i) => ({
      name: labels[i] ?? `M${i + 1}`,
      profit: profit[i] ?? 0,
      loss: Math.abs(loss[i] ?? 0),
    }));
  }, [metrics]);

  const heatmapRows = metrics.daywiseBreakdown.heatmap;
  const heatmapValues = useMemo(
    () =>
      heatmapRows.map((h) => ({
        date: h.date.includes("T") ? h.date.slice(0, 10) : h.date,
        count: h.value,
      })),
    [heatmapRows],
  );
  const heatmapRange = useMemo(() => heatmapDateRange(heatmapRows), [heatmapRows]);

  const bs = metrics.backtestSummary;
  const subscribers = id ? mockSubscriberCount(id) : 0;

  const yDomain = useMemo((): [number, number] => {
    const vals = metrics.pnlChart.values;
    if (vals.length === 0) return [16.5, 185];
    const pad = 8;
    return [Math.floor(Math.min(...vals) - pad), Math.ceil(Math.max(...vals) + pad)];
  }, [metrics.pnlChart.values]);

  if (!id) {
    return <p className="text-sm text-gray-400">Invalid strategy link.</p>;
  }

  if (unauthorized) {
    return (
      <div className="rounded-xl border border-amber-500/35 bg-amber-500/10 px-6 py-10 text-center">
        <p className="text-sm text-gray-200">Sign in to view this strategy.</p>
        <Link
          href="/login"
          className="mt-4 inline-flex rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-white"
        >
          Go to login
        </Link>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex justify-center py-24">
        <Loader2 className="h-10 w-10 animate-spin text-primary" aria-hidden />
      </div>
    );
  }

  if (error || !strategy) {
    return (
      <div className="space-y-4">
        <Link
          href="/dashboard/strategies"
          className="inline-flex items-center gap-2 text-sm text-primary hover:underline"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Back to marketplace
        </Link>
        <p className="text-sm text-red-300">{error ?? "Not found."}</p>
      </div>
    );
  }

  const strokeGrad = `stroke-${chartUid}`;
  const fillGrad = `fill-${chartUid}`;

  return (
    <div className="mx-auto max-w-6xl space-y-8 text-gray-100">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          href="/dashboard/strategies"
          className="inline-flex items-center gap-2 text-sm text-gray-400 transition hover:text-gray-200"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Back to marketplace
        </Link>
        <Link
          href="/dashboard"
          className="inline-flex items-center justify-center rounded-lg border border-gray-700 bg-gray-900 px-4 py-2 text-sm font-medium text-gray-200 transition hover:bg-gray-800"
        >
          Continue to Dashboard
        </Link>
      </div>

      {/* Hero */}
      <section className="rounded-2xl border border-gray-800 bg-gray-950 p-6 md:p-8">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-semibold tracking-tight text-gray-100 md:text-3xl">
              {strategy.title}
            </h1>
            <p className="mt-3 max-w-3xl text-sm leading-relaxed text-gray-400">
              {strategy.description}
            </p>
            <div className="mt-5 flex flex-wrap items-center gap-4 text-sm text-gray-500">
              <span className="inline-flex items-center gap-2 rounded-full border border-gray-800 bg-gray-900 px-3 py-1.5">
                <Users className="h-4 w-4 text-primary" aria-hidden />
                <span>
                  <span className="font-semibold tabular-nums text-gray-200">
                    {subscribers.toLocaleString("en-IN")}
                  </span>{" "}
                  active subscribers
                </span>
              </span>
              <span>
                ₹{strategy.monthlyFee.toLocaleString("en-IN")}/mo · Min ₹
                {strategy.minCapital.toLocaleString("en-IN")} · {strategy.profitShare}% profit
                share
              </span>
            </div>
          </div>
          {inMyStrategies ? (
            <Link
              href="/dashboard/strategies"
              className="inline-flex shrink-0 items-center justify-center rounded-lg border border-gray-700 bg-gray-900 px-6 py-3 text-sm font-medium text-gray-200"
            >
              Manage in My Strategies
            </Link>
          ) : null}
        </div>
        <p className="mt-4 text-[11px] text-gray-600">
          Performance charts use demo backtest data when admin metrics are not uploaded yet.
        </p>
      </section>

      {!inMyStrategies ? (
        <StrategySubscriptionCheckout
          strategyId={strategy.id}
          strategyTitle={strategy.title}
          monthlyFeeInr={strategy.monthlyFee}
          onSubscribed={() => {
            setInMyStrategies(true);
            router.push("/dashboard/strategies");
          }}
        />
      ) : null}

      {/* Backtest summary grid */}
      <section>
        <h2 className="text-lg font-semibold text-gray-100">Backtest summary</h2>
        <p className="mt-1 text-xs text-gray-500">Historical simulation — not a guarantee of future results.</p>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <StatCard icon={Calendar} label="Trading days" value={String(bs.tradingDays)} />
          <StatCard
            icon={Trophy}
            label="Win %"
            value={`${bs.winPercent}%`}
            accent="text-emerald-400"
          />
          <StatCard
            icon={Percent}
            label="Loss %"
            value={`${bs.lossPercent}%`}
            accent="text-rose-400"
          />
          <StatCard
            icon={Flame}
            label="Streak"
            value={`${bs.streakWins} wins`}
            sub="Longest win streak"
          />
          <StatCard
            icon={TrendingUp}
            label="Avg / day"
            value={formatPercent(bs.avgPerDay)}
            accent="text-emerald-400"
          />
          <StatCard
            icon={TrendingDown}
            label="Max drawdown"
            value={formatPercent(bs.maxDrawdown)}
            accent="text-amber-400"
          />
        </div>
      </section>

      {/* Cumulative P&L line */}
      <section className="rounded-2xl border border-gray-800 bg-gray-950 p-6 md:p-8">
        <div className="flex items-center gap-2">
          <LineChartIcon className="h-5 w-5 text-primary" aria-hidden />
          <h2 className="text-lg font-semibold text-gray-100">Cumulative P&amp;L</h2>
        </div>
        <p className="mt-1 text-xs text-gray-500">12-month growth (cumulative %)</p>
        <div className="mt-6 h-[320px] w-full min-w-0">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={lineData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id={strokeGrad} x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%" stopColor="#22c55e" />
                  <stop offset="100%" stopColor="#3b82f6" />
                </linearGradient>
                <linearGradient id={fillGrad} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#22c55e" stopOpacity={0.28} />
                  <stop offset="100%" stopColor="#3b82f6" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgb(31 41 55)" />
              <XAxis dataKey="name" tick={{ fill: "#6b7280", fontSize: 11 }} />
              <YAxis
                domain={yDomain}
                tick={{ fill: "#6b7280", fontSize: 11 }}
                tickFormatter={(v) => `${v}%`}
              />
              <Tooltip
                {...tooltipStyles}
                formatter={(v: number) => [`${v.toFixed(1)}%`, "Cumulative"]}
              />
              <Area
                type="monotone"
                dataKey="pnl"
                stroke={`url(#${strokeGrad})`}
                strokeWidth={2.5}
                fill={`url(#${fillGrad})`}
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="pnl"
                stroke={`url(#${strokeGrad})`}
                strokeWidth={2.5}
                dot={{ r: 3, fill: "#3b82f6", strokeWidth: 0 }}
                activeDot={{ r: 5 }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </section>

      {/* Monthly P&L bars */}
      <section className="rounded-2xl border border-gray-800 bg-gray-950 p-6 md:p-8">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-5 w-5 text-primary" aria-hidden />
          <h2 className="text-lg font-semibold text-gray-100">Monthly profit &amp; loss</h2>
        </div>
        <p className="mt-1 text-xs text-gray-500">Gross profit vs gross loss by month</p>
        <div className="mt-6 h-[300px] w-full min-w-0">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={barData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgb(31 41 55)" />
              <XAxis dataKey="name" tick={{ fill: "#6b7280", fontSize: 11 }} />
              <YAxis tick={{ fill: "#6b7280", fontSize: 11 }} tickFormatter={(v) => `${v}%`} />
              <Tooltip {...tooltipStyles} />
              <Legend wrapperStyle={{ fontSize: "12px", color: "#9ca3af" }} />
              <Bar dataKey="profit" name="Gross profit" fill="#22c55e" radius={[4, 4, 0, 0]} />
              <Bar dataKey="loss" name="Gross loss" fill="#ef4444" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>

      {/* Daywise heatmap */}
      <section className="rounded-2xl border border-gray-800 bg-gray-950 p-6 md:p-8">
        <div className="flex items-center gap-2">
          <Calendar className="h-5 w-5 text-primary" aria-hidden />
          <h2 className="text-lg font-semibold text-gray-100">Daywise breakdown</h2>
        </div>
        <p className="mt-1 text-xs text-gray-500">Daily returns — green positive, red negative</p>
        <div className="analytics-calendar-wrap scroll-table mt-6 overflow-x-auto">
          <CalendarHeatmap
            startDate={heatmapRange.start}
            endDate={heatmapRange.end}
            values={heatmapValues}
            classForValue={(v) => {
              if (!v || v.count === 0) return "color-neutral";
              return v.count > 0 ? "color-profit" : "color-loss";
            }}
            titleForValue={(v) =>
              v
                ? `${v.date}: ${Number(v.count).toLocaleString("en-IN", {
                    maximumFractionDigits: 2,
                    signDisplay: "exceptZero",
                  })}%`
                : "No data"
            }
            showWeekdayLabels
            gutterSize={3}
          />
        </div>
      </section>
    </div>
  );
}
