import { resolveApiBase } from "./apiBase";

export type FutureHedgeConfig = {
  isAutoEnabled: boolean;
  baseLots: number;
  emaPeriod: number;
  adjustmentPct: number;
  targetProfitUsd: number;
};

export type Strategy = {
  id: string;
  title: string;
  description: string;
  /** @deprecated Use masterApiKeyMasked — raw key is no longer returned by the API. */
  masterApiKey?: string;
  masterApiKeyMasked?: string;
  hasMasterApiKey?: boolean;
  hasMasterApiSecret?: boolean;
  performanceMetrics?: PerformanceMetricsPayload | unknown;
  slippage: number;
  monthlyFee: number;
  profitShare: number;
  minCapital: number;
  isActive?: boolean;
  futureHedgeConfig?: FutureHedgeConfig | null;
  syncActiveTrades?: boolean;
  createdAt: string;
};

export type MasterConnectionTestResult = {
  success: boolean;
  error?: string;
  openPositionCount?: number;
  availableBalanceUsd?: number | null;
  apiKeyPrefix?: string;
};

export type StrategySubscriber = {
  subscriptionId: string;
  userId: string;
  name: string | null;
  email: string;
  multiplier: number;
  isActive: boolean;
  status: string;
  joinedDate: string;
};

export type PerformanceMetricsPayload = {
  pnlChart: {
    labels: string[];
    values: number[];
  };
  backtestSummary: {
    tradingDays: number;
    winLossPercent: number;
    streak: number;
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

export const DEFAULT_FUTURE_HEDGE: FutureHedgeConfig = {
  isAutoEnabled: false,
  baseLots: 1,
  emaPeriod: 200,
  adjustmentPct: 0.5,
  targetProfitUsd: 10,
};

export function isFutureHedgeStrategy(strategyTitle: string): boolean {
  return strategyTitle.toLowerCase().includes("future hedge");
}

export function adminAuthHeaders(): HeadersInit {
  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export function adminApiBase(): string {
  return resolveApiBase();
}

export async function testMasterDeltaConnection(args: {
  strategyId?: string;
  masterApiKey?: string;
  masterApiSecret?: string;
}): Promise<MasterConnectionTestResult> {
  const base = adminApiBase();
  const res = await fetch(`${base}/admin/strategies/test-master-connection`, {
    method: "POST",
    headers: adminAuthHeaders(),
    body: JSON.stringify(args),
  });
  const payload: unknown = await res.json().catch(() => ({}));
  if (!res.ok && typeof payload === "object" && payload !== null) {
    const err =
      "error" in payload && typeof (payload as { error: unknown }).error === "string"
        ? (payload as { error: string }).error
        : `Test failed (${res.status})`;
    return { success: false, error: err };
  }
  return payload as MasterConnectionTestResult;
}

export function parseCommaSeparatedStrings(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseCommaSeparatedNumbers(raw: string): number[] {
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number.parseFloat(s))
    .filter((n) => Number.isFinite(n));
}

export function parseHeatmapText(raw: string): { date: string; value: number }[] {
  const t = raw.trim();
  if (!t) return [];
  try {
    const parsed: unknown = JSON.parse(t);
    if (Array.isArray(parsed)) {
      return parsed
        .map((row) => {
          if (!row || typeof row !== "object") return null;
          const o = row as Record<string, unknown>;
          const date =
            typeof o.date === "string"
              ? o.date
              : typeof o.d === "string"
                ? o.d
                : "";
          const val =
            typeof o.value === "number"
              ? o.value
              : typeof o.count === "number"
                ? o.count
                : typeof o.v === "number"
                  ? o.v
                  : NaN;
          if (!date || !Number.isFinite(val)) return null;
          return { date, value: val };
        })
        .filter((x): x is { date: string; value: number } => x !== null);
    }
  } catch {
    /* fall through to line format */
  }
  const out: { date: string; value: number }[] = [];
  for (const line of t.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [d, v] = trimmed.split(/[,;\t]/).map((x) => x.trim());
    if (!d || v === undefined) continue;
    const num = Number.parseFloat(v);
    if (!Number.isFinite(num)) continue;
    out.push({ date: d, value: num });
  }
  return out;
}

export function buildPerformanceMetrics(args: {
  performanceJsonOverride: string;
  pnlLabels: string;
  pnlValues: string;
  tradingDays: string;
  winLossPercent: string;
  streak: string;
  avgPerDay: string;
  maxDrawdown: string;
  barLabels: string;
  barProfit: string;
  barLoss: string;
  heatmapText: string;
}): PerformanceMetricsPayload | undefined {
  const override = args.performanceJsonOverride.trim();
  if (override) {
    try {
      const parsed: unknown = JSON.parse(override);
      if (parsed && typeof parsed === "object") {
        return parsed as PerformanceMetricsPayload;
      }
    } catch {
      throw new Error("Performance JSON override is not valid JSON.");
    }
  }

  const labels = parseCommaSeparatedStrings(args.pnlLabels);
  const values = parseCommaSeparatedNumbers(args.pnlValues);
  const tradingDays = Number.parseFloat(args.tradingDays);
  const winLossPercent = Number.parseFloat(args.winLossPercent);
  const streak = Number.parseFloat(args.streak);
  const avgPerDay = Number.parseFloat(args.avgPerDay);
  const maxDrawdown = Number.parseFloat(args.maxDrawdown);
  const barLab = parseCommaSeparatedStrings(args.barLabels);
  const barP = parseCommaSeparatedNumbers(args.barProfit);
  const barL = parseCommaSeparatedNumbers(args.barLoss);
  const heatmap = parseHeatmapText(args.heatmapText);

  const hasAny =
    labels.length > 0 ||
    values.length > 0 ||
    args.tradingDays.trim() !== "" ||
    args.winLossPercent.trim() !== "" ||
    args.streak.trim() !== "" ||
    args.avgPerDay.trim() !== "" ||
    args.maxDrawdown.trim() !== "" ||
    barLab.length > 0 ||
    barP.length > 0 ||
    barL.length > 0 ||
    heatmap.length > 0;

  if (!hasAny) return undefined;

  return {
    pnlChart: { labels, values },
    backtestSummary: {
      tradingDays: Number.isFinite(tradingDays) ? tradingDays : 0,
      winLossPercent: Number.isFinite(winLossPercent) ? winLossPercent : 0,
      streak: Number.isFinite(streak) ? streak : 0,
      avgPerDay: Number.isFinite(avgPerDay) ? avgPerDay : 0,
      maxDrawdown: Number.isFinite(maxDrawdown) ? maxDrawdown : 0,
    },
    maxProfitLoss: {
      labels: barLab,
      profit: barP,
      loss: barL,
    },
    daywiseBreakdown: { heatmap },
  };
}

export function hydratePerformanceFields(pm: unknown): {
  pnlLabels: string;
  pnlValues: string;
  tradingDays: string;
  winLossPercent: string;
  streak: string;
  avgPerDay: string;
  maxDrawdown: string;
  barLabels: string;
  barProfit: string;
  barLoss: string;
  heatmapText: string;
  jsonOverride: string;
} {
  const empty = {
    pnlLabels: "",
    pnlValues: "",
    tradingDays: "",
    winLossPercent: "",
    streak: "",
    avgPerDay: "",
    maxDrawdown: "",
    barLabels: "",
    barProfit: "",
    barLoss: "",
    heatmapText: "",
    jsonOverride: "",
  };
  if (!pm || typeof pm !== "object") return empty;
  const o = pm as Record<string, unknown>;

  try {
    const pc = o.pnlChart as Record<string, unknown> | undefined;
    const bs = o.backtestSummary as Record<string, unknown> | undefined;
    const mpl = o.maxProfitLoss as Record<string, unknown> | undefined;
    const dw = o.daywiseBreakdown as Record<string, unknown> | undefined;

    const labels = Array.isArray(pc?.labels)
      ? (pc!.labels as unknown[]).map(String).join(", ")
      : "";
    const values = Array.isArray(pc?.values)
      ? (pc!.values as unknown[])
          .map((x) => (typeof x === "number" ? String(x) : ""))
          .filter(Boolean)
          .join(", ")
      : "";

    const heatArr = dw?.heatmap;
    let heatmapText = "";
    if (Array.isArray(heatArr)) {
      heatmapText = JSON.stringify(heatArr, null, 2);
    }

    return {
      pnlLabels: labels,
      pnlValues: values,
      tradingDays:
        typeof bs?.tradingDays === "number" ? String(bs.tradingDays) : "",
      winLossPercent:
        typeof bs?.winLossPercent === "number" ? String(bs.winLossPercent) : "",
      streak: typeof bs?.streak === "number" ? String(bs.streak) : "",
      avgPerDay: typeof bs?.avgPerDay === "number" ? String(bs.avgPerDay) : "",
      maxDrawdown:
        typeof bs?.maxDrawdown === "number" ? String(bs.maxDrawdown) : "",
      barLabels: Array.isArray(mpl?.labels)
        ? (mpl!.labels as unknown[]).map(String).join(", ")
        : "",
      barProfit: Array.isArray(mpl?.profit)
        ? (mpl!.profit as unknown[])
            .map((x) => (typeof x === "number" ? String(x) : ""))
            .filter(Boolean)
            .join(", ")
        : "",
      barLoss: Array.isArray(mpl?.loss)
        ? (mpl!.loss as unknown[])
            .map((x) => (typeof x === "number" ? String(x) : ""))
            .filter(Boolean)
            .join(", ")
        : "",
      heatmapText,
      jsonOverride: "",
    };
  } catch {
    return { ...empty, jsonOverride: JSON.stringify(pm, null, 2) };
  }
}

export function applyStrategyToFormState(s: Strategy): {
  savedMasterApiSecret: boolean;
  savedMasterApiKey: boolean;
  masterApiKeyMasked: string;
  title: string;
  description: string;
  slippage: string;
  monthlyFee: string;
  profitShare: string;
  minCapital: string;
  performance: ReturnType<typeof hydratePerformanceFields>;
  syncActiveTrades: boolean;
  isActive: boolean;
  hedge: FutureHedgeConfig;
} {
  const h = hydratePerformanceFields(s.performanceMetrics);
  const cfg = s.futureHedgeConfig;
  const hasKey = Boolean(
    s.hasMasterApiKey ?? s.masterApiKey?.trim() ?? s.masterApiKeyMasked,
  );

  return {
    savedMasterApiSecret: Boolean(s.hasMasterApiSecret),
    savedMasterApiKey: hasKey,
    masterApiKeyMasked:
      s.masterApiKeyMasked ??
      (hasKey ? "•••••••• (saved)" : ""),
    title: s.title,
    description: s.description,
    slippage: String(s.slippage),
    monthlyFee: String(s.monthlyFee),
    profitShare: String(s.profitShare),
    minCapital: String(s.minCapital),
    performance: h,
    syncActiveTrades: Boolean(s.syncActiveTrades),
    isActive: s.isActive !== false,
    hedge: cfg
      ? {
          isAutoEnabled: Boolean(cfg.isAutoEnabled),
          baseLots: cfg.baseLots,
          emaPeriod: cfg.emaPeriod,
          adjustmentPct: cfg.adjustmentPct,
          targetProfitUsd: cfg.targetProfitUsd,
        }
      : { ...DEFAULT_FUTURE_HEDGE },
  };
}
