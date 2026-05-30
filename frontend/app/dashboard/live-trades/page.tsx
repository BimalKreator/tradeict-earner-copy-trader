"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  Layers,
  Loader2,
  RefreshCw,
  Scale,
  TrendingUp,
} from "lucide-react";
import Link from "next/link";

const ENV_API_BASE =
  process.env.NEXT_PUBLIC_API_URL?.trim().replace(/\/$/, "") ?? "";

const LIVE_TRADES_REFRESH_MS = 8_000;

function resolveApiBase(): string {
  if (ENV_API_BASE) return ENV_API_BASE;
  if (typeof window !== "undefined") {
    return `${window.location.origin.replace(/\/$/, "")}/api`;
  }
  return "";
}

type LiveRow = {
  entryTime: string | null;
  token: string;
  entryPrice: number | null;
  livePnl: number;
  markPrice: number | null;
  side: string;
  size: number | null;
};

type UserStrategyGroup = {
  strategy: {
    id: string;
    title: string;
    multiplier: number;
    isActive: boolean;
    autoExitTarget: number | null;
    autoExitStopLoss: number | null;
  };
  userPositions: LiveRow[];
  masterOpenCount: number;
};

const usdPriceFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 6,
});

const usdPnlFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  signDisplay: "always",
});

function fmtPrice(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return usdPriceFmt.format(n);
}

function fmtPnl(n: number | null | undefined): string {
  if (typeof n === "number" && Number.isFinite(n)) {
    return usdPnlFmt.format(n);
  }
  return usdPnlFmt.format(0);
}

function fmtQty(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1) {
    return abs % 1 === 0 ? String(abs) : abs.toFixed(4).replace(/\.?0+$/, "");
  }
  return abs.toFixed(6).replace(/\.?0+$/, "");
}

function formatMultiplier(m: number): string {
  if (!Number.isFinite(m) || m <= 0) return "1x";
  const rounded = Math.round(m * 100) / 100;
  return Number.isInteger(rounded) ? `${rounded}x` : `${rounded}x`;
}

function sumLivePnl(rows: LiveRow[]): number {
  let total = 0;
  for (const r of rows) {
    const pnl = r.livePnl;
    if (typeof pnl === "number" && Number.isFinite(pnl)) total += pnl;
  }
  return total;
}

function parseUserGroups(data: unknown): UserStrategyGroup[] {
  const rawList = Array.isArray(data)
    ? data
    : typeof data === "object" &&
        data !== null &&
        "strategies" in data &&
        Array.isArray((data as { strategies: unknown }).strategies)
      ? (data as { strategies: unknown[] }).strategies
      : [];

  return rawList.map((item) => {
    const row = item as Record<string, unknown>;
    const strat =
      typeof row.strategy === "object" && row.strategy !== null
        ? (row.strategy as Record<string, unknown>)
        : {};
    const positions = Array.isArray(row.userPositions)
      ? row.userPositions
      : [];
    const masterOpenCount =
      typeof row.masterOpenCount === "number" && Number.isFinite(row.masterOpenCount)
        ? row.masterOpenCount
        : 0;

    return {
      strategy: {
        id: String(strat.id ?? ""),
        title: String(strat.title ?? "Strategy"),
        multiplier:
          typeof strat.multiplier === "number" ? strat.multiplier : 1,
        isActive: strat.isActive !== false,
        autoExitTarget:
          typeof strat.autoExitTarget === "number" ? strat.autoExitTarget : null,
        autoExitStopLoss:
          typeof strat.autoExitStopLoss === "number"
            ? strat.autoExitStopLoss
            : null,
      },
      userPositions: positions.map((p) => {
        const r = p as Record<string, unknown>;
        return {
          entryTime: typeof r.entryTime === "string" ? r.entryTime : null,
          token: String(r.token ?? ""),
          entryPrice: typeof r.entryPrice === "number" ? r.entryPrice : null,
          livePnl:
            typeof r.livePnl === "number" && Number.isFinite(r.livePnl)
              ? r.livePnl
              : 0,
          markPrice: typeof r.markPrice === "number" ? r.markPrice : null,
          side: String(r.side ?? ""),
          size: typeof r.size === "number" ? r.size : null,
        };
      }),
      masterOpenCount,
    };
  });
}

