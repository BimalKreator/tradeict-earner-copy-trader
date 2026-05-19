/** Performance metrics shape (stored on Strategy.performanceMetrics). */
export type StrategyPerformanceMetrics = {
  pnlChart: { labels: string[]; values: number[] };
  backtestSummary: {
    tradingDays: number;
    winPercent: number;
    lossPercent: number;
    streakWins: number;
    avgPerDay: number;
    maxDrawdown: number;
  };
  maxProfitLoss: {
    labels: string[];
    profit: number[];
    loss: number[];
  };
  daywiseBreakdown: {
    heatmap: { date: string; value: number }[];
  };
};

const MONTH_LABELS = [
  "Jun 25",
  "Jul 25",
  "Aug 25",
  "Sep 25",
  "Oct 25",
  "Nov 25",
  "Dec 25",
  "Jan 26",
  "Feb 26",
  "Mar 26",
  "Apr 26",
  "May 26",
];

function buildCumulativeCurve(): number[] {
  const start = 16.5;
  const end = 185;
  const n = MONTH_LABELS.length;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const ease = t * t * (3 - 2 * t);
    const wobble = Math.sin(i * 0.9) * 4.5;
    out.push(Math.round((start + (end - start) * ease + wobble) * 10) / 10);
  }
  return out;
}

function buildMonthlyBars(): { profit: number[]; loss: number[] } {
  const profit = [12.4, 18.2, 9.8, 22.1, 14.6, 11.3, 19.7, 16.4, 13.9, 21.5, 17.2, 24.8];
  const loss = [-3.2, -5.1, -2.4, -6.8, -4.2, -3.9, -5.6, -4.8, -3.1, -7.2, -5.4, -6.1];
  return { profit, loss };
}

function buildDaywiseHeatmap(): { date: string; value: number }[] {
  const rows: { date: string; value: number }[] = [];
  const end = new Date(Date.UTC(2026, 4, 26));
  let equity = 0;
  for (let i = 364; i >= 0; i--) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i);
    const date = d.toISOString().slice(0, 10);
    const drift = 0.42 + (Math.sin(i / 11) * 0.15);
    const noise = ((i * 17 + 13) % 100) / 100 - 0.48;
    const value = Math.round((drift + noise) * 100) / 100;
    equity += value;
    rows.push({ date, value });
  }
  return rows;
}

/** Demo metrics for UI review when API data is missing or sparse. */
export const MOCK_STRATEGY_PERFORMANCE: StrategyPerformanceMetrics = {
  pnlChart: {
    labels: MONTH_LABELS,
    values: buildCumulativeCurve(),
  },
  backtestSummary: {
    tradingDays: 365,
    winPercent: 84,
    lossPercent: 16,
    streakWins: 14,
    avgPerDay: 0.51,
    maxDrawdown: -14.2,
  },
  maxProfitLoss: {
    labels: MONTH_LABELS.map((m) => m.replace(" 25", "").replace(" 26", "")),
    profit: buildMonthlyBars().profit,
    loss: buildMonthlyBars().loss,
  },
  daywiseBreakdown: {
    heatmap: buildDaywiseHeatmap(),
  },
};

