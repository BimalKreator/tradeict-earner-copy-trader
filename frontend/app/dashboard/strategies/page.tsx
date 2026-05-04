"use client";

import {
  Eye,
  History,
  LineChart,
  Loader2,
  Sparkles,
  TrendingUp,
  Wallet,
  Zap,
  X,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

const ENV_API_BASE =
  process.env.NEXT_PUBLIC_API_URL?.trim().replace(/\/$/, "") ?? "";

function resolveApiBase(): string {
  if (ENV_API_BASE) return ENV_API_BASE;
  if (typeof window !== "undefined") {
    return `${window.location.origin.replace(/\/$/, "")}/api`;
  }
  return "";
}

type StrategyListItem = {
  id: string;
  title: string;
  description: string;
  monthlyFee: number;
  minCapital: number;
  profitShare: number;
  slippage: number;
  performanceMetrics: unknown;
  createdAt: string;
};

type ExchangeAccountOption = {
  id: string;
  nickname: string;
  exchange: string;
};

type SubscriptionRow = {
  id: string;
  status: string;
  multiplier: number;
  joinedDate: string;
  strategy: StrategyListItem;
  exchangeAccount: {
    id: string;
    nickname: string;
    exchange: string;
  } | null;
};

type StrategiesTab = "marketplace" | "my" | "active";

const ACCENTS = [
  "from-sky-500/25 to-transparent",
  "from-violet-500/25 to-transparent",
  "from-emerald-500/20 to-transparent",
  "from-amber-500/20 to-transparent",
  "from-rose-500/20 to-transparent",
  "from-cyan-500/20 to-transparent",
] as const;

function accentForId(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return ACCENTS[Math.abs(h) % ACCENTS.length] ?? ACCENTS[0]!;
}

type PnlMetrics = { pnlChart?: { labels?: string[]; values?: number[] } };

function pnlValuesToSparklinePoints(pm: unknown): string {
  if (!pm || typeof pm !== "object") return "0,50 100,50";
  const pnl = (pm as PnlMetrics).pnlChart;
  const values = Array.isArray(pnl?.values) ? pnl.values! : [];
  if (values.length === 0) return "0,50 100,50";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  return values
    .map((v, i) => {
      const x = (i / Math.max(values.length - 1, 1)) * 100;
      const y = 100 - ((v - min) / range) * 80 - 10;
      return `${x},${y}`;
    })
    .join(" ");
}

function clampMultiplier(n: number): number {
  const rounded = Math.round(n * 10) / 10;
  return Math.min(10, Math.max(0.1, rounded));
}

function PnlChartPlaceholder({
  points,
  gradientId,
  hasData,
}: {
  points: string;
  gradientId: string;
  hasData: boolean;
}) {
  return (
    <div className="relative mt-5 h-36 overflow-hidden rounded-xl border border-white/[0.08] bg-black/35">
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.35]"
        style={{
          backgroundImage:
            "linear-gradient(to right, rgba(255,255,255,0.06) 1px, transparent 1px)",
          backgroundSize: "14px 100%",
        }}
      />
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.2]"
        style={{
          backgroundImage:
            "linear-gradient(to top, rgba(255,255,255,0.07) 1px, transparent 1px)",
          backgroundSize: "100% 18px",
        }}
      />
      <svg
        className="relative h-full w-full"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden
      >
        <defs>
          <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="rgb(10 132 255)" stopOpacity="0.35" />
            <stop offset="100%" stopColor="rgb(10 132 255)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon
          fill={`url(#${gradientId})`}
          points={`${points} 100,100 0,100`}
          className="opacity-90"
        />
        <polyline
          fill="none"
          stroke="rgb(10 132 255)"
          strokeWidth="1.25"
          vectorEffect="non-scaling-stroke"
          points={points}
          className="drop-shadow-[0_0_8px_rgba(10,132,255,0.45)]"
        />
      </svg>
      <div className="absolute left-3 top-3 flex items-center gap-1.5 rounded-md bg-black/50 px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-white/45 backdrop-blur-sm">
        <LineChart className="h-3 w-3 text-primary/80" aria-hidden />
        PnL preview
      </div>
      <p className="absolute bottom-2 right-3 text-[10px] text-white/35">
        {hasData ? "From performance metrics" : "Illustrative only"}
      </p>
    </div>
  );
}

