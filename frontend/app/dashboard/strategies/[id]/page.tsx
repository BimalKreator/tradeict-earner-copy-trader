"use client";

import {
  ArrowLeft,
  BarChart3,
  Calendar,
  LayoutDashboard,
  LineChart as LineChartIcon,
  Loader2,
} from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import CalendarHeatmap from "react-calendar-heatmap";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import "../../analytics/analytics-heatmap.css";

const API_BASE = process.env.NEXT_PUBLIC_API_URL;

type PerformanceMetrics = {
  pnlChart?: { labels?: string[]; values?: number[] };
  backtestSummary?: {
    tradingDays?: number;
    winLossPercent?: number;
    streak?: number;
    avgPerDay?: number;
    maxDrawdown?: number;
  };
  maxProfitLoss?: {
    labels?: string[];
    profit?: number[];
    loss?: number[];
  };
  daywiseBreakdown?: {
    heatmap?: { date: string; value: number }[];
  };
};

type StrategyDetail = {
  id: string;
  title: string;
  description: string;
  monthlyFee: number;
  minCapital: number;
  profitShare: number;
  slippage: number;
  performanceMetrics: PerformanceMetrics | unknown;
  createdAt: string;
};

function parseMetrics(raw: unknown): PerformanceMetrics | null {
  if (!raw || typeof raw !== "object") return null;
  return raw as PerformanceMetrics;
}

function fmtNum(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString("en-IN", {
    maximumFractionDigits: digits,
    minimumFractionDigits: 0,
  });
}

function heatmapDateRange(rows: { date: string }[]): {
  start: Date;
  end: Date;
} {
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
  const minT = Math.min(...ts);
  const maxT = Math.max(...ts);
  const minD = new Date(minT);
  const maxD = new Date(maxT);
  return {
    start: new Date(
      Date.UTC(minD.getUTCFullYear(), minD.getUTCMonth(), 1),
    ),
    end: new Date(Date.UTC(maxD.getUTCFullYear(), maxD.getUTCMonth() + 1, 0)),
  };
}

const tooltipStyles = {
  contentStyle: {
    backgroundColor: "rgba(15, 23, 42, 0.95)",
    border: "1px solid rgba(56, 189, 248, 0.25)",
    borderRadius: "8px",
    fontSize: "12px",
    color: "#e2e8f0",
  },
  labelStyle: { color: "#94a3b8" },
};

