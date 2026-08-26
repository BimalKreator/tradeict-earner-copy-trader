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

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Parse API performance metrics only.
 * Returns null when missing or incomplete — callers must show an empty state
 * (never a fabricated curve, win rate, or subscriber count).
 */
export function resolvePerformanceMetrics(
  raw: unknown,
): StrategyPerformanceMetrics | null {
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

  // A chart with fewer than 2 points must not be drawn.
  if (values.length < 2) return null;

  const winLoss = finiteNumber(bs?.winLossPercent);
  const winPercent = finiteNumber(bs?.winPercent) ?? winLoss;
  const lossPercent =
    finiteNumber(bs?.lossPercent) ??
    (winLoss !== null ? 100 - winLoss : null);
  const tradingDays = finiteNumber(bs?.tradingDays);
  const streakWins =
    finiteNumber(bs?.streakWins) ?? finiteNumber(bs?.streak);
  const avgPerDay = finiteNumber(bs?.avgPerDay);
  const maxDrawdown = finiteNumber(bs?.maxDrawdown);

  if (
    winPercent == null ||
    lossPercent == null ||
    tradingDays == null ||
    streakWins == null ||
    avgPerDay == null ||
    maxDrawdown == null
  ) {
    return null;
  }

  const heatRaw = dw?.heatmap;
  const heatmap = Array.isArray(heatRaw)
    ? heatRaw
        .map((row) => {
          if (!row || typeof row !== "object") return null;
          const r = row as Record<string, unknown>;
          const date = typeof r.date === "string" ? r.date : "";
          const value =
            finiteNumber(r.value) ?? finiteNumber(r.count);
          if (!date || value == null) return null;
          return { date, value };
        })
        .filter((x): x is { date: string; value: number } => x !== null)
    : [];

  return {
    pnlChart: { labels, values },
    backtestSummary: {
      tradingDays,
      winPercent,
      lossPercent,
      streakWins,
      avgPerDay,
      maxDrawdown,
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

export function hasVerifiedTrackRecord(
  metrics: StrategyPerformanceMetrics | null | undefined,
): boolean {
  return metrics != null && metrics.pnlChart.values.length >= 2;
}

export function formatPercent(n: number, digits = 2): string {
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(digits)}%`;
}
