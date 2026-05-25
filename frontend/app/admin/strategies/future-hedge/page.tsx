"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  GitBranch,
  Loader2,
  Save,
  Shield,
  ToggleLeft,
  ToggleRight,
} from "lucide-react";

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL?.trim().replace(/\/$/, "") ?? "";

type FutureHedgeConfig = {
  id: string;
  strategyId: string;
  isAutoEnabled: boolean;
  baseLots: number;
  emaPeriod: number;
  adjustmentPct: number;
  targetProfitUsd: number;
  currentBatchId: string | null;
  lastEntryPrice: number | null;
  updatedAt: string;
};

type Payload = {
  strategy: { id: string; title: string; description: string };
  config: FutureHedgeConfig;
};

export default function FutureHedgeStrategyPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [strategyId, setStrategyId] = useState("");
  const [strategyTitle, setStrategyTitle] = useState("Future Hedge Strategy");

  const [isAutoEnabled, setIsAutoEnabled] = useState(false);
  const [baseLots, setBaseLots] = useState("1");
  const [emaPeriod, setEmaPeriod] = useState("200");
  const [adjustmentPct, setAdjustmentPct] = useState("0.5");
  const [targetProfitUsd, setTargetProfitUsd] = useState("10");
  const [currentBatchId, setCurrentBatchId] = useState("");
  const [lastEntryPrice, setLastEntryPrice] = useState<string>("");
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;

  const applyPayload = useCallback((data: Payload) => {
    setStrategyId(data.strategy.id);
    setStrategyTitle(data.strategy.title);
    setIsAutoEnabled(data.config.isAutoEnabled);
    setBaseLots(String(data.config.baseLots));
    setEmaPeriod(String(data.config.emaPeriod));
    setAdjustmentPct(String(data.config.adjustmentPct));
    setTargetProfitUsd(String(data.config.targetProfitUsd));
    setCurrentBatchId(data.config.currentBatchId ?? "");
    setLastEntryPrice(
      data.config.lastEntryPrice != null
        ? String(data.config.lastEntryPrice)
        : "",
    );
    setLastUpdated(data.config.updatedAt);
  }, []);

  const load = useCallback(async () => {
    if (!token) {
      setError("Admin login required.");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/admin/strategies/future-hedge`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Failed to load (${res.status})`);
      }
      applyPayload((await res.json()) as Payload);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load configuration");
    } finally {
      setLoading(false);
    }
  }, [token, applyPayload]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;

    const lots = Number.parseInt(baseLots, 10);
    const ema = Number.parseInt(emaPeriod, 10);
    const adj = Number.parseFloat(adjustmentPct);
    const target = Number.parseFloat(targetProfitUsd);

    if (!Number.isInteger(lots) || lots < 1) {
      setError("Base lots must be an integer of at least 1.");
      return;
    }
    if (!Number.isInteger(ema) || ema < 1) {
      setError("EMA period must be an integer of at least 1.");
      return;
    }
    if (!Number.isFinite(adj) || adj <= 0 || adj > 100) {
      setError("Adjustment % must be between 0 and 100.");
      return;
    }
    if (!Number.isFinite(target) || target <= 0) {
      setError("Target profit must be a positive USD amount.");
      return;
    }

    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch(`${API_BASE}/admin/strategies/future-hedge`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          isAutoEnabled,
          baseLots: lots,
          emaPeriod: ema,
          adjustmentPct: adj,
          targetProfitUsd: target,
          currentBatchId: currentBatchId.trim() || null,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
      } & Partial<Payload>;
      if (!res.ok) throw new Error(body.error ?? "Save failed");
      if (body.config && body.strategy) {
        applyPayload(body as Payload);
      } else {
        await load();
      }
      setSuccess("Future Hedge configuration saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function toggleAutomation(): Promise<void> {
    const next = !isAutoEnabled;
    setIsAutoEnabled(next);
    if (!token) return;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch(`${API_BASE}/admin/strategies/future-hedge`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ isAutoEnabled: next }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
      } & Partial<Payload>;
      if (!res.ok) {
        setIsAutoEnabled(!next);
        throw new Error(body.error ?? "Toggle failed");
      }
      if (body.config) {
        setIsAutoEnabled(body.config.isAutoEnabled);
        setLastUpdated(body.config.updatedAt);
      }
      setSuccess(
        next
          ? "Automated Future Hedge script enabled."
          : "Automated Future Hedge script disabled.",
      );
    } catch (e) {
      setIsAutoEnabled(!next);
      setError(e instanceof Error ? e.message : "Toggle failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="rounded-xl border border-slate-800 bg-slate-900 p-3">
            <GitBranch className="h-6 w-6 text-cyan-400" aria-hidden />
          </div>
          <div>
            <h1 className="text-2xl font-semibold text-white">
              {strategyTitle}
            </h1>
            <p className="mt-1 text-sm text-slate-400">
              Phase 1 automation parameters (EMA hedge batches).
            </p>
            {strategyId && (
              <p className="mt-1 font-mono text-xs text-slate-500">
                Strategy ID: {strategyId}
              </p>
            )}
          </div>
        </div>
        <Link
          href="/admin/strategies"
          className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800"
        >
          All strategies
        </Link>
      </header>

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}
      {success && (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
          {success}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-20 text-slate-500">
          <Loader2 className="h-6 w-6 animate-spin" />
          Loading configuration…
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between rounded-2xl border border-slate-800 bg-slate-900/80 p-5 shadow-lg">
            <div className="flex items-start gap-3">
              <Shield className="mt-0.5 h-5 w-5 text-cyan-400" aria-hidden />
              <div>
                <p className="font-medium text-white">Automation master switch</p>
                <p className="mt-1 text-sm text-slate-400">
                  When enabled, the hedge script may place and adjust positions per
                  these rules.
                </p>
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={isAutoEnabled}
              disabled={saving}
              onClick={() => void toggleAutomation()}
              className="shrink-0 text-cyan-400 transition hover:text-cyan-300 disabled:opacity-50"
              aria-label={
                isAutoEnabled ? "Disable automation" : "Enable automation"
              }
            >
              {isAutoEnabled ? (
                <ToggleRight className="h-10 w-10" />
              ) : (
                <ToggleLeft className="h-10 w-10 text-slate-500" />
              )}
            </button>
          </div>

          <form
            onSubmit={(e) => void handleSave(e)}
            className="space-y-5 rounded-2xl border border-slate-800 bg-slate-900/60 p-6"
          >
            <h2 className="text-lg font-semibold text-white">Parameters</h2>

            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block text-sm text-slate-300">
                Base lots
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={baseLots}
                  onChange={(e) => setBaseLots(e.target.value)}
                  className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-white outline-none focus:ring-2 focus:ring-cyan-500/40"
                />
                <span className="mt-1 block text-xs text-slate-500">
                  Starting contract size per leg.
                </span>
              </label>

              <label className="block text-sm text-slate-300">
                EMA period
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={emaPeriod}
                  onChange={(e) => setEmaPeriod(e.target.value)}
                  className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-white outline-none focus:ring-2 focus:ring-cyan-500/40"
                />
                <span className="mt-1 block text-xs text-slate-500">
                  Lookback candles for the signal EMA.
                </span>
              </label>

              <label className="block text-sm text-slate-300">
                Adjustment %
                <input
                  type="number"
                  min={0.01}
                  max={100}
                  step={0.01}
                  value={adjustmentPct}
                  onChange={(e) => setAdjustmentPct(e.target.value)}
                  className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-white outline-none focus:ring-2 focus:ring-cyan-500/40"
                />
                <span className="mt-1 block text-xs text-slate-500">
                  Lot increase per batch step (e.g. 0.5 = 50%).
                </span>
              </label>

              <label className="block text-sm text-slate-300">
                Target profit (USD)
                <input
                  type="number"
                  min={0.01}
                  step={0.01}
                  value={targetProfitUsd}
                  onChange={(e) => setTargetProfitUsd(e.target.value)}
                  className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-white outline-none focus:ring-2 focus:ring-cyan-500/40"
                />
                <span className="mt-1 block text-xs text-slate-500">
                  Close batch when unrealized PnL reaches this level.
                </span>
              </label>
            </div>

            <label className="block text-sm text-slate-300">
              Current batch ID
              <input
                type="text"
                value={currentBatchId}
                onChange={(e) => setCurrentBatchId(e.target.value)}
                placeholder="Leave empty when no active batch"
                className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 font-mono text-sm text-white outline-none focus:ring-2 focus:ring-cyan-500/40"
              />
              <span className="mt-1 block text-xs text-slate-500">
                Groups related adjustments; clear when a batch completes.
              </span>
            </label>

            <label className="block text-sm text-slate-300">
              Last entry price (USD)
              <input
                type="text"
                readOnly
                value={lastEntryPrice}
                placeholder="Set automatically on batch open"
                className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950/80 px-3 py-2.5 text-slate-300 outline-none"
              />
            </label>

            {lastUpdated && (
              <p className="text-xs text-slate-500">
                Last saved: {new Date(lastUpdated).toLocaleString()}
              </p>
            )}

            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-2 rounded-lg bg-cyan-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-cyan-500 disabled:opacity-50"
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              Save configuration
            </button>
          </form>
        </>
      )}
    </div>
  );
}