export default function StrategyPerformancePage() {
  const params = useParams();
  const idParam = params.id;
  const id = typeof idParam === "string" ? idParam : idParam?.[0];

  const [strategy, setStrategy] = useState<StrategyDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);

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
        {
          headers: { Authorization: `Bearer ${token}` },
        },
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
      const data: unknown = await res.json();
      setStrategy(data as StrategyDetail);
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

  const pm = useMemo(
    () => parseMetrics(strategy?.performanceMetrics),
    [strategy?.performanceMetrics],
  );

  const lineData = useMemo(() => {
    const labels = pm?.pnlChart?.labels ?? [];
    const values = pm?.pnlChart?.values ?? [];
    if (!values.length) return [];
    return values.map((v, i) => ({
      name: labels[i] ?? String(i + 1),
      pnl: v,
    }));
  }, [pm]);

  const barData = useMemo(() => {
    const labels = pm?.maxProfitLoss?.labels ?? [];
    const profit = pm?.maxProfitLoss?.profit ?? [];
    const loss = pm?.maxProfitLoss?.loss ?? [];
    if (!labels.length && !profit.length && !loss.length) return [];
    const len = Math.max(labels.length, profit.length, loss.length);
    const rows: { name: string; profit: number; loss: number }[] = [];
    for (let i = 0; i < len; i++) {
      rows.push({
        name: labels[i] ?? `S${i + 1}`,
        profit: profit[i] ?? 0,
        loss: loss[i] ?? 0,
      });
    }
    return rows;
  }, [pm]);

  const heatmapRows = pm?.daywiseBreakdown?.heatmap ?? [];
  const heatmapValues = useMemo(
    () =>
      heatmapRows.map((h) => ({
        date: h.date.includes("T") ? h.date.slice(0, 10) : h.date,
        count: h.value,
      })),
    [heatmapRows],
  );

  const range = useMemo(
    () => heatmapDateRange(heatmapRows),
    [heatmapRows],
  );

  const bs = pm?.backtestSummary;

  const totalTradesEstimate = useMemo(() => {
    const n = pm?.pnlChart?.values?.length ?? 0;
    const h = heatmapRows.length;
    if (n > 0) return n;
    if (h > 0) return h;
    return null;
  }, [pm?.pnlChart?.values?.length, heatmapRows.length]);

  const maxProfitFromBars = useMemo(() => {
    const p = pm?.maxProfitLoss?.profit;
    if (!p?.length) return null;
    return Math.max(...p);
  }, [pm?.maxProfitLoss?.profit]);

  const maxLossFromBars = useMemo(() => {
    const losses = pm?.maxProfitLoss?.loss;
    if (!losses?.length) return null;
    const hasNeg = losses.some((x) => x < 0);
    return hasNeg ? Math.min(...losses) : -Math.max(...losses.map(Math.abs));
  }, [pm?.maxProfitLoss?.loss]);

  if (!id) {
    return (
      <p className="text-sm text-white/55">Invalid strategy link.</p>
    );
  }

  if (unauthorized) {
    return (
      <div className="rounded-xl border border-amber-500/35 bg-amber-500/10 px-6 py-10 text-center">
        <p className="text-sm text-white/70">Sign in to view this strategy.</p>
        <Link
          href="/login"
          className="mt-4 inline-flex rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-white hover:bg-primary/90"
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
        <p className="text-sm text-red-200">{error ?? "Not found."}</p>
      </div>
    );
  }

  const hasMetrics = pm !== null && (
    lineData.length > 0 ||
    barData.length > 0 ||
    heatmapValues.length > 0 ||
    bs !== undefined
  );

  return (
    <div className="space-y-10">
      <div>
        <Link
          href="/dashboard/strategies"
          className="inline-flex items-center gap-2 text-sm text-primary hover:underline"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Back to marketplace
        </Link>
        <header className="mt-6 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="rounded-xl border border-glassBorder bg-primary/10 p-3">
              <LayoutDashboard className="h-6 w-6 text-primary" aria-hidden />
            </div>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">
                {strategy.title}
              </h1>
              <p className="mt-2 max-w-3xl text-sm leading-relaxed text-white/55">
                {strategy.description}
              </p>
              <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-xs text-white/45">
                <div>
                  <span className="text-white/35">Monthly fee </span>
                  <span className="tabular-nums text-white/70">
                    ₹{strategy.monthlyFee.toLocaleString("en-IN")}
                  </span>
                </div>
                <div>
                  <span className="text-white/35">Min capital </span>
                  <span className="tabular-nums text-white/70">
                    ₹{strategy.minCapital.toLocaleString("en-IN")}
                  </span>
                </div>
                <div>
                  <span className="text-white/35">Profit share </span>
                  <span className="tabular-nums text-emerald-300/90">
                    {strategy.profitShare}%
                  </span>
                </div>
              </dl>
            </div>
          </div>
        </header>
      </div>

      {!hasMetrics && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          No performance metrics uploaded for this strategy yet. Charts will appear when
          admin adds performance data.
        </div>
      )}

      {/* 1 — Main P&L line chart */}
      <section className="glass-card border border-glassBorder p-6 md:p-8">
        <div className="flex items-center gap-2">
          <LineChartIcon className="h-5 w-5 text-primary/80" aria-hidden />
          <h2 className="text-lg font-semibold text-white">P&amp;L performance</h2>
        </div>
        <p className="mt-1 text-xs text-white/45">
          Cumulative or period P&amp;L series from strategy backtest metrics.
        </p>
        <div className="mt-6 h-[320px] w-full min-w-0">
          {lineData.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={lineData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
                <XAxis dataKey="name" tick={{ fill: "#64748b", fontSize: 11 }} />
                <YAxis tick={{ fill: "#64748b", fontSize: 11 }} />
                <Tooltip {...tooltipStyles} />
                <Line
                  type="monotone"
                  dataKey="pnl"
                  name="PnL"
                  stroke="#0A84FF"
                  strokeWidth={2}
                  dot={{ fill: "#0A84FF", r: 3 }}
                  activeDot={{ r: 5 }}
                />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-white/15 bg-black/20 text-sm text-white/40">
              No P&amp;L series available
            </div>
          )}
        </div>
      </section>

      {/* 2 — Backtest summary: 4 columns */}
      <section className="glass-card border border-glassBorder p-6 md:p-8">
        <h2 className="text-lg font-semibold text-white">Backtest summary</h2>
        <p className="mt-1 text-xs text-white/45">
          Key statistics derived from uploaded performance metrics.
        </p>
        <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-4">
          <div className="rounded-xl border border-white/[0.08] bg-black/25 p-4">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-white/40">
              Trading days / Win–Loss
            </p>
            <p className="mt-3 text-2xl font-semibold tabular-nums text-white">
              {fmtNum(bs?.tradingDays, 0)}
            </p>
            <p className="mt-1 text-xs text-white/45">Trading days</p>
            <p className="mt-4 text-xl font-semibold tabular-nums text-emerald-300/90">
              {fmtNum(bs?.winLossPercent, 1)}%
            </p>
            <p className="mt-1 text-xs text-white/45">Win / Loss rate</p>
          </div>
          <div className="rounded-xl border border-white/[0.08] bg-black/25 p-4">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-white/40">
              Total trades
            </p>
            <p className="mt-3 text-2xl font-semibold tabular-nums text-white">
              {totalTradesEstimate !== null ? totalTradesEstimate : "—"}
            </p>
            <p className="mt-1 text-xs text-white/45">
              Estimated from P&amp;L points or heatmap days
            </p>
          </div>
          <div className="rounded-xl border border-white/[0.08] bg-black/25 p-4">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-white/40">
              Streaks / Max P&amp;L
            </p>
            <p className="mt-3 text-xl font-semibold tabular-nums text-white">
              {fmtNum(bs?.streak, 1)}
            </p>
            <p className="mt-1 text-xs text-white/45">Streak</p>
            <p className="mt-4 text-lg font-semibold tabular-nums text-emerald-300">
              {maxProfitFromBars !== null ? fmtNum(maxProfitFromBars, 2) : "—"}
            </p>
            <p className="mt-1 text-xs text-white/45">Max profit (bars)</p>
            <p className="mt-3 text-lg font-semibold tabular-nums text-rose-300">
              {maxLossFromBars !== null ? fmtNum(maxLossFromBars, 2) : "—"}
            </p>
            <p className="mt-1 text-xs text-white/45">Max loss (bars)</p>
          </div>
          <div className="rounded-xl border border-white/[0.08] bg-black/25 p-4">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-white/40">
              Averages / Drawdown
            </p>
            <p className="mt-3 text-xl font-semibold tabular-nums text-white">
              {fmtNum(bs?.avgPerDay, 2)}
            </p>
            <p className="mt-1 text-xs text-white/45">Avg per day</p>
            <p className="mt-4 text-xl font-semibold tabular-nums text-amber-200/90">
              {fmtNum(bs?.maxDrawdown, 2)}
            </p>
            <p className="mt-1 text-xs text-white/45">Max drawdown</p>
          </div>
        </div>
      </section>

      {/* 3 — Max profit & loss bar chart */}
      <section className="glass-card border border-glassBorder p-6 md:p-8">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-5 w-5 text-primary/80" aria-hidden />
          <h2 className="text-lg font-semibold text-white">Max profit &amp; loss</h2>
        </div>
        <p className="mt-1 text-xs text-white/45">
          Per-category profit vs loss from strategy metrics.
        </p>
        <div className="mt-6 h-[300px] w-full min-w-0">
          {barData.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={barData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
                <XAxis dataKey="name" tick={{ fill: "#64748b", fontSize: 11 }} />
                <YAxis tick={{ fill: "#64748b", fontSize: 11 }} />
                <Tooltip {...tooltipStyles} />
                <Legend wrapperStyle={{ fontSize: "12px", color: "#94a3b8" }} />
                <Bar dataKey="profit" name="Profit" fill="#22c55e" radius={[4, 4, 0, 0]} />
                <Bar dataKey="loss" name="Loss" fill="#ef4444" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-white/15 bg-black/20 text-sm text-white/40">
              No bar series available
            </div>
          )}
        </div>
      </section>

      {/* 4 — Daywise heatmap */}
      <section className="glass-card border border-glassBorder p-6 md:p-8">
        <div className="flex items-center gap-2">
          <Calendar className="h-5 w-5 text-primary/80" aria-hidden />
          <h2 className="text-lg font-semibold text-white">Daywise breakdown</h2>
        </div>
        <p className="mt-1 text-xs text-white/45">
          Calendar heatmap — green positive, red negative, gray flat.
        </p>
        <div className="scroll-table mt-6 overflow-x-auto">
          {heatmapValues.length > 0 ? (
            <CalendarHeatmap
              startDate={range.start}
              endDate={range.end}
              values={heatmapValues}
              classForValue={(v) => {
                if (!v || v.count === 0) return "color-neutral";
                return v.count > 0 ? "color-profit" : "color-loss";
              }}
              titleForValue={(v) =>
                v
                  ? `${v.date}: ${Number(v.count).toLocaleString("en-IN", {
                      maximumFractionDigits: 2,
                    })}`
                  : "No data"
              }
              showWeekdayLabels
              gutterSize={3}
            />
          ) : (
            <div className="flex min-h-[160px] items-center justify-center rounded-xl border border-dashed border-white/15 bg-black/20 text-sm text-white/40">
              No heatmap data available
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