function parseMetrics(raw: unknown): StrategyPerformanceMetrics | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const pc = o.pnlChart as Record<string, unknown> | undefined;
  const bs = o.backtestSummary as Record<string, unknown> | undefined;
  const mpl = o.maxProfitLoss as Record<string, unknown> | undefined;
  const dw = o.daywiseBreakdown as Record<string, unknown> | undefined;

  const labels = Array.isArray(pc?.labels)
    ? (pc.labels as unknown[]).map(String)
    : [];
  const values = Array.isArray(pc?.values)
    ? (pc.values as unknown[])
        .map((v) => Number(v))
        .filter((n) => Number.isFinite(n))
    : [];

  const winLoss =
    typeof bs?.winLossPercent === "number" ? bs.winLossPercent : null;
  const winPercent =
    typeof bs?.winPercent === "number"
      ? bs.winPercent
      : winLoss !== null
        ? winLoss
        : MOCK_STRATEGY_PERFORMANCE.backtestSummary.winPercent;
  const lossPercent =
    typeof bs?.lossPercent === "number"
      ? bs.lossPercent
      : winLoss !== null
        ? 100 - winLoss
        : MOCK_STRATEGY_PERFORMANCE.backtestSummary.lossPercent;

  const heatRaw = dw?.heatmap;
  const heatmap = Array.isArray(heatRaw)
    ? heatRaw
        .map((row) => {
          if (!row || typeof row !== "object") return null;
          const r = row as Record<string, unknown>;
          const date = typeof r.date === "string" ? r.date : "";
          const value =
            typeof r.value === "number"
              ? r.value
              : typeof r.count === "number"
                ? r.count
                : NaN;
          if (!date || !Number.isFinite(value)) return null;
          return { date, value };
        })
        .filter((x): x is { date: string; value: number } => x !== null)
    : [];

  return {
    pnlChart: { labels, values },
    backtestSummary: {
      tradingDays:
        typeof bs?.tradingDays === "number"
          ? bs.tradingDays
          : MOCK_STRATEGY_PERFORMANCE.backtestSummary.tradingDays,
      winPercent,
      lossPercent,
      streakWins:
        typeof bs?.streakWins === "number"
          ? bs.streakWins
          : typeof bs?.streak === "number"
            ? bs.streak
            : MOCK_STRATEGY_PERFORMANCE.backtestSummary.streakWins,
      avgPerDay:
        typeof bs?.avgPerDay === "number"
          ? bs.avgPerDay
          : MOCK_STRATEGY_PERFORMANCE.backtestSummary.avgPerDay,
      maxDrawdown:
        typeof bs?.maxDrawdown === "number"
          ? bs.maxDrawdown
          : MOCK_STRATEGY_PERFORMANCE.backtestSummary.maxDrawdown,
    },
    maxProfitLoss: {
      labels: Array.isArray(mpl?.labels)
        ? (mpl.labels as unknown[]).map(String)
        : [],
      profit: Array.isArray(mpl?.profit)
        ? (mpl.profit as unknown[])
            .map((v) => Number(v))
            .filter((n) => Number.isFinite(n))
        : [],
      loss: Array.isArray(mpl?.loss)
        ? (mpl.loss as unknown[])
            .map((v) => Number(v))
            .filter((n) => Number.isFinite(n))
        : [],
    },
    daywiseBreakdown: { heatmap },
  };
}

function hasChartData(pm: StrategyPerformanceMetrics): boolean {
  return pm.pnlChart.values.length >= 3;
}

/** Prefer API metrics; fall back to mock for marketplace / detail UI. */
export function resolvePerformanceMetrics(
  raw: unknown,
  useMockFallback = true,
): StrategyPerformanceMetrics {
  const parsed = parseMetrics(raw);
  if (parsed && hasChartData(parsed)) return parsed;
  if (parsed && !useMockFallback) return parsed;
  if (parsed) {
    return {
      ...MOCK_STRATEGY_PERFORMANCE,
      backtestSummary: {
        ...MOCK_STRATEGY_PERFORMANCE.backtestSummary,
        ...parsed.backtestSummary,
      },
      maxProfitLoss:
        parsed.maxProfitLoss.labels.length > 0
          ? parsed.maxProfitLoss
          : MOCK_STRATEGY_PERFORMANCE.maxProfitLoss,
      daywiseBreakdown:
        parsed.daywiseBreakdown.heatmap.length > 0
          ? parsed.daywiseBreakdown
          : MOCK_STRATEGY_PERFORMANCE.daywiseBreakdown,
      pnlChart:
        parsed.pnlChart.values.length > 0
          ? parsed.pnlChart
          : MOCK_STRATEGY_PERFORMANCE.pnlChart,
    };
  }
  return MOCK_STRATEGY_PERFORMANCE;
}

/** Stable mock subscriber count per strategy (until API exposes real count). */
export function mockSubscriberCount(strategyId: string): number {
  let h = 0;
  for (let i = 0; i < strategyId.length; i++) {
    h = (Math.imul(31, h) + strategyId.charCodeAt(i)) | 0;
  }
  return 128 + (Math.abs(h) % 742);
}

export function formatPercent(n: number, digits = 2): string {
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(digits)}%`;
}