function SideBadge({ side }: { side: string }) {
  const normalized = side.trim().toLowerCase();
  const isLong =
    normalized === "buy" ||
    normalized === "long" ||
    normalized.startsWith("buy");
  const isShort =
    normalized === "sell" ||
    normalized === "short" ||
    normalized.startsWith("sell");

  return (
    <span
      className={`inline-flex rounded-md px-2 py-0.5 text-xs font-semibold uppercase tracking-wide ${
        isLong
          ? "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30"
          : isShort
            ? "bg-red-500/15 text-red-300 ring-1 ring-red-500/30"
            : "bg-white/10 text-white/70 ring-1 ring-white/15"
      }`}
    >
      {side || "—"}
    </span>
  );
}

function StrategyOverviewCard({ group }: { group: UserStrategyGroup }) {
  const totalPnl = sumLivePnl(group.userPositions);
  const pnlPositive = totalPnl > 0;
  const pnlNegative = totalPnl < 0;
  const mult =
    Number.isFinite(group.strategy.multiplier) && group.strategy.multiplier > 0
      ? group.strategy.multiplier
      : 1;

  return (
    <div className="rounded-xl border border-glassBorder bg-gradient-to-br from-primary/[0.08] via-white/[0.02] to-transparent p-4 sm:p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <div className="rounded-lg border border-primary/25 bg-primary/10 p-2">
              <Layers className="h-4 w-4 text-primary" aria-hidden />
            </div>
            <h2 className="truncate text-lg font-semibold text-white sm:text-xl">
              {group.strategy.title}
            </h2>
            {!group.strategy.isActive ? (
              <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-amber-200 ring-1 ring-amber-500/35">
                Strategy paused
              </span>
            ) : null}
          </div>
          <p className="mt-2 text-xs text-white/45">
            Strategy ID{" "}
            <span className="font-mono text-white/55">{group.strategy.id}</span>
          </p>
          <div className="mt-3 inline-flex items-center gap-2 rounded-lg border border-violet-500/25 bg-violet-500/10 px-3 py-2">
            <Scale className="h-4 w-4 shrink-0 text-violet-300" aria-hidden />
            <div>
              <p className="text-[10px] font-medium uppercase tracking-wider text-white/40">
                Your multiplier
              </p>
              <p className="text-sm font-semibold text-violet-200">
                {formatMultiplier(mult)}
              </p>
            </div>
          </div>
        </div>

        <div
          className={`w-full shrink-0 rounded-xl border px-4 py-3 sm:w-auto sm:min-w-[200px] sm:text-right ${
            pnlPositive
              ? "border-emerald-500/35 bg-emerald-500/10"
              : pnlNegative
                ? "border-red-500/35 bg-red-500/10"
                : "border-white/10 bg-white/[0.03]"
          }`}
        >
          <p className="text-[10px] font-medium uppercase tracking-wider text-white/45">
            Your live PnL
          </p>
          <p
            className={`mt-1 text-2xl font-bold tabular-nums sm:text-3xl ${
              pnlPositive
                ? "text-emerald-400"
                : pnlNegative
                  ? "text-red-400"
                  : "text-white/80"
            }`}
          >
            {fmtPnl(totalPnl)}
          </p>
          <p className="mt-1 text-[10px] text-white/35">
            {group.userPositions.length} open leg
            {group.userPositions.length === 1 ? "" : "s"}
          </p>
        </div>
      </div>
    </div>
  );
}

function MasterFlatEmptyState() {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-white/15 bg-white/[0.02] px-6 py-14 text-center">
      <div className="rounded-full border border-white/10 bg-white/[0.04] p-4">
        <TrendingUp className="h-8 w-8 text-white/25" aria-hidden />
      </div>
      <p className="mt-4 max-w-md text-sm font-medium text-white/70">
        No active trades currently open for this strategy.
      </p>
      <p className="mt-2 max-w-sm text-xs text-white/40">
        When the strategy leader opens new positions, your copy trades will appear
        here automatically.
      </p>
    </div>
  );
}

