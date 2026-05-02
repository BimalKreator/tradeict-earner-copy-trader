"use client";

import { useCallback, useEffect, useState } from "react";

const API_BASE = "http://localhost:5000/api/admin";

type Strategy = {
  id: string;
  title: string;
  description: string;
  cosmicApiKey: string;
  slippage: number;
  monthlyFee: number;
  profitShare: number;
  minCapital: number;
  createdAt: string;
};

export default function AdminStrategiesPage() {
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [cosmicApiKey, setCosmicApiKey] = useState("");
  const [slippage, setSlippage] = useState("0.5");
  const [monthlyFee, setMonthlyFee] = useState("");
  const [profitShare, setProfitShare] = useState("20");
  const [minCapital, setMinCapital] = useState("");

  const loadStrategies = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/strategies`);
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

    try {
      const res = await fetch(`${API_BASE}/strategies`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          description,
          cosmicApiKey,
          slippage: slippageNum,
          monthlyFee: monthlyFeeNum,
          profitShare: profitShareNum,
          minCapital: minCapitalNum,
        }),
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
      setTitle("");
      setDescription("");
      setCosmicApiKey("");
      setSlippage("0.5");
      setMonthlyFee("");
      setProfitShare("20");
      setMinCapital("");
      await loadStrategies();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Create failed");
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
            Copy-trading strategies from the admin API.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setFormError(null);
            setModalOpen(true);
          }}
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

      <div className="glass-card border border-glassBorder overflow-hidden">
        <div className="scroll-table overflow-x-auto">
          <table className="w-full min-w-[960px] text-left text-sm">
            <thead className="border-b border-glassBorder bg-white/[0.03]">
              <tr>
                <th className="px-4 py-3 font-medium text-white/70">Title</th>
                <th className="px-4 py-3 font-medium text-white/70">Description</th>
                <th className="px-4 py-3 font-medium text-white/70">Slippage</th>
                <th className="px-4 py-3 font-medium text-white/70">Monthly fee</th>
                <th className="px-4 py-3 font-medium text-white/70">Profit %</th>
                <th className="px-4 py-3 font-medium text-white/70">Min capital</th>
                <th className="px-4 py-3 font-medium text-white/70">Created</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-white/45">
                    Loading strategies…
                  </td>
                </tr>
              ) : strategies.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-white/45">
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
                    <td className="max-w-[220px] truncate px-4 py-3 text-white/70">
                      {s.description}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-white/80">{s.slippage}</td>
                    <td className="px-4 py-3 tabular-nums text-white/80">{s.monthlyFee}</td>
                    <td className="px-4 py-3 tabular-nums text-white/80">{s.profitShare}</td>
                    <td className="px-4 py-3 tabular-nums text-white/80">{s.minCapital}</td>
                    <td className="px-4 py-3 text-white/55 tabular-nums">
                      {new Date(s.createdAt).toLocaleString()}
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
          aria-labelledby="add-strategy-title"
        >
          <div className="glass-card my-8 w-full max-w-lg border border-glassBorder p-6 shadow-2xl">
            <h2 id="add-strategy-title" className="text-lg font-semibold text-white">
              Add strategy
            </h2>
            <p className="mt-1 text-sm text-white/50">
              POST /api/admin/strategies — all fields required by the API.
            </p>

            <form onSubmit={handleCreateStrategy} className="mt-6 space-y-4">
              {formError && (
                <p className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                  {formError}
                </p>
              )}
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
              <label className="block">
                <span className="text-xs font-medium text-white/60">Cosmic API key</span>
                <input
                  type="text"
                  required
                  value={cosmicApiKey}
                  onChange={(e) => setCosmicApiKey(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40"
                />
              </label>
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
              </div>
              <div className="grid grid-cols-2 gap-3">
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
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
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