function statusBadgeClass(status: string): string {
  const u = status.toUpperCase();
  if (u === "ACTIVE")
    return "border-emerald-500/40 bg-emerald-500/15 text-emerald-200";
  if (u === "PAUSED")
    return "border-amber-500/40 bg-amber-500/15 text-amber-100";
  if (u === "OVERDUE") return "border-red-500/40 bg-red-500/15 text-red-100";
  return "border-white/15 bg-white/10 text-white/70";
}

export default function StrategyMarketplacePage() {
  const [activeTab, setActiveTab] = useState<StrategiesTab>("marketplace");
  const [strategies, setStrategies] = useState<StrategyListItem[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [subscriptions, setSubscriptions] = useState<SubscriptionRow[]>([]);
  const [subsLoading, setSubsLoading] = useState(true);
  const [subsError, setSubsError] = useState<string | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);

  const [modalStrategy, setModalStrategy] = useState<StrategyListItem | null>(
    null,
  );
  const [exchangeAccounts, setExchangeAccounts] = useState<
    ExchangeAccountOption[]
  >([]);
  const [selectedExchangeAccountId, setSelectedExchangeAccountId] =
    useState("");
  const [multiplier, setMultiplier] = useState(1);
  const [modalError, setModalError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState(false);

  const loadStrategies = useCallback(async () => {
    setListLoading(true);
    setListError(null);
    setUnauthorized(false);
    const token =
      typeof window !== "undefined" ? localStorage.getItem("token") : null;
    if (!token) {
      setUnauthorized(true);
      setStrategies([]);
      setListLoading(false);
      return;
    }
    try {
      const base = resolveApiBase();
      const res = await fetch(`${base}/subscriptions/strategies`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) {
        setUnauthorized(true);
        setStrategies([]);
        return;
      }
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const data: unknown = await res.json();
      if (!Array.isArray(data)) throw new Error("Invalid response");
      setStrategies(data as StrategyListItem[]);
    } catch (e) {
      setListError(e instanceof Error ? e.message : "Failed to load strategies");
      setStrategies([]);
    } finally {
      setListLoading(false);
    }
  }, []);

  const loadExchangeAccounts = useCallback(async () => {
    const token =
      typeof window !== "undefined" ? localStorage.getItem("token") : null;
    if (!token) {
      setExchangeAccounts([]);
      return;
    }
    try {
      const base = resolveApiBase();
      const res = await fetch(`${base}/exchange-accounts`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        setExchangeAccounts([]);
        return;
      }
      const data: unknown = await res.json();
      const raw =
        typeof data === "object" &&
        data !== null &&
        "accounts" in data &&
        Array.isArray((data as { accounts: unknown }).accounts)
          ? (data as { accounts: ExchangeAccountOption[] }).accounts
          : [];
      setExchangeAccounts(raw);
    } catch {
      setExchangeAccounts([]);
    }
  }, []);

  const loadSubscriptions = useCallback(async () => {
    setSubsLoading(true);
    setSubsError(null);
    const token =
      typeof window !== "undefined" ? localStorage.getItem("token") : null;
    if (!token) {
      setSubscriptions([]);
      setSubsLoading(false);
      return;
    }
    try {
      const base = resolveApiBase();
      const res = await fetch(`${base}/subscriptions/mine`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) {
        setSubscriptions([]);
        return;
      }
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const data: unknown = await res.json();
      const raw =
        typeof data === "object" &&
        data !== null &&
        "subscriptions" in data &&
        Array.isArray((data as { subscriptions: unknown }).subscriptions)
          ? (data as { subscriptions: SubscriptionRow[] }).subscriptions
          : [];
      setSubscriptions(raw);
    } catch (e) {
      setSubsError(
        e instanceof Error ? e.message : "Failed to load subscriptions",
      );
      setSubscriptions([]);
    } finally {
      setSubsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStrategies();
  }, [loadStrategies]);

  useEffect(() => {
    void loadExchangeAccounts();
  }, [loadExchangeAccounts]);

  useEffect(() => {
    void loadSubscriptions();
  }, [loadSubscriptions]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(false), 4200);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (!modalStrategy) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setModalStrategy(null);
        setModalError(null);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modalStrategy]);

  function openSubscribe(s: StrategyListItem) {
    setModalStrategy(s);
    setMultiplier(1);
    setModalError(null);
  }

  useEffect(() => {
    if (!modalStrategy) return;
    if (exchangeAccounts.length === 0) {
      setSelectedExchangeAccountId("");
      return;
    }
    setSelectedExchangeAccountId((current) =>
      exchangeAccounts.some((a) => a.id === current)
        ? current
        : (exchangeAccounts[0]?.id ?? ""),
    );
  }, [modalStrategy, exchangeAccounts]);

  async function handleConfirmSubscribe() {
    if (!modalStrategy) return;

    const token =
      typeof window !== "undefined" ? localStorage.getItem("token") : null;
    if (!token) {
      setModalError("You need to be logged in to subscribe.");
      return;
    }

    const m = clampMultiplier(multiplier);
    setMultiplier(m);

    if (
      exchangeAccounts.length > 0 &&
      !selectedExchangeAccountId.trim()
    ) {
      setModalError("Select an exchange account for this subscription.");
      return;
    }

    setSubmitting(true);
    setModalError(null);

    try {
      const base = resolveApiBase();
      const res = await fetch(`${base}/subscriptions/subscribe`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          strategyId: modalStrategy.id,
          multiplier: m,
          ...(selectedExchangeAccountId.trim()
            ? { exchangeAccountId: selectedExchangeAccountId.trim() }
            : {}),
        }),
      });

      const data: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg =
          typeof data === "object" &&
          data !== null &&
          "error" in data &&
          typeof (data as { error?: unknown }).error === "string"
            ? (data as { error: string }).error
            : `Request failed (${res.status})`;
        throw new Error(msg);
      }

      setModalStrategy(null);
      setToast(true);
      void loadSubscriptions();
    } catch (e) {
      setModalError(e instanceof Error ? e.message : "Subscription failed.");
    } finally {
      setSubmitting(false);
    }
  }

  if (unauthorized) {
    return (
      <div className="rounded-xl border border-amber-500/35 bg-amber-500/10 px-6 py-10 text-center">
        <p className="text-sm text-white/70">Sign in to browse strategies.</p>
        <Link
          href="/login"
          className="mt-4 inline-flex rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-white hover:bg-primary/90"
        >
          Go to login
        </Link>
      </div>
    );
  }

  const activeSubscriptions = subscriptions.filter(
    (s) => s.status.toUpperCase() === "ACTIVE",
  );
  const tabSubs =
    activeTab === "active" ? activeSubscriptions : subscriptions;

  const tabBtn =
    "inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition";

  return (
    <div className="relative">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">
          Strategies
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-white/55">
          Browse the marketplace, review your subscription history, or focus on
          active copy-trading subscriptions.
        </p>

        <nav
          className="mt-8 flex flex-wrap gap-2 border-b border-white/[0.08] pb-3"
          aria-label="Strategy views"
        >
          <button
            type="button"
            onClick={() => setActiveTab("marketplace")}
            className={`${tabBtn} ${
              activeTab === "marketplace"
                ? "border border-primary/40 bg-primary/15 text-white"
                : "border border-transparent text-white/55 hover:bg-white/5 hover:text-white/80"
            }`}
          >
            <Sparkles className="h-4 w-4 text-primary/90" aria-hidden />
            Marketplace
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("my")}
            className={`${tabBtn} ${
              activeTab === "my"
                ? "border border-primary/40 bg-primary/15 text-white"
                : "border border-transparent text-white/55 hover:bg-white/5 hover:text-white/80"
            }`}
          >
            <History className="h-4 w-4 text-primary/90" aria-hidden />
            My Strategies
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("active")}
            className={`${tabBtn} ${
              activeTab === "active"
                ? "border border-primary/40 bg-primary/15 text-white"
                : "border border-transparent text-white/55 hover:bg-white/5 hover:text-white/80"
            }`}
          >
            <Zap className="h-4 w-4 text-primary/90" aria-hidden />
            Active Strategies
          </button>
        </nav>
      </header>

      {activeTab === "marketplace" && (
        <>
          {listError && (
            <div className="mb-6 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
              {listError}
            </div>
          )}

          {listLoading ? (
            <div className="flex justify-center py-16">
              <Loader2
                className="h-10 w-10 animate-spin text-primary"
                aria-hidden
              />
            </div>
          ) : strategies.length === 0 ? (
            <div className="rounded-xl border border-white/10 bg-white/[0.03] px-6 py-12 text-center text-sm text-white/55">
              No strategies available yet.
            </div>
          ) : (
            <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-2">
              {strategies.map((s) => {
                const points = pnlValuesToSparklinePoints(s.performanceMetrics);
                const hasPnl =
                  typeof s.performanceMetrics === "object" &&
                  s.performanceMetrics !== null &&
                  Array.isArray(
                    (s.performanceMetrics as PnlMetrics).pnlChart?.values,
                  ) &&
                  ((s.performanceMetrics as PnlMetrics).pnlChart?.values
                    ?.length ?? 0) > 0;
                return (
                  <article
                    key={s.id}
                    className="glass-card relative flex flex-col overflow-hidden border border-glassBorder p-6 shadow-xl transition hover:border-primary/35 hover:shadow-primary/5"
                  >
                    <div
                      className={`pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b ${accentForId(s.id)} opacity-90`}
                      aria-hidden
                    />
                    <div className="relative">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <h2 className="text-lg font-semibold text-white">
                            {s.title}
                          </h2>
                          <p className="mt-2 text-sm leading-relaxed text-white/55">
                            {s.description}
                          </p>
                        </div>
                        <TrendingUp
                          className="mt-1 h-8 w-8 shrink-0 text-primary/70"
                          aria-hidden
                        />
                      </div>

                      <PnlChartPlaceholder
                        points={points}
                        gradientId={`pnl-fill-${s.id.replace(/-/g, "")}`}
                        hasData={hasPnl}
                      />

                      <dl className="mt-5 grid grid-cols-3 gap-3 text-center">
                        <div className="rounded-lg border border-white/[0.06] bg-black/25 px-2 py-3">
                          <dt className="text-[10px] font-medium uppercase tracking-wider text-white/40">
                            Monthly
                          </dt>
                          <dd className="mt-1 text-sm font-semibold tabular-nums text-white">
                            ₹{s.monthlyFee.toLocaleString("en-IN")}
                          </dd>
                        </div>
                        <div className="rounded-lg border border-white/[0.06] bg-black/25 px-2 py-3">
                          <dt className="text-[10px] font-medium uppercase tracking-wider text-white/40">
                            Min cap.
                          </dt>
                          <dd className="mt-1 text-sm font-semibold tabular-nums text-white">
                            ₹{s.minCapital.toLocaleString("en-IN")}
                          </dd>
                        </div>
                        <div className="rounded-lg border border-white/[0.06] bg-black/25 px-2 py-3">
                          <dt className="text-[10px] font-medium uppercase tracking-wider text-white/40">
                            Profit share
                          </dt>
                          <dd className="mt-1 text-sm font-semibold tabular-nums text-emerald-300/90">
                            {s.profitShare}%
                          </dd>
                        </div>
                      </dl>

                      <div className="mt-6 flex flex-col gap-2 sm:flex-row">
                        <Link
                          href={`/dashboard/strategies/${s.id}`}
                          className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-glassBorder bg-white/[0.06] py-3 text-sm font-medium text-white transition hover:bg-white/10"
                        >
                          <Eye className="h-4 w-4 opacity-90" aria-hidden />
                          View Strategy
                        </Link>
                        <button
                          type="button"
                          onClick={() => openSubscribe(s)}
                          className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-primary py-3 text-sm font-medium text-white shadow-lg shadow-primary/25 transition hover:bg-primary/90"
                        >
                          <Wallet className="h-4 w-4 opacity-90" aria-hidden />
                          Subscribe
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </>
      )}

      {(activeTab === "my" || activeTab === "active") && (
        <>
          {subsError && (
            <div className="mb-6 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
              {subsError}
            </div>
          )}
          {subsLoading ? (
            <div className="flex justify-center py-16">
              <Loader2
                className="h-10 w-10 animate-spin text-primary"
                aria-hidden
              />
            </div>
          ) : tabSubs.length === 0 ? (
            <div className="rounded-xl border border-white/10 bg-white/[0.03] px-6 py-12 text-center text-sm text-white/55">
              {activeTab === "active"
                ? "No active subscriptions. Subscribe from the Marketplace tab or check My Strategies for paused or overdue rows."
                : "You have not subscribed to any strategy yet."}
            </div>
          ) : (
            <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-2">
              {tabSubs.map((sub) => {
                const s = sub.strategy;
                const points = pnlValuesToSparklinePoints(s.performanceMetrics);
                const hasPnl =
                  typeof s.performanceMetrics === "object" &&
                  s.performanceMetrics !== null &&
                  Array.isArray(
                    (s.performanceMetrics as PnlMetrics).pnlChart?.values,
                  ) &&
                  ((s.performanceMetrics as PnlMetrics).pnlChart?.values
                    ?.length ?? 0) > 0;
                return (
                  <article
                    key={sub.id}
                    className="glass-card relative flex flex-col overflow-hidden border border-glassBorder p-6 shadow-xl transition hover:border-primary/35 hover:shadow-primary/5"
                  >
                    <div
                      className={`pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b ${accentForId(s.id)} opacity-90`}
                      aria-hidden
                    />
                    <div className="relative">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <h2 className="text-lg font-semibold text-white">
                              {s.title}
                            </h2>
                            <span
                              className={`rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${statusBadgeClass(sub.status)}`}
                            >
                              {sub.status}
                            </span>
                          </div>
                          <p className="mt-2 text-sm leading-relaxed text-white/55">
                            {s.description}
                          </p>
                        </div>
                        <TrendingUp
                          className="mt-1 h-8 w-8 shrink-0 text-primary/70"
                          aria-hidden
                        />
                      </div>

                      <p className="mt-3 text-xs text-white/45">
                        Joined{" "}
                        {new Date(sub.joinedDate).toLocaleString(undefined, {
                          dateStyle: "medium",
                          timeStyle: "short",
                        })}
                        {" · "}
                        <span className="tabular-nums">
                          {sub.multiplier}× multiplier
                        </span>
                        {sub.exchangeAccount ? (
                          <>
                            {" · "}
                            <span className="text-white/55">
                              {sub.exchangeAccount.nickname}
                            </span>
                          </>
                        ) : null}
                      </p>

                      <PnlChartPlaceholder
                        points={points}
                        gradientId={`pnl-sub-${sub.id.replace(/-/g, "")}`}
                        hasData={hasPnl}
                      />

                      <dl className="mt-5 grid grid-cols-3 gap-3 text-center">
                        <div className="rounded-lg border border-white/[0.06] bg-black/25 px-2 py-3">
                          <dt className="text-[10px] font-medium uppercase tracking-wider text-white/40">
                            Monthly
                          </dt>
                          <dd className="mt-1 text-sm font-semibold tabular-nums text-white">
                            ₹{s.monthlyFee.toLocaleString("en-IN")}
                          </dd>
                        </div>
                        <div className="rounded-lg border border-white/[0.06] bg-black/25 px-2 py-3">
                          <dt className="text-[10px] font-medium uppercase tracking-wider text-white/40">
                            Min cap.
                          </dt>
                          <dd className="mt-1 text-sm font-semibold tabular-nums text-white">
                            ₹{s.minCapital.toLocaleString("en-IN")}
                          </dd>
                        </div>
                        <div className="rounded-lg border border-white/[0.06] bg-black/25 px-2 py-3">
                          <dt className="text-[10px] font-medium uppercase tracking-wider text-white/40">
                            Profit share
                          </dt>
                          <dd className="mt-1 text-sm font-semibold tabular-nums text-emerald-300/90">
                            {s.profitShare}%
                          </dd>
                        </div>
                      </dl>

                      <div className="mt-6">
                        <Link
                          href={`/dashboard/strategies/${s.id}`}
                          className="flex w-full items-center justify-center gap-2 rounded-lg border border-glassBorder bg-white/[0.06] py-3 text-sm font-medium text-white transition hover:bg-white/10"
                        >
                          <Eye className="h-4 w-4 opacity-90" aria-hidden />
                          View Strategy
                        </Link>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </>
      )}

      {modalStrategy && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/70 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="subscribe-modal-title"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) {
              setModalStrategy(null);
              setModalError(null);
            }
          }}
        >
          <div className="glass-card relative my-8 w-full max-w-md border border-glassBorder p-6 shadow-2xl">
            <button
              type="button"
              onClick={() => {
                setModalStrategy(null);
                setModalError(null);
              }}
              className="absolute right-4 top-4 rounded-lg p-2 text-white/50 transition hover:bg-white/10 hover:text-white"
              aria-label="Close"
            >
              <X className="h-5 w-5" />
            </button>

            <h2
              id="subscribe-modal-title"
              className="pr-10 text-lg font-semibold text-white"
            >
              Subscribe to {modalStrategy.title}
            </h2>
            <p className="mt-2 text-sm text-white/50">
              Choose which Delta API credentials to use (from Settings) and a
              multiplier between{" "}
              <span className="tabular-nums text-white/70">0.1×</span> and{" "}
              <span className="tabular-nums text-white/70">10×</span> (step{" "}
              <span className="tabular-nums text-white/70">0.1</span>).
            </p>

            {modalError && (
              <p className="mt-4 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                {modalError}
              </p>
            )}

            {exchangeAccounts.length > 0 ? (
              <label className="mt-6 block">
                <span className="text-xs font-medium text-white/60">
                  Exchange account
                </span>
                <select
                  value={selectedExchangeAccountId}
                  onChange={(e) =>
                    setSelectedExchangeAccountId(e.target.value)
                  }
                  className="mt-2 w-full rounded-lg border border-glassBorder bg-black/40 px-4 py-3 text-sm text-white outline-none ring-primary/25 focus:ring-2"
                >
                  {exchangeAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.nickname} ({a.exchange})
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <p className="mt-6 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100/90">
                No exchange API keys on file. Add keys in{" "}
                <Link
                  href="/dashboard/settings"
                  className="font-medium text-primary underline-offset-2 hover:underline"
                >
                  Settings
                </Link>{" "}
                to attach credentials to new subscriptions.
              </p>
            )}

            <label className="mt-6 block">
              <span className="text-xs font-medium text-white/60">
                Multiplier
              </span>
              <input
                type="number"
                min={0.1}
                max={10}
                step={0.1}
                value={multiplier}
                onChange={(e) => {
                  const raw = Number(e.target.value);
                  if (Number.isNaN(raw)) return;
                  setMultiplier(clampMultiplier(raw));
                }}
                onBlur={() => setMultiplier((prev) => clampMultiplier(prev))}
                className="mt-2 w-full rounded-lg border border-glassBorder bg-black/40 px-4 py-3 text-sm tabular-nums text-white outline-none ring-primary/25 focus:ring-2"
              />
            </label>

            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => {
                  setModalStrategy(null);
                  setModalError(null);
                }}
                className="rounded-lg px-4 py-2 text-sm font-medium text-white/70 transition hover:bg-white/10"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={submitting}
                onClick={() => void handleConfirmSubscribe()}
                className="rounded-lg bg-primary px-5 py-2 text-sm font-medium text-white shadow-lg shadow-primary/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting ? "Confirming…" : "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-6 left-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 shadow-2xl"
        >
          <div className="glass-card border border-emerald-500/40 bg-emerald-500/15 px-5 py-4 text-center shadow-2xl">
            <p className="text-sm font-medium text-emerald-100">
              You&apos;re subscribed! Your multiplier allocation is saved.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
