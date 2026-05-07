"use client";

import { Loader2, Play, Pause, Pencil, Trash2, Sparkles, Layers } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

const ENV_API_BASE = process.env.NEXT_PUBLIC_API_URL?.trim().replace(/\/$/, "") ?? "";
function resolveApiBase(): string {
  if (ENV_API_BASE) return ENV_API_BASE;
  if (typeof window !== "undefined") return `${window.location.origin.replace(/\/$/, "")}/api`;
  return "";
}

type Strategy = {
  id: string;
  title: string;
  description: string;
  monthlyFee: number;
  minCapital: number;
  profitShare: number;
};
type ExchangeAccountOption = { id: string; nickname: string; exchange: string };
type SubscriptionRow = {
  id: string;
  status: string;
  multiplier: number;
  joinedDate: string;
  strategy: Strategy;
  exchangeAccount: ExchangeAccountOption | null;
};
type Tab = "marketplace" | "my";
type ModalState =
  | { kind: "deploy"; sub: SubscriptionRow }
  | { kind: "modify"; sub: SubscriptionRow }
  | null;

function pausedLike(status: string): boolean {
  return status.toUpperCase() !== "ACTIVE";
}
function badge(status: string): string {
  return pausedLike(status)
    ? "border-amber-500/40 bg-amber-500/15 text-amber-100"
    : "border-emerald-500/40 bg-emerald-500/15 text-emerald-200";
}
function statusLabel(status: string): string {
  return pausedLike(status) ? "Inactive" : "Deployed";
}
function clampMultiplier(v: number): number {
  return Math.min(10, Math.max(0.1, Math.round(v * 10) / 10));
}

