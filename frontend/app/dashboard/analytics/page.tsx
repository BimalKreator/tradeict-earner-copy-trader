"use client";

import {
  Activity,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  LayoutDashboard,
  Loader2,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import CalendarHeatmap from "react-calendar-heatmap";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import "react-calendar-heatmap/dist/styles.css";
import "./analytics-heatmap.css";

const API_BASE = process.env.NEXT_PUBLIC_API_URL;

type CalendarDay = { date: string; profit: number };

type StrategySeries = {
  strategyId: string;
  title: string;
  series: { date: string; cumulative: number }[];
};

type ActivityItem = {
  id: string;
  kind: string;
  message: string;
  createdAt: string;
};

function activityLabel(kind: string): string {
  switch (kind) {
    case "TRADE_SKIPPED":
      return "Trade skipped";
    case "SUBSCRIPTION_CREATED":
      return "Subscription";
    case "MULTIPLIER_UPDATED":
      return "Multiplier updated";
    default:
      return kind.replace(/_/g, " ").toLowerCase();
  }
}

function mergeChartData(strategies: StrategySeries[]): {
  data: Record<string, string | number>[];
  lines: { key: string; name: string; color: string }[];
} {
  const palette = [
    "#0A84FF",
    "#34d399",
    "#a78bfa",
    "#fbbf24",
    "#fb7185",
    "#2dd4bf",
  ];

  const daySet = new Set<string>();
  for (const s of strategies) {
    for (const p of s.series) {
      daySet.add(p.date.slice(0, 10));
    }
  }

  const days = [...daySet].sort();

  const cumulativeOnOrBefore = (
    series: { date: string; cumulative: number }[],
    day: string,
  ): number => {
    let v = 0;
    for (const p of series) {
      const d = p.date.slice(0, 10);
      if (d <= day) v = p.cumulative;
      else break;
    }
    return v;
  };

  const data = days.map((day) => {
    const row: Record<string, string | number> = { day };
    for (const s of strategies) {
      row[s.strategyId] = Number(
        cumulativeOnOrBefore(s.series, day).toFixed(4),
      );
    }
    return row;
  });

  const lines = strategies.map((s, i) => ({
    key: s.strategyId,
    name: s.title,
    color: palette[i % palette.length]!,
  }));

  return { data, lines };
}

export default function AnalyticsPage() {
  const now = new Date();
  const [year, setYear] = useState(now.getUTCFullYear());
  const [month, setMonth] = useState(now.getUTCMonth() + 1);

  const [calendarDays, setCalendarDays] = useState<CalendarDay[]>([]);
  const [strategies, setStrategies] = useState<StrategySeries[]>([]);
  const [activities, setActivities] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [unauthorized, setUnauthorized] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;

  const load = useCallback(async () => {
    setError(null);
    if (!token) {
      setUnauthorized(true);
      setLoading(false);
      return;
    }

    setUnauthorized(false);
    setLoading(true);

    try {
      const headers = { Authorization: `Bearer ${token}` };

      const [calRes, cumRes, actRes] = await Promise.all([
        fetch(
          `${API_BASE}/analytics/calendar?year=${year}&month=${month}`,
          { headers },
        ),
        fetch(`${API_BASE}/analytics/cumulative-strategies`, { headers }),
        fetch(`${API_BASE}/analytics/activity?limit=75`, { headers }),
      ]);

      if (calRes.status === 401 || cumRes.status === 401 || actRes.status === 401) {
        setUnauthorized(true);
        return;
      }

      if (!calRes.ok || !cumRes.ok || !actRes.ok) {
        throw new Error("Failed to load analytics");
      }

      const calJson: unknown = await calRes.json();
      const cumJson: unknown = await cumRes.json();
      const actJson: unknown = await actRes.json();

      if (
        typeof calJson !== "object" ||
        calJson === null ||
        !("days" in calJson) ||
        !Array.isArray((calJson as { days: unknown }).days)
      ) {
        throw new Error("Invalid calendar response");
      }

      setCalendarDays((calJson as { days: CalendarDay[] }).days);

      const stratRaw = (cumJson as { strategies?: unknown }).strategies;
      setStrategies(Array.isArray(stratRaw) ? (stratRaw as StrategySeries[]) : []);

      const itemsRaw = (actJson as { items?: unknown }).items;
      setActivities(Array.isArray(itemsRaw) ? (itemsRaw as ActivityItem[]) : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load analytics");
    } finally {
      setLoading(false);
    }
  }, [token, year, month]);

  useEffect(() => {
    void load();
  }, [load]);

  const heatmapValues = useMemo(
    () =>
      calendarDays.map((d) => ({
        date: d.date,
        count: d.profit,
      })),
    [calendarDays],
  );

  const heatmapStart = useMemo(
    () => new Date(Date.UTC(year, month - 1, 1)),
    [year, month],
  );
  const heatmapEnd = useMemo(
    () => new Date(Date.UTC(year, month, 0)),
    [year, month],
  );

  const { data: chartData, lines: chartLines } = useMemo(
    () => mergeChartData(strategies),
    [strategies],
  );

  function shiftMonth(delta: number) {
    const d = new Date(Date.UTC(year, month - 1 + delta, 1));
    setYear(d.getUTCFullYear());
    setMonth(d.getUTCMonth() + 1);
  }

  if (unauthorized) {
    return (
      <div className="rounded-xl border border-amber-500/35 bg-amber-500/10 px-6 py-10 text-center">
        <p className="text-sm text-white/70">Sign in to view analytics.</p>
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
    <div className="space-y-10">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="rounded-xl border border-glassBorder bg-primary/10 p-3">
            <BarChart3 className="h-6 w-6 text-primary" aria-hidden />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">
              Analytics
            </h1>
            <p className="mt-1 text-sm text-white/55">
              PnL calendar, cumulative performance by strategy, and recent
              activity.
            </p>
          </div>
        </div>
      </header>

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      <section className="glass-card border border-glassBorder p-6 md:p-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <LayoutDashboard className="h-5 w-5 text-primary/80" aria-hidden />
            <h2 className="text-lg font-semibold text-white">
              Monthly PnL calendar
            </h2>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => shiftMonth(-1)}
              className="rounded-lg border border-glassBorder p-2 text-white/70 hover:bg-white/10"
              aria-label="Previous month"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="min-w-[140px] text-center text-sm font-medium tabular-nums text-white">
              {new Date(Date.UTC(year, month - 1, 1)).toLocaleString("en-IN", {
                month: "long",
                year: "numeric",
                timeZone: "UTC",
              })}
            </span>
            <button
              type="button"
              onClick={() => shiftMonth(1)}
              className="rounded-lg border border-glassBorder p-2 text-white/70 hover:bg-white/10"
              aria-label="Next month"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
        <p className="mt-2 text-xs text-white/40">
          UTC days · Green = net profit from recorded PnL · Red = net loss · Gray = flat / no trades
        </p>

        <div className="analytics-calendar-wrap mx-auto mt-6 w-full max-w-4xl min-w-0 scroll-table overflow-x-auto">
          {loading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          ) : (
            <CalendarHeatmap
              startDate={heatmapStart}
              endDate={heatmapEnd}
              values={heatmapValues}
              classForValue={(v) => {
                if (!v || v.count === 0) return "color-neutral";
                return v.count > 0 ? "color-profit" : "color-loss";
              }}
              titleForValue={(v) =>
                v
                  ? `${v.date}: ₹${Number(v.count).toLocaleString("en-IN", {
                      maximumFractionDigits: 2,
                    })}`
                  : "No PnL"
              }
              showWeekdayLabels
              gutterSize={3}
            />
          )}
        </div>
      </section>

      <section className="glass-card border border-glassBorder p-6 md:p-8">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-5 w-5 text-primary/80" aria-hidden />
          <h2 className="text-lg font-semibold text-white">
            Cumulative PnL by strategy
          </h2>
        </div>
        <p className="mt-2 text-xs text-white/40">
          Built from realized PnL records per subscribed strategy (active or paused).
        </p>

        <div className="mt-6 h-[340px] w-full min-w-0">
          {loading ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          ) : chartData.length === 0 ? (
            <p className="flex h-full items-center justify-center text-sm text-white/45">
              No cumulative data yet. PnL appears after closed trades are recorded.
            </p>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData}>
                <CartesianGrid stroke="rgba(255,255,255,0.06)" strokeDasharray="3 3" />
                <XAxis
                  dataKey="day"
                  tick={{ fill: "rgba(255,255,255,0.45)", fontSize: 11 }}
                  tickFormatter={(v: string) => v.slice(5)}
                />
                <YAxis
                  tick={{ fill: "rgba(255,255,255,0.45)", fontSize: 11 }}
                  tickFormatter={(v: number) =>
                    `₹${v >= 1e5 ? `${(v / 1000).toFixed(0)}k` : v.toFixed(0)}`
                  }
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "rgba(12,12,14,0.95)",
                    border: "1px solid rgba(10,132,255,0.25)",
                    borderRadius: 8,
                  }}
                  labelStyle={{ color: "rgba(255,255,255,0.75)" }}
                  formatter={(value: number) => [
                    `₹${value.toLocaleString("en-IN", {
                      maximumFractionDigits: 2,
                    })}`,
                    "",
                  ]}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {chartLines.map((ln) => (
                  <Line
                    key={ln.key}
                    type="monotone"
                    dataKey={ln.key}
                    name={ln.name}
                    stroke={ln.color}
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </section>

      <section className="glass-card border border-glassBorder overflow-hidden">
        <div className="flex items-center gap-2 border-b border-glassBorder px-6 py-4">
          <Activity className="h-5 w-5 text-primary/80" aria-hidden />
          <h2 className="text-lg font-semibold text-white">Activity log</h2>
        </div>
        <div className="scroll-table overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="border-b border-glassBorder bg-white/[0.03]">
              <tr>
                <th className="px-4 py-3 font-medium text-white/70">Time</th>
                <th className="px-4 py-3 font-medium text-white/70">Event</th>
                <th className="px-4 py-3 font-medium text-white/70">Details</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={3} className="px-4 py-12 text-center text-white/45">
                    <Loader2 className="mx-auto h-6 w-6 animate-spin text-primary" />
                  </td>
                </tr>
              ) : activities.length === 0 ? (
                <tr>
                  <td colSpan={3} className="px-4 py-12 text-center text-white/45">
                    No activity recorded yet.
                  </td>
                </tr>
              ) : (
                activities.map((row) => (
                  <tr
                    key={row.id}
                    className="border-b border-white/[0.06] last:border-0 hover:bg-white/[0.02]"
                  >
                    <td className="whitespace-nowrap px-4 py-3 tabular-nums text-white/55">
                      {new Date(row.createdAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex rounded-full bg-white/[0.06] px-2.5 py-1 text-xs font-medium text-primary/95 ring-1 ring-primary/25">
                        {activityLabel(row.kind)}
                      </span>
                    </td>
                    <td className="max-w-xl px-4 py-3 text-white/80">
                      {row.message}
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
