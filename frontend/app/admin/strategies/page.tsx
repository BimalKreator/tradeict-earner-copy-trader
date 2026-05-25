"use client";

import { useCallback, useEffect, useState } from "react";

const ENV_API_BASE =
  process.env.NEXT_PUBLIC_API_URL?.trim().replace(/\/$/, "") ?? "";

/** Backend prefix: env, or same-origin `/api` when env is missing (typical reverse-proxy setup). */
function resolveAdminApiBase(): string {
  if (ENV_API_BASE) return ENV_API_BASE;
  if (typeof window !== "undefined") {
    return `${window.location.origin.replace(/\/$/, "")}/api`;
  }
  return "";
}

type FutureHedgeConfig = {
  isAutoEnabled: boolean;
  baseLots: number;
  emaPeriod: number;
  adjustmentPct: number;
  targetProfitUsd: number;
};

type Strategy = {
  id: string;
  title: string;
  description: string;
  masterApiKey: string;
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

function isFutureHedgeStrategy(strategyTitle: string): boolean {
  return strategyTitle.toLowerCase().includes("future hedge");
}

const DEFAULT_FUTURE_HEDGE: FutureHedgeConfig = {
  isAutoEnabled: false,
  baseLots: 1,
  emaPeriod: 200,
  adjustmentPct: 0.5,
  targetProfitUsd: 10,
};

type StrategySubscriber = {
  subscriptionId: string;
  userId: string;
  name: string | null;
  email: string;
  multiplier: number;
  isActive: boolean;
  status: string;
  joinedDate: string;
};

type ModalTab = "details" | "subscribers";

/** Stored in `performanceMetrics` — drives charts / heatmap on the product UI. */
type PerformanceMetricsPayload = {
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

function authHeaders(): HeadersInit {
  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function parseCommaSeparatedStrings(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseCommaSeparatedNumbers(raw: string): number[] {
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number.parseFloat(s))
    .filter((n) => Number.isFinite(n));
}

function parseHeatmapText(raw: string): { date: string; value: number }[] {
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

function buildPerformanceMetrics(args: {
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

function hydratePerformanceFields(pm: unknown): {
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

export default function AdminStrategiesPage() {
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [savedMasterApiSecret, setSavedMasterApiSecret] = useState(false);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [masterApiKey, setMasterApiKey] = useState("");
  const [masterApiSecret, setMasterApiSecret] = useState("");
  const [slippage, setSlippage] = useState("0.5");
  const [monthlyFee, setMonthlyFee] = useState("");
  const [profitShare, setProfitShare] = useState("20");
  const [minCapital, setMinCapital] = useState("");

  const [performanceJsonOverride, setPerformanceJsonOverride] = useState("");
  const [pnlLabels, setPnlLabels] = useState("");
  const [pnlValues, setPnlValues] = useState("");
  const [tradingDays, setTradingDays] = useState("");
  const [winLossPercent, setWinLossPercent] = useState("");
  const [streak, setStreak] = useState("");
  const [avgPerDay, setAvgPerDay] = useState("");
  const [maxDrawdown, setMaxDrawdown] = useState("");
  const [barLabels, setBarLabels] = useState("");
  const [barProfit, setBarProfit] = useState("");
  const [barLoss, setBarLoss] = useState("");
  const [heatmapText, setHeatmapText] = useState("");
  const [syncActiveTrades, setSyncActiveTrades] = useState(false);
  const [isActive, setIsActive] = useState(true);
  const [hedgeAutoEnabled, setHedgeAutoEnabled] = useState(
    DEFAULT_FUTURE_HEDGE.isAutoEnabled,
  );
  const [hedgeBaseLots, setHedgeBaseLots] = useState(
    String(DEFAULT_FUTURE_HEDGE.baseLots),
  );
  const [hedgeEmaPeriod, setHedgeEmaPeriod] = useState(
    String(DEFAULT_FUTURE_HEDGE.emaPeriod),
  );
  const [hedgeAdjustmentPct, setHedgeAdjustmentPct] = useState(
    String(DEFAULT_FUTURE_HEDGE.adjustmentPct),
  );
  const [hedgeTargetProfitUsd, setHedgeTargetProfitUsd] = useState(
    String(DEFAULT_FUTURE_HEDGE.targetProfitUsd),
  );
  const [syncToast, setSyncToast] = useState<{
    kind: "ok" | "err";
    text: string;
  } | null>(null);
  const [forceSyncingId, setForceSyncingId] = useState<string | null>(null);
  const [modalTab, setModalTab] = useState<ModalTab>("details");
  const [subscribers, setSubscribers] = useState<StrategySubscriber[]>([]);
  const [subscribersLoading, setSubscribersLoading] = useState(false);
  const [subscribersError, setSubscribersError] = useState<string | null>(null);
  const [multiplierDrafts, setMultiplierDrafts] = useState<Record<string, string>>(
    {},
  );
  const [savingSubscriberId, setSavingSubscriberId] = useState<string | null>(
    null,
  );

  const loadStrategies = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const base = resolveAdminApiBase();
      const res = await fetch(`${base}/admin/strategies`, {
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const data: unknown = await res.json();
      if (!Array.isArray(data)) throw new Error("Invalid response");
      setStrategies(data as Strategy[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load strategies");
      setStrategies([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- on-mount fetch is a legitimate effect side-effect
    void loadStrategies();
  }, [loadStrategies]);

  useEffect(() => {
    if (!syncToast) return;
    const t = window.setTimeout(() => setSyncToast(null), 6000);
    return () => window.clearTimeout(t);
  }, [syncToast]);

  const loadSubscribers = useCallback(async (strategyId: string) => {
    setSubscribersLoading(true);
    setSubscribersError(null);
    try {
      const base = resolveAdminApiBase();
      const res = await fetch(
        `${base}/admin/strategies/${encodeURIComponent(strategyId)}/subscribers`,
        { headers: authHeaders() },
      );
      const body: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg =
          typeof body === "object" &&
          body !== null &&
          "error" in body &&
          typeof (body as { error?: unknown }).error === "string"
            ? (body as { error: string }).error
            : `Failed to load subscribers (${res.status})`;
        throw new Error(msg);
      }
      const data = body as { subscribers?: StrategySubscriber[] };
      const rows = Array.isArray(data.subscribers) ? data.subscribers : [];
      setSubscribers(rows);
      setMultiplierDrafts(
        Object.fromEntries(rows.map((r) => [r.userId, String(r.multiplier)])),
      );
    } catch (e) {
      setSubscribers([]);
      setMultiplierDrafts({});
      setSubscribersError(
        e instanceof Error ? e.message : "Failed to load subscribers",
      );
    } finally {
      setSubscribersLoading(false);
    }
  }, []);

  async function saveSubscriberMultiplier(
    strategyId: string,
    userId: string,
  ): Promise<void> {
    const raw = multiplierDrafts[userId] ?? "";
    const multiplier = Number.parseFloat(raw);
    if (!Number.isFinite(multiplier) || multiplier <= 0) {
      setSubscribersError("Multiplier must be a positive number.");
      return;
    }
    setSavingSubscriberId(userId);
    setSubscribersError(null);
    try {
      const base = resolveAdminApiBase();
      const res = await fetch(
        `${base}/admin/strategies/${encodeURIComponent(strategyId)}/subscribers/${encodeURIComponent(userId)}`,
        {
          method: "PUT",
          headers: authHeaders(),
          body: JSON.stringify({ multiplier }),
        },
      );
      const body: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg =
          typeof body === "object" &&
          body !== null &&
          "error" in body &&
          typeof (body as { error?: unknown }).error === "string"
            ? (body as { error: string }).error
            : `Update failed (${res.status})`;
        throw new Error(msg);
      }
      const updated = body as StrategySubscriber;
      setSubscribers((prev) =>
        prev.map((r) =>
          r.userId === userId
            ? {
                ...r,
                multiplier: updated.multiplier,
                isActive: updated.isActive,
                status: updated.status,
              }
            : r,
        ),
      );
      setMultiplierDrafts((prev) => ({
        ...prev,
        [userId]: String(updated.multiplier),
      }));
    } catch (e) {
      setSubscribersError(e instanceof Error ? e.message : "Update failed");
    } finally {
      setSavingSubscriberId(null);
    }
  }

  async function toggleSubscriberActive(
    strategyId: string,
    userId: string,
    nextActive: boolean,
  ): Promise<void> {
    setSavingSubscriberId(userId);
    setSubscribersError(null);
    try {
      const base = resolveAdminApiBase();
      const res = await fetch(
        `${base}/admin/strategies/${encodeURIComponent(strategyId)}/subscribers/${encodeURIComponent(userId)}`,
        {
          method: "PUT",
          headers: authHeaders(),
          body: JSON.stringify({ isActive: nextActive }),
        },
      );
      const body: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg =
          typeof body === "object" &&
          body !== null &&
          "error" in body &&
          typeof (body as { error?: unknown }).error === "string"
            ? (body as { error: string }).error
            : `Update failed (${res.status})`;
        throw new Error(msg);
      }
      const updated = body as StrategySubscriber;
      setSubscribers((prev) =>
        prev.map((r) =>
          r.userId === userId
            ? { ...r, isActive: updated.isActive, status: updated.status }
            : r,
        ),
      );
    } catch (e) {
      setSubscribersError(e instanceof Error ? e.message : "Update failed");
    } finally {
      setSavingSubscriberId(null);
    }
  }

  function resetForm() {
    setEditingId(null);
    setModalTab("details");
    setSubscribers([]);
    setSubscribersError(null);
    setMultiplierDrafts({});
    setSavingSubscriberId(null);
    setSavedMasterApiSecret(false);
    setTitle("");
    setDescription("");
    setMasterApiKey("");
    setMasterApiSecret("");
    setSlippage("0.5");
    setMonthlyFee("");
    setProfitShare("20");
    setMinCapital("");
    setPerformanceJsonOverride("");
    setPnlLabels("");
    setPnlValues("");
    setTradingDays("");
    setWinLossPercent("");
    setStreak("");
    setAvgPerDay("");
    setMaxDrawdown("");
    setBarLabels("");
    setBarProfit("");
    setBarLoss("");
    setHeatmapText("");
    setSyncActiveTrades(false);
    setIsActive(true);
    setHedgeAutoEnabled(DEFAULT_FUTURE_HEDGE.isAutoEnabled);
    setHedgeBaseLots(String(DEFAULT_FUTURE_HEDGE.baseLots));
    setHedgeEmaPeriod(String(DEFAULT_FUTURE_HEDGE.emaPeriod));
    setHedgeAdjustmentPct(String(DEFAULT_FUTURE_HEDGE.adjustmentPct));
    setHedgeTargetProfitUsd(String(DEFAULT_FUTURE_HEDGE.targetProfitUsd));
  }

  function openCreateModal() {
    resetForm();
    setFormError(null);
    setModalOpen(true);
  }

  function openEditModal(s: Strategy) {
    setModalTab("details");
    setEditingId(s.id);
    setFormError(null);
    setSavedMasterApiSecret(Boolean(s.hasMasterApiSecret));
    setTitle(s.title);
    setDescription(s.description);
    setMasterApiKey(s.masterApiKey);
    setMasterApiSecret("");
    setSlippage(String(s.slippage));
    setMonthlyFee(String(s.monthlyFee));
    setProfitShare(String(s.profitShare));
    setMinCapital(String(s.minCapital));

    const h = hydratePerformanceFields(s.performanceMetrics);
    setPerformanceJsonOverride(h.jsonOverride);
    setPnlLabels(h.pnlLabels);
    setPnlValues(h.pnlValues);
    setTradingDays(h.tradingDays);
    setWinLossPercent(h.winLossPercent);
    setStreak(h.streak);
    setAvgPerDay(h.avgPerDay);
    setMaxDrawdown(h.maxDrawdown);
    setBarLabels(h.barLabels);
    setBarProfit(h.barProfit);
    setBarLoss(h.barLoss);
    setHeatmapText(h.heatmapText);
    setSyncActiveTrades(Boolean(s.syncActiveTrades));
    setIsActive(s.isActive !== false);

    const cfg = s.futureHedgeConfig;
    if (cfg) {
      setHedgeAutoEnabled(Boolean(cfg.isAutoEnabled));
      setHedgeBaseLots(String(cfg.baseLots));
      setHedgeEmaPeriod(String(cfg.emaPeriod));
      setHedgeAdjustmentPct(String(cfg.adjustmentPct));
      setHedgeTargetProfitUsd(String(cfg.targetProfitUsd));
    } else {
      setHedgeAutoEnabled(DEFAULT_FUTURE_HEDGE.isAutoEnabled);
      setHedgeBaseLots(String(DEFAULT_FUTURE_HEDGE.baseLots));
      setHedgeEmaPeriod(String(DEFAULT_FUTURE_HEDGE.emaPeriod));
      setHedgeAdjustmentPct(String(DEFAULT_FUTURE_HEDGE.adjustmentPct));
      setHedgeTargetProfitUsd(String(DEFAULT_FUTURE_HEDGE.targetProfitUsd));
    }

    setModalOpen(true);
    void loadSubscribers(s.id);
  }

  useEffect(() => {
    if (!modalOpen || !editingId || modalTab !== "subscribers") return;
    void loadSubscribers(editingId);
  }, [modalOpen, editingId, modalTab, loadSubscribers]);

  async function handleForceSync(s: Strategy) {
    setForceSyncingId(s.id);
    setSyncToast(null);
    try {
      const base = resolveAdminApiBase();
      const res = await fetch(
        `${base}/admin/strategies/${encodeURIComponent(s.id)}/force-sync`,
        {
          method: "POST",
          headers: authHeaders(),
        },
      );
      const body: unknown = await res.json().catch(() => ({}));
      const errMsg =
        typeof body === "object" &&
        body !== null &&
        "error" in body &&
        typeof (body as { error?: unknown }).error === "string"
          ? (body as { error: string }).error
          : null;
      if (!res.ok) {
        setSyncToast({
          kind: "err",
          text: errMsg ?? `Force sync failed (${res.status})`,
        });
        return;
      }
      const data = body as {
        masterOpenLegs?: number;
        activeSubscribers?: number;
      };
      setSyncToast({
        kind: "ok",
        text: `Force sync OK — ${data.masterOpenLegs ?? 0} master leg(s), ${data.activeSubscribers ?? 0} active subscriber(s) processed.`,
      });
    } catch (e) {
      setSyncToast({
        kind: "err",
        text: e instanceof Error ? e.message : "Network error",
      });
    } finally {
      setForceSyncingId(null);
    }
  }

  async function handleSubmitStrategy(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setFormError(null);

    const slippageNum = Number(slippage);
    const monthlyFeeNum = Number(monthlyFee);
    const profitShareNum = Number(profitShare);
    const minCapitalNum = Number(minCapital);

    if (
      Number.isNaN(slippageNum) ||
      Number.isNaN(monthlyFeeNum) ||
      Number.isNaN(profitShareNum) ||
      Number.isNaN(minCapitalNum)
    ) {
      setFormError("Numeric fields must be valid numbers.");
      setSubmitting(false);
      return;
    }

    let performanceMetrics: PerformanceMetricsPayload | undefined;
    try {
      performanceMetrics = buildPerformanceMetrics({
        performanceJsonOverride,
        pnlLabels,
        pnlValues,
        tradingDays,
        winLossPercent,
        streak,
        avgPerDay,
        maxDrawdown,
        barLabels,
        barProfit,
        barLoss,
        heatmapText,
      });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Invalid performance data");
      setSubmitting(false);
      return;
    }

    const payload: Record<string, unknown> = {
      title,
      description,
      masterApiKey,
      slippage: slippageNum,
      monthlyFee: monthlyFeeNum,
      profitShare: profitShareNum,
      minCapital: minCapitalNum,
      syncActiveTrades,
    };
    const isEdit = editingId !== null;
    if (isEdit) {
      if (masterApiSecret.trim())
        payload.masterApiSecret = masterApiSecret.trim();
      payload.isActive = isActive;

      if (isFutureHedgeStrategy(title)) {
        const baseLots = Number.parseInt(hedgeBaseLots, 10);
        const emaPeriod = Number.parseInt(hedgeEmaPeriod, 10);
        const adjustmentPct = Number.parseFloat(hedgeAdjustmentPct);
        const targetProfitUsd = Number.parseFloat(hedgeTargetProfitUsd);

        if (
          !Number.isInteger(baseLots) ||
          baseLots < 1 ||
          !Number.isInteger(emaPeriod) ||
          emaPeriod < 1 ||
          !Number.isFinite(adjustmentPct) ||
          adjustmentPct <= 0 ||
          adjustmentPct > 100 ||
          !Number.isFinite(targetProfitUsd) ||
          targetProfitUsd <= 0
        ) {
          setFormError(
            "Future Hedge: base lots and EMA period must be integers ≥ 1; adjustment % must be 0–100; target profit must be positive.",
          );
          setSubmitting(false);
          return;
        }

        payload.futureHedgeConfig = {
          isAutoEnabled: hedgeAutoEnabled,
          baseLots,
          emaPeriod,
          adjustmentPct,
          targetProfitUsd,
        };
      }
    } else {
      payload.masterApiSecret = masterApiSecret;
    }
    if (performanceMetrics !== undefined) {
      payload.performanceMetrics = performanceMetrics;
    }

    try {
      const base = resolveAdminApiBase();
      const res = await fetch(
        isEdit
          ? `${base}/admin/strategies/${editingId}`
          : `${base}/admin/strategies`,
        {
          method: isEdit ? "PUT" : "POST",
          headers: authHeaders(),
          body: JSON.stringify(payload),
        },
      );
      const body: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg =
          typeof body === "object" &&
          body !== null &&
          "error" in body &&
          typeof (body as { error?: unknown }).error === "string"
            ? (body as { error: string }).error
            : `${isEdit ? "Update" : "Create"} failed (${res.status})`;
        throw new Error(msg);
      }
      setModalOpen(false);
      resetForm();
      await loadStrategies();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-6xl">
      <header className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">
            Strategies
          </h1>
          <p className="mt-1 text-sm text-white/55">
            Delta-to-Delta copy trading: set the leader&apos;s Delta Exchange (India) API credentials per strategy.
            Subscribers mirror fills using their own linked Delta accounts.
          </p>
        </div>
        <button
          type="button"
          onClick={openCreateModal}
          className="rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-white shadow-lg shadow-primary/25 transition hover:bg-primary/90"
        >
          Add strategy
        </button>
      </header>

      {error && (
        <div className="mb-6 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {syncToast && (
        <div
          className={`fixed bottom-6 right-6 z-[60] max-w-md rounded-lg border px-4 py-3 text-sm shadow-lg ${
            syncToast.kind === "ok"
              ? "border-emerald-500/45 bg-emerald-950/95 text-emerald-100"
              : "border-red-500/45 bg-red-950/95 text-red-100"
          }`}
          role="status"
        >
          {syncToast.text}
        </div>
      )}

      <div className="glass-card border border-glassBorder overflow-hidden">
        <div className="scroll-table overflow-x-auto">
          <table className="w-full min-w-[1100px] text-left text-sm">
            <thead className="border-b border-glassBorder bg-white/[0.03]">
              <tr>
                <th className="px-4 py-3 font-medium text-white/70">Title</th>
                <th className="px-4 py-3 font-medium text-white/70">Status</th>
                <th className="px-4 py-3 font-medium text-white/70">Description</th>
                <th className="px-4 py-3 font-medium text-white/70">Slippage</th>
                <th className="px-4 py-3 font-medium text-white/70">Monthly fee</th>
                <th className="px-4 py-3 font-medium text-white/70">Profit %</th>
                <th className="px-4 py-3 font-medium text-white/70">Min capital</th>
                <th className="px-4 py-3 font-medium text-white/70">Created</th>
                <th className="px-4 py-3 font-medium text-white/70">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={9} className="px-4 py-10 text-center text-white/45">
                    Loading strategies…
                  </td>
                </tr>
              ) : strategies.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-10 text-center text-white/45">
                    No strategies found.
                  </td>
                </tr>
              ) : (
                strategies.map((s) => (
                  <tr
                    key={s.id}
                    className="border-b border-white/[0.06] last:border-0 hover:bg-white/[0.02]"
                  >
                    <td className="max-w-[140px] truncate px-4 py-3 font-medium text-white">
                      {s.title}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ${
                          s.isActive !== false
                            ? "bg-emerald-500/15 text-emerald-200 ring-emerald-500/35"
                            : "bg-amber-500/15 text-amber-100 ring-amber-500/35"
                        }`}
                      >
                        {s.isActive !== false ? "Active" : "Paused"}
                      </span>
                    </td>
                    <td className="max-w-[200px] truncate px-4 py-3 text-white/70">
                      {s.description}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-white/80">{s.slippage}</td>
                    <td className="px-4 py-3 tabular-nums text-white/80">{s.monthlyFee}</td>
                    <td className="px-4 py-3 tabular-nums text-white/80">{s.profitShare}</td>
                    <td className="px-4 py-3 tabular-nums text-white/80">{s.minCapital}</td>
                    <td className="px-4 py-3 text-white/55 tabular-nums">
                      {new Date(s.createdAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => openEditModal(s)}
                          className="rounded-lg border border-glassBorder bg-white/[0.06] px-3 py-1.5 text-xs font-medium text-primary transition hover:bg-white/10"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          disabled={forceSyncingId === s.id}
                          onClick={() => void handleForceSync(s)}
                          className="rounded-lg border border-amber-500/35 bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-100 transition hover:bg-amber-500/15 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {forceSyncingId === s.id ? "Syncing…" : "Force sync trades"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {modalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/70 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="strategy-modal-title"
        >
          <div
            className={`glass-card my-8 w-full border border-glassBorder p-6 shadow-2xl ${
              editingId ? "max-w-4xl" : "max-w-2xl"
            }`}
          >
            <h2
              id="strategy-modal-title"
              className="text-lg font-semibold text-white"
            >
              {editingId ? "Edit strategy" : "Add strategy"}
            </h2>
            <p className="mt-1 text-sm text-white/50">
              {editingId && modalTab === "subscribers"
                ? "Manage copy-trading multipliers and per-user pause for this strategy."
                : (
                  <>
                    Leader credentials use <span className="text-white/70">masterApiKey</span> /{" "}
                    <span className="text-white/70">masterApiSecret</span> against the Delta India API.
                    Performance metrics below power product charts.
                  </>
                )}
            </p>

            {editingId ? (
              <div className="mt-4 flex gap-2 border-b border-white/10">
                <button
                  type="button"
                  onClick={() => setModalTab("details")}
                  className={`border-b-2 px-3 py-2 text-sm font-medium transition ${
                    modalTab === "details"
                      ? "border-primary text-primary"
                      : "border-transparent text-white/55 hover:text-white"
                  }`}
                >
                  Details
                </button>
                <button
                  type="button"
                  onClick={() => setModalTab("subscribers")}
                  className={`border-b-2 px-3 py-2 text-sm font-medium transition ${
                    modalTab === "subscribers"
                      ? "border-primary text-primary"
                      : "border-transparent text-white/55 hover:text-white"
                  }`}
                >
                  Subscribers
                  {subscribers.length > 0 ? (
                    <span className="ml-1.5 rounded-full bg-white/10 px-1.5 py-0.5 text-xs tabular-nums">
                      {subscribers.length}
                    </span>
                  ) : null}
                </button>
              </div>
            ) : null}

            {editingId && modalTab === "subscribers" ? (
              <div className="mt-6 max-h-[calc(100vh-10rem)] space-y-4 overflow-y-auto pr-1">
                {subscribersError ? (
                  <p className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                    {subscribersError}
                  </p>
                ) : null}
                <div className="overflow-x-auto rounded-xl border border-glassBorder">
                  <table className="w-full min-w-[640px] text-left text-sm">
                    <thead className="border-b border-glassBorder bg-white/[0.03]">
                      <tr>
                        <th className="px-3 py-2.5 font-medium text-white/70">Name</th>
                        <th className="px-3 py-2.5 font-medium text-white/70">Email</th>
                        <th className="px-3 py-2.5 font-medium text-white/70">Multiplier</th>
                        <th className="px-3 py-2.5 font-medium text-white/70">Status</th>
                        <th className="px-3 py-2.5 font-medium text-white/70">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {subscribersLoading ? (
                        <tr>
                          <td
                            colSpan={5}
                            className="px-3 py-8 text-center text-white/45"
                          >
                            Loading subscribers…
                          </td>
                        </tr>
                      ) : subscribers.length === 0 ? (
                        <tr>
                          <td
                            colSpan={5}
                            className="px-3 py-8 text-center text-white/45"
                          >
                            No subscribers for this strategy yet.
                          </td>
                        </tr>
                      ) : (
                        subscribers.map((sub) => {
                          const busy = savingSubscriberId === sub.userId;
                          return (
                            <tr
                              key={sub.subscriptionId}
                              className="border-b border-white/[0.06] last:border-0"
                            >
                              <td className="px-3 py-3 text-white">
                                {sub.name?.trim() || "—"}
                              </td>
                              <td className="max-w-[180px] truncate px-3 py-3 text-white/75">
                                {sub.email}
                              </td>
                              <td className="px-3 py-3">
                                <input
                                  type="number"
                                  min={0.1}
                                  step="any"
                                  disabled={busy}
                                  value={multiplierDrafts[sub.userId] ?? String(sub.multiplier)}
                                  onChange={(e) =>
                                    setMultiplierDrafts((prev) => ({
                                      ...prev,
                                      [sub.userId]: e.target.value,
                                    }))
                                  }
                                  className="w-24 rounded-lg border border-glassBorder bg-black/40 px-2 py-1.5 text-sm text-white tabular-nums outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-50"
                                />
                              </td>
                              <td className="px-3 py-3">
                                <span
                                  className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ${
                                    sub.isActive
                                      ? "bg-emerald-500/15 text-emerald-200 ring-emerald-500/35"
                                      : "bg-amber-500/15 text-amber-100 ring-amber-500/35"
                                  }`}
                                >
                                  {sub.isActive ? "Active" : "Paused"}
                                </span>
                                <span className="mt-1 block text-[10px] text-white/40">
                                  {sub.status.replace(/_/g, " ")}
                                </span>
                              </td>
                              <td className="px-3 py-3">
                                <div className="flex flex-wrap items-center gap-2">
                                  <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() =>
                                      void saveSubscriberMultiplier(
                                        editingId,
                                        sub.userId,
                                      )
                                    }
                                    className="rounded-lg border border-glassBorder bg-white/[0.06] px-2.5 py-1 text-xs font-medium text-primary transition hover:bg-white/10 disabled:opacity-50"
                                  >
                                    {busy ? "Saving…" : "Save mult."}
                                  </button>
                                  <button
                                    type="button"
                                    role="switch"
                                    aria-checked={sub.isActive}
                                    disabled={busy}
                                    onClick={() =>
                                      void toggleSubscriberActive(
                                        editingId,
                                        sub.userId,
                                        !sub.isActive,
                                      )
                                    }
                                    title={
                                      sub.isActive
                                        ? "Pause copy for this user"
                                        : "Resume copy for this user"
                                    }
                                    className={`relative h-6 w-10 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
                                      sub.isActive ? "bg-emerald-500/80" : "bg-white/20"
                                    }`}
                                  >
                                    <span
                                      className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
                                        sub.isActive ? "translate-x-4" : "translate-x-0"
                                      }`}
                                    />
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
                <div className="flex justify-end gap-3 border-t border-white/10 pt-4">
                  <button
                    type="button"
                    onClick={() => {
                      setModalOpen(false);
                      resetForm();
                    }}
                    className="rounded-lg px-4 py-2 text-sm font-medium text-white/70 transition hover:bg-white/10"
                  >
                    Close
                  </button>
                </div>
              </div>
            ) : (
            <form onSubmit={handleSubmitStrategy} className="mt-6 max-h-[calc(100vh-8rem)] space-y-6 overflow-y-auto pr-1">
              {formError && (
                <p className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                  {formError}
                </p>
              )}

              <div className="space-y-4 rounded-xl border border-glassBorder bg-white/[0.03] p-4">
                <h3 className="text-sm font-semibold text-white">Basics</h3>
                <label className="block">
                  <span className="text-xs font-medium text-white/60">Title</span>
                  <input
                    type="text"
                    required
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40"
                  />
                </label>
                <label className="block">
                  <span className="text-xs font-medium text-white/60">Description</span>
                  <textarea
                    required
                    rows={3}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    className="mt-1 w-full resize-y rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40"
                  />
                </label>
              </div>

              {editingId ? (
                <div className="space-y-3 rounded-xl border border-white/10 bg-white/[0.03] p-4">
                  <h3 className="text-sm font-semibold text-white">Strategy status</h3>
                  <label className="flex cursor-pointer items-center justify-between gap-4 rounded-lg border border-white/[0.08] bg-black/20 px-4 py-3">
                    <span>
                      <span className="text-sm font-medium text-white">
                        {isActive ? "Active" : "Paused"}
                      </span>
                      <span className="mt-0.5 block text-xs text-white/50">
                        Paused strategies skip copy-trading and automated hedge runs.
                      </span>
                    </span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={isActive}
                      onClick={() => setIsActive((v) => !v)}
                      className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${
                        isActive ? "bg-emerald-500/80" : "bg-white/20"
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 left-0.5 h-6 w-6 rounded-full bg-white shadow transition-transform ${
                          isActive ? "translate-x-5" : "translate-x-0"
                        }`}
                      />
                    </button>
                  </label>
                </div>
              ) : null}

              <div className="space-y-4 rounded-xl border border-primary/25 bg-primary/[0.06] p-4">
                <h3 className="text-sm font-semibold text-primary">Master Delta API</h3>
                <p className="text-xs text-white/55">
                  Delta Exchange India keys only. These map to <code className="text-primary/90">masterApiKey</code>{" "}
                  and <code className="text-primary/90">masterApiSecret</code> in the API payload.
                </p>
                <label className="block">
                  <span className="text-xs font-medium text-white/60">
                    Master Delta API Key
                  </span>
                  <input
                    type="text"
                    required
                    value={masterApiKey}
                    onChange={(e) => setMasterApiKey(e.target.value)}
                    autoComplete="off"
                    className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40"
                  />
                </label>
                <label className="block">
                  <span className="text-xs font-medium text-white/60">
                    Master Delta API Secret
                  </span>
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={masterApiSecret}
                    onChange={(e) => setMasterApiSecret(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40"
                    placeholder={
                      editingId && savedMasterApiSecret
                        ? "Leave blank to keep saved secret"
                        : "Paste secret"
                    }
                  />
                  {editingId && savedMasterApiSecret ? (
                    <p className="mt-1 text-[11px] text-white/45">
                      A secret is already stored. Enter a new one only if you want to replace it.
                    </p>
                  ) : null}
                </label>
                <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-white/[0.08] bg-black/20 px-3 py-3">
                  <input
                    type="checkbox"
                    checked={syncActiveTrades}
                    onChange={(e) => setSyncActiveTrades(e.target.checked)}
                    className="mt-0.5 h-4 w-4 shrink-0 rounded border-glassBorder text-primary focus:ring-primary/40"
                  />
                  <span>
                    <span className="text-sm font-medium text-white">
                      Sync Active Trades on Subscribe
                    </span>
                    <span className="mt-0.5 block text-xs text-white/50">
                      When enabled, new subscribers immediately mirror open positions from the master
                      Delta account (late-join). Requires valid master API credentials and follower
                      exchange keys.
                    </span>
                  </span>
                </label>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="text-xs font-medium text-white/60">Slippage</span>
                  <input
                    type="number"
                    step="any"
                    required
                    value={slippage}
                    onChange={(e) => setSlippage(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white tabular-nums outline-none focus:ring-2 focus:ring-primary/40"
                  />
                </label>
                <label className="block">
                  <span className="text-xs font-medium text-white/60">Monthly fee</span>
                  <input
                    type="number"
                    step="any"
                    required
                    value={monthlyFee}
                    onChange={(e) => setMonthlyFee(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white tabular-nums outline-none focus:ring-2 focus:ring-primary/40"
                  />
                </label>
                <label className="block">
                  <span className="text-xs font-medium text-white/60">Profit share (%)</span>
                  <input
                    type="number"
                    step="any"
                    required
                    value={profitShare}
                    onChange={(e) => setProfitShare(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white tabular-nums outline-none focus:ring-2 focus:ring-primary/40"
                  />
                </label>
                <label className="block">
                  <span className="text-xs font-medium text-white/60">Min capital</span>
                  <input
                    type="number"
                    step="any"
                    required
                    value={minCapital}
                    onChange={(e) => setMinCapital(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white tabular-nums outline-none focus:ring-2 focus:ring-primary/40"
                  />
                </label>
              </div>

              {isFutureHedgeStrategy(title) ? (
                <div className="space-y-4 rounded-xl border border-cyan-500/30 bg-cyan-500/[0.06] p-4">
                  <h3 className="text-sm font-semibold text-cyan-200">
                    Future Hedge settings
                  </h3>
                  <p className="text-xs text-white/55">
                    Saved with this strategy via the admin API. Shown when the title contains
                    &quot;Future Hedge&quot;.
                  </p>
                  <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-white/[0.08] bg-black/20 px-3 py-3">
                    <input
                      type="checkbox"
                      checked={hedgeAutoEnabled}
                      onChange={(e) => setHedgeAutoEnabled(e.target.checked)}
                      className="mt-0.5 h-4 w-4 shrink-0 rounded border-glassBorder text-cyan-400 focus:ring-cyan-500/40"
                    />
                    <span>
                      <span className="text-sm font-medium text-white">Auto enable</span>
                      <span className="mt-0.5 block text-xs text-white/50">
                        When on, the hedge engine may enter and adjust positions automatically.
                      </span>
                    </span>
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    <label className="block">
                      <span className="text-xs font-medium text-white/60">Base lots</span>
                      <input
                        type="number"
                        min={1}
                        step={1}
                        required
                        value={hedgeBaseLots}
                        onChange={(e) => setHedgeBaseLots(e.target.value)}
                        className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white tabular-nums outline-none focus:ring-2 focus:ring-cyan-500/40"
                      />
                    </label>
                    <label className="block">
                      <span className="text-xs font-medium text-white/60">EMA period</span>
                      <input
                        type="number"
                        min={1}
                        step={1}
                        required
                        value={hedgeEmaPeriod}
                        onChange={(e) => setHedgeEmaPeriod(e.target.value)}
                        className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white tabular-nums outline-none focus:ring-2 focus:ring-cyan-500/40"
                      />
                    </label>
                    <label className="block">
                      <span className="text-xs font-medium text-white/60">Adjustment %</span>
                      <input
                        type="number"
                        min={0.01}
                        max={100}
                        step="any"
                        required
                        value={hedgeAdjustmentPct}
                        onChange={(e) => setHedgeAdjustmentPct(e.target.value)}
                        className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white tabular-nums outline-none focus:ring-2 focus:ring-cyan-500/40"
                      />
                    </label>
                    <label className="block">
                      <span className="text-xs font-medium text-white/60">
                        Target profit (USD)
                      </span>
                      <input
                        type="number"
                        min={0.01}
                        step="any"
                        required
                        value={hedgeTargetProfitUsd}
                        onChange={(e) => setHedgeTargetProfitUsd(e.target.value)}
                        className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white tabular-nums outline-none focus:ring-2 focus:ring-cyan-500/40"
                      />
                    </label>
                  </div>
                </div>
              ) : null}

              <div className="space-y-4 rounded-xl border border-glassBorder bg-white/[0.03] p-4">
                <h3 className="text-sm font-semibold text-white">Performance data</h3>
                <p className="text-xs text-white/55">
                  Stored as JSON for charts: P&amp;L line, backtest summary, profit/loss bars, and calendar heatmap.
                </p>

                <details className="group rounded-lg border border-white/10 bg-black/20 p-3">
                  <summary className="cursor-pointer text-xs font-medium text-white/80">
                    P&amp;L chart (line) — labels &amp; values
                  </summary>
                  <p className="mt-2 text-xs text-white/45">
                    Comma-separated labels (e.g. dates) and matching numeric series for cumulative or daily P&amp;L.
                  </p>
                  <label className="mt-2 block">
                    <span className="text-xs font-medium text-white/60">Labels</span>
                    <input
                      type="text"
                      value={pnlLabels}
                      onChange={(e) => setPnlLabels(e.target.value)}
                      placeholder="Jan,Feb,Mar or 2024-01-01,2024-01-02"
                      className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40"
                    />
                  </label>
                  <label className="mt-2 block">
                    <span className="text-xs font-medium text-white/60">Values</span>
                    <input
                      type="text"
                      value={pnlValues}
                      onChange={(e) => setPnlValues(e.target.value)}
                      placeholder="100,250,-50,400"
                      className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40"
                    />
                  </label>
                </details>

                <details className="group rounded-lg border border-white/10 bg-black/20 p-3">
                  <summary className="cursor-pointer text-xs font-medium text-white/80">
                    Backtest summary
                  </summary>
                  <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
                    <label className="block">
                      <span className="text-xs font-medium text-white/60">Trading days</span>
                      <input
                        type="number"
                        step="any"
                        value={tradingDays}
                        onChange={(e) => setTradingDays(e.target.value)}
                        className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40"
                      />
                    </label>
                    <label className="block">
                      <span className="text-xs font-medium text-white/60">Win / Loss %</span>
                      <input
                        type="number"
                        step="any"
                        value={winLossPercent}
                        onChange={(e) => setWinLossPercent(e.target.value)}
                        className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40"
                      />
                    </label>
                    <label className="block">
                      <span className="text-xs font-medium text-white/60">Streak</span>
                      <input
                        type="number"
                        step="any"
                        value={streak}
                        onChange={(e) => setStreak(e.target.value)}
                        className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40"
                      />
                    </label>
                    <label className="block">
                      <span className="text-xs font-medium text-white/60">Avg per day</span>
                      <input
                        type="number"
                        step="any"
                        value={avgPerDay}
                        onChange={(e) => setAvgPerDay(e.target.value)}
                        className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40"
                      />
                    </label>
                    <label className="block">
                      <span className="text-xs font-medium text-white/60">Max drawdown</span>
                      <input
                        type="number"
                        step="any"
                        value={maxDrawdown}
                        onChange={(e) => setMaxDrawdown(e.target.value)}
                        className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40"
                      />
                    </label>
                  </div>
                </details>

                <details className="group rounded-lg border border-white/10 bg-black/20 p-3">
                  <summary className="cursor-pointer text-xs font-medium text-white/80">
                    Max profit &amp; loss (bar chart)
                  </summary>
                  <p className="mt-2 text-xs text-white/45">
                    Same-length comma lists: categories, profit series, loss series.
                  </p>
                  <label className="mt-2 block">
                    <span className="text-xs font-medium text-white/60">Bar labels</span>
                    <input
                      type="text"
                      value={barLabels}
                      onChange={(e) => setBarLabels(e.target.value)}
                      placeholder="Week1,Week2,Week3"
                      className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40"
                    />
                  </label>
                  <label className="mt-2 block">
                    <span className="text-xs font-medium text-white/60">Profit values</span>
                    <input
                      type="text"
                      value={barProfit}
                      onChange={(e) => setBarProfit(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40"
                    />
                  </label>
                  <label className="mt-2 block">
                    <span className="text-xs font-medium text-white/60">Loss values</span>
                    <input
                      type="text"
                      value={barLoss}
                      onChange={(e) => setBarLoss(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40"
                    />
                  </label>
                </details>

                <details className="group rounded-lg border border-white/10 bg-black/20 p-3">
                  <summary className="cursor-pointer text-xs font-medium text-white/80">
                    Daywise breakdown (heatmap)
                  </summary>
                  <p className="mt-2 text-xs text-white/45">
                    JSON array <code className="text-primary">[{`{ "date": "YYYY-MM-DD", "value": number }`}]</code>{" "}
                    or one row per line: <code className="text-primary">2024-06-01, 12.5</code>
                  </p>
                  <textarea
                    value={heatmapText}
                    onChange={(e) => setHeatmapText(e.target.value)}
                    rows={6}
                    placeholder={`[\n  { "date": "2024-01-02", "value": 4 },\n  { "date": "2024-01-03", "value": 0 }\n]`}
                    className="mt-2 w-full resize-y rounded-lg border border-glassBorder bg-black/40 px-3 py-2 font-mono text-xs text-white outline-none focus:ring-2 focus:ring-primary/40"
                  />
                </details>

                <label className="block">
                  <span className="text-xs font-medium text-amber-200/90">
                    Full JSON override (optional)
                  </span>
                  <p className="mt-1 text-xs text-white/45">
                    If filled, this replaces the structured fields above for{" "}
                    <code className="text-white/70">performanceMetrics</code>.
                  </p>
                  <textarea
                    value={performanceJsonOverride}
                    onChange={(e) => setPerformanceJsonOverride(e.target.value)}
                    rows={5}
                    placeholder='Paste complete JSON object — must match app expectations or charts may break.'
                    className="mt-2 w-full resize-y rounded-lg border border-amber-500/30 bg-black/40 px-3 py-2 font-mono text-xs text-white outline-none focus:ring-2 focus:ring-amber-500/40"
                  />
                </label>
              </div>

              <div className="flex justify-end gap-3 border-t border-white/10 pt-4">
                <button
                  type="button"
                  onClick={() => {
                    setModalOpen(false);
                    resetForm();
                  }}
                  className="rounded-lg px-4 py-2 text-sm font-medium text-white/70 transition hover:bg-white/10"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white shadow-lg shadow-primary/20 disabled:opacity-50"
                >
                  {submitting
                    ? editingId
                      ? "Saving…"
                      : "Creating…"
                    : editingId
                      ? "Save changes"
                      : "Create strategy"}
                </button>
              </div>
            </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