export default function StrategySubscriptionLifecyclePage() {
  const apiBase = useMemo(resolveApiBase, []);
  const [tab, setTab] = useState<Tab>("marketplace");
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [subs, setSubs] = useState<SubscriptionRow[]>([]);
  const [accounts, setAccounts] = useState<ExchangeAccountOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>(null);
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [multiplier, setMultiplier] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") ?? "" : "";
  const authHeaders = useMemo(
    () => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    }),
    [token],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [sRes, subRes, exRes] = await Promise.all([
        fetch(`${apiBase}/subscriptions/strategies`, { headers: authHeaders }),
        fetch(`${apiBase}/subscriptions/mine`, { headers: authHeaders }),
        fetch(`${apiBase}/exchange-accounts`, { headers: authHeaders }),
      ]);
      if (!sRes.ok || !subRes.ok || !exRes.ok) throw new Error("Failed to load subscription lifecycle data.");
      setStrategies((await sRes.json()) as Strategy[]);
      const subJson = (await subRes.json()) as { subscriptions?: SubscriptionRow[] };
      setSubs(subJson.subscriptions ?? []);
      const exJson = (await exRes.json()) as { accounts?: ExchangeAccountOption[] };
      setAccounts(exJson.accounts ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [apiBase, authHeaders]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2400);
    return () => clearTimeout(t);
  }, [toast]);

  const subsByStrategy = useMemo(() => new Map(subs.map((s) => [s.strategy.id, s])), [subs]);

  async function post(path: string, body?: unknown) {
    const res = await fetch(`${apiBase}${path}`, {
      method: "POST",
      headers: authHeaders,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const payload = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(payload.error ?? `Request failed (${res.status})`);
    return payload;
  }
  async function patch(path: string, body?: unknown) {
    const res = await fetch(`${apiBase}${path}`, {
      method: "PATCH",
      headers: authHeaders,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const payload = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(payload.error ?? `Request failed (${res.status})`);
    return payload;
  }
  async function remove(path: string) {
    const res = await fetch(`${apiBase}${path}`, { method: "DELETE", headers: authHeaders });
    if (!res.ok && res.status !== 204) {
      const payload = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(payload.error ?? `Request failed (${res.status})`);
    }
  }

  async function addToMyStrategies(strategyId: string) {
    setSubmitting(true);
    try {
      await post("/subscriptions/subscribe", { strategyId });
      setToast("Added to My Strategies");
      setTab("my");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to subscribe");
    } finally {
      setSubmitting(false);
    }
  }

  function openDeploy(sub: SubscriptionRow) {
    setMultiplier(clampMultiplier(sub.multiplier || 1));
    setSelectedAccountId(sub.exchangeAccount?.id ?? accounts[0]?.id ?? "");
    setModal({ kind: "deploy", sub });
  }
  function openModify(sub: SubscriptionRow) {
    setMultiplier(clampMultiplier(sub.multiplier || 1));
    setModal({ kind: "modify", sub });
  }

  async function submitModal() {
    if (!modal) return;
    setSubmitting(true);
    try {
      if (modal.kind === "deploy") {
        await post(`/subscriptions/${modal.sub.strategy.id}/deploy`, {
          multiplier: clampMultiplier(multiplier),
          exchangeAccountId: selectedAccountId,
        });
        setToast("Strategy deployed");
      } else {
        await patch(`/subscriptions/${modal.sub.strategy.id}/modify`, {
          multiplier: clampMultiplier(multiplier),
        });
        setToast("Multiplier updated");
      }
      setModal(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setSubmitting(false);
    }
  }

  async function pauseOrResume(sub: SubscriptionRow) {
    setSubmitting(true);
    try {
      if (pausedLike(sub.status)) {
        await patch(`/subscriptions/${sub.strategy.id}/resume`);
        setToast("Strategy resumed");
      } else {
        await patch(`/subscriptions/${sub.strategy.id}/pause`);
        setToast("Strategy paused");
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setSubmitting(false);
    }
  }

  async function removeSubscription(sub: SubscriptionRow) {
    setSubmitting(true);
    try {
      await remove(`/subscriptions/${sub.strategy.id}/remove`);
      setToast("Strategy removed");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Remove failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-white md:text-3xl">Subscription Lifecycle</h1>
        <p className="mt-2 text-sm text-white/55">
          Professional workflow: Add strategy (inactive), then Deploy with multiplier and account.
        </p>
        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={() => setTab("marketplace")}
            className={`rounded-lg px-4 py-2 text-sm font-medium ${tab === "marketplace" ? "bg-primary text-white" : "bg-white/10 text-white/70"}`}
          >
            <Sparkles className="mr-2 inline h-4 w-4" />
            Marketplace
          </button>
          <button
            type="button"
            onClick={() => setTab("my")}
            className={`rounded-lg px-4 py-2 text-sm font-medium ${tab === "my" ? "bg-primary text-white" : "bg-white/10 text-white/70"}`}
          >
            <Layers className="mr-2 inline h-4 w-4" />
            My Strategies
          </button>
        </div>
      </header>

      {error && <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">{error}</div>}
      {loading ? (
        <div className="py-20 text-center text-white/55"><Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" /></div>
      ) : tab === "marketplace" ? (
        <div className="grid gap-4 md:grid-cols-2">
          {strategies.map((s) => {
            const existing = subsByStrategy.get(s.id);
            return (
              <article key={s.id} className="glass-card border border-glassBorder p-5">
                <h3 className="text-lg font-semibold text-white">{s.title}</h3>
                <p className="mt-2 text-sm text-white/60">{s.description}</p>
                <div className="mt-4 text-xs text-white/50">
                  ₹{s.monthlyFee.toLocaleString("en-IN")} / month · Profit share {s.profitShare}% · Min capital ₹
                  {s.minCapital.toLocaleString("en-IN")}
                </div>
                <div className="mt-5">
                  {existing ? (
                    <button
                      type="button"
                      onClick={() => setTab("my")}
                      className="rounded-lg bg-white/10 px-4 py-2 text-sm font-medium text-white/80"
                    >
                      Already in My Strategies
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={submitting}
                      onClick={() => void addToMyStrategies(s.id)}
                      className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
                    >
                      Subscribe
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {subs.length === 0 ? (
            <div className="rounded-xl border border-white/10 bg-white/[0.03] px-6 py-10 text-center text-sm text-white/55">
              No strategies added yet.
            </div>
          ) : (
            subs.map((sub) => {
              const isPaused = pausedLike(sub.status);
              const configured = Boolean(sub.exchangeAccount);
              return (
                <article key={sub.id} className="glass-card border border-glassBorder p-5">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-lg font-semibold text-white">{sub.strategy.title}</h3>
                    <span className={`rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${badge(sub.status)}`}>
                      {statusLabel(sub.status)}
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-white/60">{sub.strategy.description}</p>
                  <p className="mt-3 text-xs text-white/45">
                    Multiplier: <span className="tabular-nums">{sub.multiplier}x</span>{" "}
                    {sub.exchangeAccount ? `· Account: ${sub.exchangeAccount.nickname}` : "· Not configured"}
                  </p>

                  <div className="mt-5 flex flex-wrap gap-2">
                    {isPaused && !configured ? (
                      <button type="button" onClick={() => openDeploy(sub)} className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white">
                        Deploy
                      </button>
                    ) : (
                      <>
                        <button type="button" onClick={() => openModify(sub)} className="rounded-lg bg-white/10 px-3 py-2 text-sm text-white/85">
                          <Pencil className="mr-1 inline h-4 w-4" />
                          Modify
                        </button>
                        <button type="button" onClick={() => void pauseOrResume(sub)} className="rounded-lg bg-white/10 px-3 py-2 text-sm text-white/85">
                          {isPaused ? <Play className="mr-1 inline h-4 w-4" /> : <Pause className="mr-1 inline h-4 w-4" />}
                          {isPaused ? "Resume" : "Pause"}
                        </button>
                      </>
                    )}
                    <button type="button" onClick={() => void removeSubscription(sub)} className="rounded-lg bg-red-500/20 px-3 py-2 text-sm text-red-100">
                      <Trash2 className="mr-1 inline h-4 w-4" />
                      Remove
                    </button>
                  </div>
                </article>
              );
            })
          )}
        </div>
      )}

      {modal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="glass-card w-full max-w-md border border-glassBorder p-6">
            <h2 className="text-lg font-semibold text-white">
              {modal.kind === "deploy" ? "Deploy Strategy" : "Modify Multiplier"}
            </h2>
            <p className="mt-2 text-sm text-white/60">{modal.sub.strategy.title}</p>
            {modal.kind === "deploy" && (
              <label className="mt-4 block">
                <span className="text-xs text-white/60">Exchange Account</span>
                <select
                  value={selectedAccountId}
                  onChange={(e) => setSelectedAccountId(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white"
                >
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.nickname} ({a.exchange})
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="mt-4 block">
              <span className="text-xs text-white/60">Multiplier</span>
              <input
                type="number"
                min={0.1}
                max={10}
                step={0.1}
                value={multiplier}
                onChange={(e) => setMultiplier(clampMultiplier(Number(e.target.value)))}
                className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white"
              />
            </label>
            <div className="mt-6 flex justify-end gap-2">
              <button type="button" onClick={() => setModal(null)} className="rounded-lg px-4 py-2 text-sm text-white/70">
                Cancel
              </button>
              <button
                type="button"
                disabled={submitting}
                onClick={() => void submitModal()}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
              >
                {submitting ? "Saving..." : modal.kind === "deploy" ? "Deploy" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2">
          <div className="glass-card border border-emerald-500/40 bg-emerald-500/15 px-5 py-3 text-center text-sm text-emerald-100">
            {toast}
          </div>
        </div>
      )}
    </div>
  );
}