function UserPositionsTable({ rows }: { rows: LiveRow[] }) {
  return (
    <div className="overflow-hidden rounded-xl border border-glassBorder">
      <div className="border-b border-glassBorder bg-white/[0.03] px-4 py-3">
        <p className="text-sm font-medium text-white">Open positions</p>
        <p className="mt-0.5 text-xs text-white/45">
          Live data from your linked Delta account
        </p>
      </div>
      <div className="scroll-table overflow-x-auto">
        <table className="w-full min-w-[560px] text-left text-sm">
          <thead className="border-b border-glassBorder bg-white/[0.03]">
            <tr>
              <th className="px-3 py-3 font-medium text-white/60 sm:px-4">
                Token
              </th>
              <th className="px-3 py-3 font-medium text-white/60 sm:px-4">
                Side
              </th>
              <th className="px-3 py-3 font-medium text-white/60 sm:px-4">
                Qty
              </th>
              <th className="px-3 py-3 font-medium text-white/60 sm:px-4">
                Entry price
              </th>
              <th className="px-3 py-3 font-medium text-white/60 sm:px-4">
                Mark price
              </th>
              <th className="px-3 py-3 text-right font-medium text-white/60 sm:px-4">
                Live PnL
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-4 py-10 text-center text-sm text-white/50"
                >
                  No open positions on your account for this strategy yet. Positions
                  will appear here once copy execution completes.
                </td>
              </tr>
            ) : (
              rows.map((r, i) => {
                const rowPnlPositive = r.livePnl > 0;
                const rowPnlNegative = r.livePnl < 0;
                return (
                  <tr
                    key={`${r.token}-${r.side}-${i}`}
                    className="border-b border-white/[0.06] last:border-0 hover:bg-white/[0.02]"
                  >
                    <td className="px-3 py-3 font-medium text-white sm:px-4">
                      {r.token}
                    </td>
                    <td className="px-3 py-3 sm:px-4">
                      <SideBadge side={r.side} />
                    </td>
                    <td className="px-3 py-3 tabular-nums text-white/80 sm:px-4">
                      {fmtQty(r.size)}
                    </td>
                    <td className="px-3 py-3 tabular-nums text-white/80 sm:px-4">
                      {fmtPrice(r.entryPrice)}
                    </td>
                    <td className="px-3 py-3 tabular-nums text-white/80 sm:px-4">
                      {fmtPrice(r.markPrice)}
                    </td>
                    <td
                      className={`px-3 py-3 text-right tabular-nums font-semibold sm:px-4 ${
                        rowPnlPositive
                          ? "text-emerald-400"
                          : rowPnlNegative
                            ? "text-red-400"
                            : "text-white/70"
                      }`}
                    >
                      {fmtPnl(r.livePnl)}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StrategyTabPanel({ group }: { group: UserStrategyGroup }) {
  const masterFlat = group.masterOpenCount === 0;

  return (
    <div className="space-y-5">
      <StrategyOverviewCard group={group} />
      {masterFlat ? (
        <MasterFlatEmptyState />
      ) : (
        <UserPositionsTable rows={group.userPositions} />
      )}
    </div>
  );
}

function LiveTradesStrategyTabs({
  groups,
  activeId,
  onSelect,
}: {
  groups: UserStrategyGroup[];
  activeId: string;
  onSelect: (id: string) => void;
}) {
  if (groups.length <= 1) return null;

  return (
    <div
      role="tablist"
      aria-label="Subscribed strategies"
      className="flex flex-wrap gap-2 border-b border-glassBorder pb-3"
    >
      {groups.map((group) => {
        const selected = group.strategy.id === activeId;
        const legCount = group.userPositions.length;
        return (
          <button
            key={group.strategy.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onSelect(group.strategy.id)}
            className={`rounded-lg border px-3 py-2 text-left text-sm transition ${
              selected
                ? "border-primary/50 bg-primary/15 text-white ring-1 ring-primary/30"
                : "border-white/10 bg-white/[0.03] text-white/65 hover:border-white/20 hover:bg-white/[0.06]"
            }`}
          >
            <span className="font-medium">{group.strategy.title}</span>
            <span className="mt-0.5 block text-[10px] tabular-nums text-white/40">
              {legCount} open leg{legCount === 1 ? "" : "s"}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export default function DashboardLiveTradesPage() {
  const [groups, setGroups] = useState<UserStrategyGroup[]>([]);
  const [activeStrategyId, setActiveStrategyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);

  const load = useCallback(async (silent: boolean) => {
    const base = resolveApiBase();
    if (!base) {
      if (!silent) {
        setError("API URL is not configured.");
        setLoading(false);
      }
      return;
    }
    if (silent) setIsRefreshing(true);
    try {
      const res = await fetch(`${base}/live-trades/me?t=${Date.now()}`, {
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${localStorage.getItem("token") ?? ""}`,
          "Cache-Control": "no-cache",
          Pragma: "no-cache",
        },
      });
      if (res.status === 401) {
        if (!silent) {
          setUnauthorized(true);
          setGroups([]);
        }
        return;
      }
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const data: unknown = await res.json();
      const list = parseUserGroups(data);
      setGroups(list);
      setLastRefreshed(new Date());
      if (!silent) {
        setError(null);
        setUnauthorized(false);
      }
    } catch (e) {
      if (!silent) {
        setError(e instanceof Error ? e.message : "Failed to load positions");
      }
    } finally {
      if (!silent) setLoading(false);
      if (silent) setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => {
    if (groups.length === 0) {
      setActiveStrategyId(null);
      return;
    }
    setActiveStrategyId((prev) => {
      if (prev && groups.some((g) => g.strategy.id === prev)) return prev;
      return groups[0]?.strategy.id ?? null;
    });
  }, [groups]);

  useEffect(() => {
    const id = window.setInterval(() => {
      void load(true);
    }, LIVE_TRADES_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [load]);

  if (unauthorized) {
    return (
      <div className="rounded-xl border border-amber-500/35 bg-amber-500/10 px-6 py-10 text-center">
        <p className="text-sm text-white/70">Sign in to view live positions.</p>
        <Link
          href="/login"
          className="mt-4 inline-flex rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-white hover:bg-primary/90"
        >
          Go to login
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6 md:space-y-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="rounded-xl border border-glassBorder bg-primary/10 p-3">
            <Activity className="h-6 w-6 text-primary" aria-hidden />
          </div>
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">
              Live trades
            </h1>
            <p className="mt-1 text-sm text-white/55">
              Live copy positions on Delta India for your subscribed strategies.
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-white/40">
              {lastRefreshed && !loading ? (
                <span>Last refresh: {lastRefreshed.toLocaleTimeString()}</span>
              ) : null}
              {isRefreshing ? (
                <span className="inline-flex items-center gap-1 text-primary/80">
                  <RefreshCw className="h-3 w-3 animate-spin" aria-hidden />
                  Refreshing…
                </span>
              ) : null}
              {!loading ? (
                <span className="text-white/30">
                  Auto-refresh every {LIVE_TRADES_REFRESH_MS / 1000}s
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </header>

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-20">
          <Loader2
            className="h-10 w-10 animate-spin text-primary"
            aria-label="Loading live trades"
          />
        </div>
      ) : groups.length === 0 ? (
        <div className="rounded-xl border border-glassBorder bg-white/[0.03] px-6 py-12 text-center">
          <Layers className="mx-auto h-10 w-10 text-white/20" aria-hidden />
          <p className="mt-4 text-sm text-white/60">
            No active Future Hedge subscription.
          </p>
          <p className="mt-2 text-xs text-white/40">
            Deploy Future Hedge Strategy from My Strategies to see live copy
            positions here.
          </p>
          <Link
            href="/dashboard/strategies"
            className="mt-5 inline-flex rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-white hover:bg-primary/90"
          >
            Browse strategies
          </Link>
        </div>
      ) : (
        <div className="space-y-4">
          <LiveTradesStrategyTabs
            groups={groups}
            activeId={activeStrategyId ?? groups[0]!.strategy.id}
            onSelect={setActiveStrategyId}
          />
          <div className="glass-card min-h-[360px] border border-glassBorder p-4 sm:p-5 md:p-6">
            {groups.map((group) => {
              const isActive =
                group.strategy.id ===
                (activeStrategyId ?? groups[0]!.strategy.id);
              return (
                <div key={group.strategy.id} hidden={!isActive}>
                  <StrategyTabPanel group={group} />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
