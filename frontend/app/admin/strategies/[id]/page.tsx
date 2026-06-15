"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  adminApiBase,
  adminAuthHeaders,
  applyStrategyToFormState,
  buildPerformanceMetrics,
  DEFAULT_FUTURE_HEDGE,
  isFutureHedgeStrategy,
  testMasterDeltaConnection,
  type Strategy,
  type StrategySubscriber,
} from "@/lib/adminStrategyForm";

type PageTab = "details" | "subscribers";

export default function AdminEditStrategyPage() {
  const params = useParams();
  const router = useRouter();
  const strategyId = typeof params.id === "string" ? params.id : "";

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pageTab, setPageTab] = useState<PageTab>("details");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [savedMasterApiSecret, setSavedMasterApiSecret] = useState(false);
  const [savedMasterApiKey, setSavedMasterApiKey] = useState(false);
  const [masterApiKeyMasked, setMasterApiKeyMasked] = useState("");
  const [testingMasterConnection, setTestingMasterConnection] = useState(false);
  const [masterConnectionMessage, setMasterConnectionMessage] = useState<
    string | null
  >(null);

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

  const [subscribers, setSubscribers] = useState<StrategySubscriber[]>([]);
  const [subscribersLoading, setSubscribersLoading] = useState(false);
  const [subscribersError, setSubscribersError] = useState<string | null>(null);
  const [multiplierDrafts, setMultiplierDrafts] = useState<Record<string, string>>(
    {},
  );
  const [savingSubscriberId, setSavingSubscriberId] = useState<string | null>(
    null,
  );

  const hydrateFormFromStrategy = useCallback((s: Strategy) => {
    const applied = applyStrategyToFormState(s);
    setSavedMasterApiSecret(applied.savedMasterApiSecret);
    setSavedMasterApiKey(applied.savedMasterApiKey);
    setMasterApiKeyMasked(applied.masterApiKeyMasked);
    setTitle(applied.title);
    setDescription(applied.description);
    setMasterApiKey("");
    setMasterApiSecret("");
    setSlippage(applied.slippage);
    setMonthlyFee(applied.monthlyFee);
    setProfitShare(applied.profitShare);
    setMinCapital(applied.minCapital);
    setPerformanceJsonOverride(applied.performance.jsonOverride);
    setPnlLabels(applied.performance.pnlLabels);
    setPnlValues(applied.performance.pnlValues);
    setTradingDays(applied.performance.tradingDays);
    setWinLossPercent(applied.performance.winLossPercent);
    setStreak(applied.performance.streak);
    setAvgPerDay(applied.performance.avgPerDay);
    setMaxDrawdown(applied.performance.maxDrawdown);
    setBarLabels(applied.performance.barLabels);
    setBarProfit(applied.performance.barProfit);
    setBarLoss(applied.performance.barLoss);
    setHeatmapText(applied.performance.heatmapText);
    setSyncActiveTrades(applied.syncActiveTrades);
    setIsActive(applied.isActive);
    setHedgeAutoEnabled(applied.hedge.isAutoEnabled);
    setHedgeBaseLots(String(applied.hedge.baseLots));
    setHedgeEmaPeriod(String(applied.hedge.emaPeriod));
    setHedgeAdjustmentPct(String(applied.hedge.adjustmentPct));
    setHedgeTargetProfitUsd(String(applied.hedge.targetProfitUsd));
  }, []);

  const loadStrategy = useCallback(async () => {
    if (!strategyId) {
      setLoadError("Invalid strategy id.");
      setLoading(false);
      return;
    }

    setLoading(true);
    setLoadError(null);
    try {
      const base = adminApiBase();
      const res = await fetch(`${base}/admin/strategies`, {
        headers: adminAuthHeaders(),
      });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const data: unknown = await res.json();
      if (!Array.isArray(data)) throw new Error("Invalid response");
      const match = (data as Strategy[]).find((s) => s.id === strategyId);
      if (!match) {
        setLoadError("Strategy not found.");
        return;
      }
      hydrateFormFromStrategy(match);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load strategy");
    } finally {
      setLoading(false);
    }
  }, [strategyId, hydrateFormFromStrategy]);

  const loadSubscribers = useCallback(async () => {
    if (!strategyId) return;
    setSubscribersLoading(true);
    setSubscribersError(null);
    try {
      const base = adminApiBase();
      const res = await fetch(
        `${base}/admin/strategies/${encodeURIComponent(strategyId)}/subscribers`,
        { headers: adminAuthHeaders() },
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
  }, [strategyId]);

  useEffect(() => {
    void loadStrategy();
  }, [loadStrategy]);

  useEffect(() => {
    if (!strategyId || pageTab !== "subscribers") return;
    void loadSubscribers();
  }, [strategyId, pageTab, loadSubscribers]);

  async function saveSubscriberMultiplier(userId: string): Promise<void> {
    const raw = multiplierDrafts[userId] ?? "";
    const multiplier = Number.parseFloat(raw);
    if (!Number.isFinite(multiplier) || multiplier <= 0) {
      setSubscribersError("Multiplier must be a positive number.");
      return;
    }
    setSavingSubscriberId(userId);
    setSubscribersError(null);
    try {
      const base = adminApiBase();
      const res = await fetch(
        `${base}/admin/strategies/${encodeURIComponent(strategyId)}/subscribers/${encodeURIComponent(userId)}`,
        {
          method: "PUT",
          headers: adminAuthHeaders(),
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
    userId: string,
    nextActive: boolean,
  ): Promise<void> {
    setSavingSubscriberId(userId);
    setSubscribersError(null);
    try {
      const base = adminApiBase();
      const res = await fetch(
        `${base}/admin/strategies/${encodeURIComponent(strategyId)}/subscribers/${encodeURIComponent(userId)}`,
        {
          method: "PUT",
          headers: adminAuthHeaders(),
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

  async function handleTestMasterConnection() {
    setTestingMasterConnection(true);
    setMasterConnectionMessage(null);
    try {
      const result = await testMasterDeltaConnection({
        strategyId,
        ...(masterApiKey.trim() ? { masterApiKey: masterApiKey.trim() } : {}),
        ...(masterApiSecret.trim()
          ? { masterApiSecret: masterApiSecret.trim() }
          : {}),
      });
      if (result.success) {
        const bal =
          result.availableBalanceUsd != null &&
          Number.isFinite(result.availableBalanceUsd)
            ? ` · Balance $${result.availableBalanceUsd.toFixed(2)}`
            : "";
        setMasterConnectionMessage(
          `Connected (${result.apiKeyPrefix ?? "key OK"}) · ${result.openPositionCount ?? 0} open position(s)${bal}`,
        );
      } else {
        setMasterConnectionMessage(
          result.error ?? "Connection failed — check Delta India API keys.",
        );
      }
    } catch (e) {
      setMasterConnectionMessage(
        e instanceof Error ? e.message : "Connection test failed",
      );
    } finally {
      setTestingMasterConnection(false);
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

    let performanceMetrics;
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
      setFormError(
        err instanceof Error ? err.message : "Invalid performance data",
      );
      setSubmitting(false);
      return;
    }

    const payload: Record<string, unknown> = {
      title,
      description,
      slippage: slippageNum,
      monthlyFee: monthlyFeeNum,
      profitShare: profitShareNum,
      minCapital: minCapitalNum,
      syncActiveTrades,
      isActive,
    };

    if (masterApiKey.trim()) {
      payload.masterApiKey = masterApiKey.trim();
    } else if (!savedMasterApiKey) {
      setFormError("Master Delta API key is required.");
      setSubmitting(false);
      return;
    }

    if (masterApiSecret.trim()) {
      payload.masterApiSecret = masterApiSecret.trim();
    } else if (!savedMasterApiSecret) {
      setFormError("Master Delta API secret is required.");
      setSubmitting(false);
      return;
    }

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

    if (performanceMetrics !== undefined) {
      payload.performanceMetrics = performanceMetrics;
    }

    try {
      const base = adminApiBase();
      const res = await fetch(
        `${base}/admin/strategies/${encodeURIComponent(strategyId)}`,
        {
          method: "PUT",
          headers: adminAuthHeaders(),
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
            : `Update failed (${res.status})`;
        throw new Error(msg);
      }
      router.push("/admin/strategies");
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-4xl py-16 text-center text-white/50">
        Loading strategy…
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="mx-auto max-w-4xl space-y-4">
        <Link
          href="/admin/strategies"
          className="inline-flex text-sm font-medium text-primary transition hover:text-primary/80"
        >
          ← Back to Strategies
        </Link>
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {loadError}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-6">
        <Link
          href="/admin/strategies"
          className="inline-flex items-center gap-1 text-sm font-medium text-primary transition hover:text-primary/80"
        >
          ← Back to Strategies
        </Link>
      </div>

      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">
          Edit strategy
        </h1>
        <p className="mt-1 text-sm text-white/55">
          {pageTab === "subscribers"
            ? "Manage copy-trading multipliers and per-user pause for this strategy."
            : (
              <>
                Leader credentials use{" "}
                <span className="text-white/70">masterApiKey</span> /{" "}
                <span className="text-white/70">masterApiSecret</span> against
                the Delta India API. Performance metrics power product charts.
              </>
            )}
        </p>
      </header>

      <div className="glass-card border border-glassBorder p-6 shadow-2xl">
        <div className="flex gap-2 border-b border-white/10">
          <button
            type="button"
            onClick={() => setPageTab("details")}
            className={`border-b-2 px-3 py-2 text-sm font-medium transition ${
              pageTab === "details"
                ? "border-primary text-primary"
                : "border-transparent text-white/55 hover:text-white"
            }`}
          >
            Details
          </button>
          <button
            type="button"
            onClick={() => setPageTab("subscribers")}
            className={`border-b-2 px-3 py-2 text-sm font-medium transition ${
              pageTab === "subscribers"
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

        {pageTab === "subscribers" ? (
          <div className="mt-6 space-y-4">
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
                              value={
                                multiplierDrafts[sub.userId] ??
                                String(sub.multiplier)
                              }
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
                                  void saveSubscriberMultiplier(sub.userId)
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
                                  sub.isActive
                                    ? "bg-emerald-500/80"
                                    : "bg-white/20"
                                }`}
                              >
                                <span
                                  className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
                                    sub.isActive
                                      ? "translate-x-4"
                                      : "translate-x-0"
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
          </div>
        ) : (
          <form onSubmit={handleSubmitStrategy} className="mt-6 space-y-6">
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
                <span className="text-xs font-medium text-white/60">
                  Description
                </span>
                <textarea
                  required
                  rows={3}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="mt-1 w-full resize-y rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40"
                />
              </label>
            </div>

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

            <div className="space-y-4 rounded-xl border border-primary/25 bg-primary/[0.06] p-4">
              <h3 className="text-sm font-semibold text-primary">Master Delta API</h3>
              <p className="text-xs text-white/55">
                Delta Exchange India keys only. These map to{" "}
                <code className="text-primary/90">masterApiKey</code> and{" "}
                <code className="text-primary/90">masterApiSecret</code> in the
                API payload.
              </p>
              <label className="block">
                <span className="text-xs font-medium text-white/60">
                  Master Delta API Key
                </span>
                <input
                  type="text"
                  value={masterApiKey}
                  onChange={(e) => setMasterApiKey(e.target.value)}
                  autoComplete="off"
                  className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40"
                  placeholder={
                    savedMasterApiKey
                      ? `Saved: ${masterApiKeyMasked || "••••••••"} — enter only to replace`
                      : "Paste API key from Delta Exchange India"
                  }
                />
                {savedMasterApiKey ? (
                  <p className="mt-1 text-[11px] text-white/45">
                    A key is already stored. Enter a new one only to replace it.
                  </p>
                ) : null}
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
                    savedMasterApiSecret
                      ? "Leave blank to keep saved secret"
                      : "Paste secret"
                  }
                />
                {savedMasterApiSecret ? (
                  <p className="mt-1 text-[11px] text-white/45">
                    A secret is already stored. Enter a new one only if you want
                    to replace it.
                  </p>
                ) : null}
              </label>
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => void handleTestMasterConnection()}
                  disabled={testingMasterConnection}
                  className="rounded-lg border border-primary/40 bg-primary/15 px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/25 disabled:opacity-50"
                >
                  {testingMasterConnection ? "Testing…" : "Test connection"}
                </button>
                {masterConnectionMessage ? (
                  <p
                    className={`text-xs ${
                      masterConnectionMessage.startsWith("Connected")
                        ? "text-emerald-300"
                        : "text-red-300"
                    }`}
                  >
                    {masterConnectionMessage}
                  </p>
                ) : null}
              </div>
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
                    When enabled, new subscribers immediately mirror open
                    positions from the master Delta account (late-join).
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
                <span className="text-xs font-medium text-white/60">
                  Profit share (%)
                </span>
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
                <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-white/[0.08] bg-black/20 px-3 py-3">
                  <input
                    type="checkbox"
                    checked={hedgeAutoEnabled}
                    onChange={(e) => setHedgeAutoEnabled(e.target.checked)}
                    className="mt-0.5 h-4 w-4 shrink-0 rounded border-glassBorder text-cyan-400 focus:ring-cyan-500/40"
                  />
                  <span>
                    <span className="text-sm font-medium text-white">
                      Auto enable
                    </span>
                    <span className="mt-0.5 block text-xs text-white/50">
                      When on, the hedge engine may enter and adjust positions
                      automatically.
                    </span>
                  </span>
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="text-xs font-medium text-white/60">
                      Base lots
                    </span>
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
                    <span className="text-xs font-medium text-white/60">
                      EMA period
                    </span>
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
                    <span className="text-xs font-medium text-white/60">
                      Adjustment %
                    </span>
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
                Stored as JSON for charts: P&amp;L line, backtest summary,
                profit/loss bars, and calendar heatmap.
              </p>

              <details className="group rounded-lg border border-white/10 bg-black/20 p-3">
                <summary className="cursor-pointer text-xs font-medium text-white/80">
                  P&amp;L chart (line) — labels &amp; values
                </summary>
                <label className="mt-2 block">
                  <span className="text-xs font-medium text-white/60">Labels</span>
                  <input
                    type="text"
                    value={pnlLabels}
                    onChange={(e) => setPnlLabels(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40"
                  />
                </label>
                <label className="mt-2 block">
                  <span className="text-xs font-medium text-white/60">Values</span>
                  <input
                    type="text"
                    value={pnlValues}
                    onChange={(e) => setPnlValues(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40"
                  />
                </label>
              </details>

              <details className="group rounded-lg border border-white/10 bg-black/20 p-3">
                <summary className="cursor-pointer text-xs font-medium text-white/80">
                  Backtest summary
                </summary>
                <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {(
                    [
                      ["Trading days", tradingDays, setTradingDays],
                      ["Win / Loss %", winLossPercent, setWinLossPercent],
                      ["Streak", streak, setStreak],
                      ["Avg per day", avgPerDay, setAvgPerDay],
                      ["Max drawdown", maxDrawdown, setMaxDrawdown],
                    ] as const
                  ).map(([label, value, setter]) => (
                    <label key={label} className="block">
                      <span className="text-xs font-medium text-white/60">
                        {label}
                      </span>
                      <input
                        type="number"
                        step="any"
                        value={value}
                        onChange={(e) => setter(e.target.value)}
                        className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40"
                      />
                    </label>
                  ))}
                </div>
              </details>

              <details className="group rounded-lg border border-white/10 bg-black/20 p-3">
                <summary className="cursor-pointer text-xs font-medium text-white/80">
                  Max profit &amp; loss (bar chart)
                </summary>
                <label className="mt-2 block">
                  <span className="text-xs font-medium text-white/60">
                    Bar labels
                  </span>
                  <input
                    type="text"
                    value={barLabels}
                    onChange={(e) => setBarLabels(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40"
                  />
                </label>
                <label className="mt-2 block">
                  <span className="text-xs font-medium text-white/60">
                    Profit values
                  </span>
                  <input
                    type="text"
                    value={barProfit}
                    onChange={(e) => setBarProfit(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40"
                  />
                </label>
                <label className="mt-2 block">
                  <span className="text-xs font-medium text-white/60">
                    Loss values
                  </span>
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
                <textarea
                  value={heatmapText}
                  onChange={(e) => setHeatmapText(e.target.value)}
                  rows={6}
                  className="mt-2 w-full resize-y rounded-lg border border-glassBorder bg-black/40 px-3 py-2 font-mono text-xs text-white outline-none focus:ring-2 focus:ring-primary/40"
                />
              </details>

              <label className="block">
                <span className="text-xs font-medium text-amber-200/90">
                  Full JSON override (optional)
                </span>
                <textarea
                  value={performanceJsonOverride}
                  onChange={(e) => setPerformanceJsonOverride(e.target.value)}
                  rows={5}
                  className="mt-2 w-full resize-y rounded-lg border border-amber-500/30 bg-black/40 px-3 py-2 font-mono text-xs text-white outline-none focus:ring-2 focus:ring-amber-500/40"
                />
              </label>
            </div>

            <div className="flex justify-end gap-3 border-t border-white/10 pt-4">
              <Link
                href="/admin/strategies"
                className="rounded-lg px-4 py-2 text-sm font-medium text-white/70 transition hover:bg-white/10"
              >
                Cancel
              </Link>
              <button
                type="submit"
                disabled={submitting}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white shadow-lg shadow-primary/20 disabled:opacity-50"
              >
                {submitting ? "Saving…" : "Save changes"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
