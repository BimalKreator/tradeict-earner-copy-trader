"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  adminApiBase,
  adminAuthHeaders,
  buildPerformanceMetrics,
  isFutureHedgeStrategy,
  testMasterDeltaConnection,
  type Strategy,
} from "@/lib/adminStrategyForm";

export default function AdminStrategiesPage() {
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
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

  const [syncToast, setSyncToast] = useState<{
    kind: "ok" | "err";
    text: string;
  } | null>(null);
  const [forceSyncingId, setForceSyncingId] = useState<string | null>(null);

  const loadStrategies = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const base = adminApiBase();
      const res = await fetch(`${base}/admin/strategies`, {
        headers: adminAuthHeaders(),
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
    void loadStrategies();
  }, [loadStrategies]);

  useEffect(() => {
    if (!syncToast) return;
    const t = window.setTimeout(() => setSyncToast(null), 6000);
    return () => window.clearTimeout(t);
  }, [syncToast]);

  function resetCreateForm() {
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
  }

  function openCreateModal() {
    resetCreateForm();
    setFormError(null);
    setMasterConnectionMessage(null);
    setModalOpen(true);
  }

  async function handleTestMasterConnection() {
    if (!masterApiKey.trim() || !masterApiSecret.trim()) {
      setMasterConnectionMessage(
        "Enter both API key and secret before testing.",
      );
      return;
    }
    setTestingMasterConnection(true);
    setMasterConnectionMessage(null);
    try {
      const result = await testMasterDeltaConnection({
        masterApiKey: masterApiKey.trim(),
        masterApiSecret: masterApiSecret.trim(),
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

  async function handleForceSync(s: Strategy) {
    setForceSyncingId(s.id);
    setSyncToast(null);
    try {
      const base = adminApiBase();
      const res = await fetch(
        `${base}/admin/strategies/${encodeURIComponent(s.id)}/force-sync`,
        {
          method: "POST",
          headers: adminAuthHeaders(),
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

  async function handleCreateStrategy(e: React.FormEvent) {
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
      masterApiKey,
      masterApiSecret,
      slippage: slippageNum,
      monthlyFee: monthlyFeeNum,
      profitShare: profitShareNum,
      minCapital: minCapitalNum,
      syncActiveTrades,
    };

    if (performanceMetrics !== undefined) {
      payload.performanceMetrics = performanceMetrics;
    }

    try {
      const base = adminApiBase();
      const res = await fetch(`${base}/admin/strategies`, {
        method: "POST",
        headers: adminAuthHeaders(),
        body: JSON.stringify(payload),
      });
      const body: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg =
          typeof body === "object" &&
          body !== null &&
          "error" in body &&
          typeof (body as { error?: unknown }).error === "string"
            ? (body as { error: string }).error
            : `Create failed (${res.status})`;
        throw new Error(msg);
      }
      setModalOpen(false);
      resetCreateForm();
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
            Delta-to-Delta copy trading: set the leader&apos;s Delta Exchange
            (India) API credentials per strategy. Subscribers mirror fills using
            their own linked Delta accounts.
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
                <th className="px-4 py-3 font-medium text-white/70">
                  Description
                </th>
                <th className="px-4 py-3 font-medium text-white/70">Slippage</th>
                <th className="px-4 py-3 font-medium text-white/70">
                  Monthly fee
                </th>
                <th className="px-4 py-3 font-medium text-white/70">Profit %</th>
                <th className="px-4 py-3 font-medium text-white/70">
                  Min capital
                </th>
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
                    <td className="px-4 py-3 tabular-nums text-white/80">
                      {s.slippage}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-white/80">
                      {s.monthlyFee}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-white/80">
                      {s.profitShare}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-white/80">
                      {s.minCapital}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-white/55">
                      {new Date(s.createdAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link
                          href={`/admin/strategies/${s.id}`}
                          className="rounded-lg border border-glassBorder bg-white/[0.06] px-3 py-1.5 text-xs font-medium text-primary transition hover:bg-white/10"
                        >
                          Edit
                        </Link>
                        <button
                          type="button"
                          disabled={forceSyncingId === s.id}
                          onClick={() => void handleForceSync(s)}
                          className="rounded-lg border border-amber-500/35 bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-100 transition hover:bg-amber-500/15 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {forceSyncingId === s.id
                            ? "Syncing…"
                            : "Force sync trades"}
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
          aria-labelledby="strategy-create-title"
        >
          <div className="glass-card my-8 w-full max-w-2xl border border-glassBorder p-6 shadow-2xl">
            <h2
              id="strategy-create-title"
              className="text-lg font-semibold text-white"
            >
              Add strategy
            </h2>
            <p className="mt-1 text-sm text-white/50">
              Leader credentials use{" "}
              <span className="text-white/70">masterApiKey</span> /{" "}
              <span className="text-white/70">masterApiSecret</span> against the
              Delta India API. Performance metrics below power product charts.
            </p>

            <form
              onSubmit={handleCreateStrategy}
              className="mt-6 max-h-[calc(100vh-8rem)] space-y-6 overflow-y-auto pr-1"
            >
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

              <div className="space-y-4 rounded-xl border border-primary/25 bg-primary/[0.06] p-4">
                <h3 className="text-sm font-semibold text-primary">
                  Master Delta API
                </h3>
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
                    required
                    autoComplete="new-password"
                    value={masterApiSecret}
                    onChange={(e) => setMasterApiSecret(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40"
                  />
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
                      positions from the master Delta account.
                    </span>
                  </span>
                </label>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="text-xs font-medium text-white/60">
                    Slippage
                  </span>
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
                  <span className="text-xs font-medium text-white/60">
                    Monthly fee
                  </span>
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
                  <span className="text-xs font-medium text-white/60">
                    Min capital
                  </span>
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
                <p className="rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-100">
                  Future Hedge settings can be configured after creation on the
                  edit page.
                </p>
              ) : null}

              <div className="space-y-4 rounded-xl border border-glassBorder bg-white/[0.03] p-4">
                <h3 className="text-sm font-semibold text-white">
                  Performance data (optional)
                </h3>
                <details className="rounded-lg border border-white/10 bg-black/20 p-3">
                  <summary className="cursor-pointer text-xs font-medium text-white/80">
                    P&amp;L chart
                  </summary>
                  <label className="mt-2 block">
                    <span className="text-xs font-medium text-white/60">
                      Labels
                    </span>
                    <input
                      type="text"
                      value={pnlLabels}
                      onChange={(e) => setPnlLabels(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40"
                    />
                  </label>
                  <label className="mt-2 block">
                    <span className="text-xs font-medium text-white/60">
                      Values
                    </span>
                    <input
                      type="text"
                      value={pnlValues}
                      onChange={(e) => setPnlValues(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40"
                    />
                  </label>
                </details>
                <label className="block">
                  <span className="text-xs font-medium text-amber-200/90">
                    Full JSON override (optional)
                  </span>
                  <textarea
                    value={performanceJsonOverride}
                    onChange={(e) => setPerformanceJsonOverride(e.target.value)}
                    rows={4}
                    className="mt-2 w-full resize-y rounded-lg border border-amber-500/30 bg-black/40 px-3 py-2 font-mono text-xs text-white outline-none focus:ring-2 focus:ring-amber-500/40"
                  />
                </label>
              </div>

              <div className="flex justify-end gap-3 border-t border-white/10 pt-4">
                <button
                  type="button"
                  onClick={() => {
                    setModalOpen(false);
                    resetCreateForm();
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
                  {submitting ? "Creating…" : "Create strategy"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
