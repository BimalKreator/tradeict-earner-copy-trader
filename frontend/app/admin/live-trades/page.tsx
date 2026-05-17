"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Layers,
  Loader2,
  Shield,
  Target,
  TrendingDown,
  Users,
} from "lucide-react";
import Link from "next/link";

const ENV_API_BASE =
  process.env.NEXT_PUBLIC_API_URL?.trim().replace(/\/$/, "") ?? "";

function resolveAdminApiBase(): string {
  if (ENV_API_BASE) return ENV_API_BASE;
  if (typeof window !== "undefined") {
    return `${window.location.origin.replace(/\/$/, "")}/api`;
  }
  return "";
}

type LiveRow = {
  entryTime: string | null;
  token: string;
  size: number | null;
  entryPrice: number | null;
  stopLoss: number | null;
  target: number | null;
  livePnl: number | null;
  markPrice: number | null;
  side: string;
};

type FollowerRow = LiveRow & { userId: string; userEmail: string };

type SubscriberUser = {
  userId: string;
  userEmail: string;
  multiplier: number;
  positions: LiveRow[];
};

type StrategySection = {
  strategyId: string;
  strategyTitle: string;
  autoExitTarget: number | null;
  autoExitStopLoss: number | null;
  /** CCXT open positions on the strategy master Delta (India) account. */
  masterPositions: LiveRow[];
  subscribers: SubscriberUser[];
};

interface AutoExitPayload {
  autoExitTarget?: number | null;
  autoExitStopLoss?: number | null;
}

type AutoExitSaved = Pick<StrategySection, "autoExitTarget" | "autoExitStopLoss">;

function parseAutoExitSaved(payload: unknown): AutoExitSaved | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const p = payload as AutoExitPayload;
  return {
    autoExitTarget:
      p.autoExitTarget === null || typeof p.autoExitTarget === "number"
        ? (p.autoExitTarget ?? null)
        : null,
    autoExitStopLoss:
      p.autoExitStopLoss === null || typeof p.autoExitStopLoss === "number"
        ? (p.autoExitStopLoss ?? null)
        : null,
  };
}

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
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return usdPnlFmt.format(n);
}

function sumLivePnl(rows: LiveRow[]): number {
  return rows.reduce((acc, r) => {
    if (r.livePnl != null && Number.isFinite(r.livePnl)) return acc + r.livePnl;
    return acc;
  }, 0);
}

function formatMultiplier(m: number): string {
  if (!Number.isFinite(m) || m <= 0) return "1x";
  const rounded = Math.round(m * 100) / 100;
  return Number.isInteger(rounded) ? `${rounded}x` : `${rounded}x`;
}

function RiskManagementPanel({
  strategy,
  totalLivePnl,
  onSaved,
}: {
  strategy: StrategySection;
  totalLivePnl: number;
  onSaved: (message: string, updated?: AutoExitSaved) => void;
}) {
  const [targetInput, setTargetInput] = useState(
    strategy.autoExitTarget != null ? String(strategy.autoExitTarget) : "",
  );
  const [stopInput, setStopInput] = useState(
    strategy.autoExitStopLoss != null ? String(strategy.autoExitStopLoss) : "",
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setTargetInput(
      strategy.autoExitTarget != null ? String(strategy.autoExitTarget) : "",
    );
    setStopInput(
      strategy.autoExitStopLoss != null ? String(strategy.autoExitStopLoss) : "",
    );
  }, [strategy.autoExitTarget, strategy.autoExitStopLoss]);

  const pnlPositive = totalLivePnl > 0;
  const pnlNegative = totalLivePnl < 0;

  const saveAutoExit = async () => {
    const base = resolveAdminApiBase();
    if (!base) {
      onSaved("API base URL is not configured.");
      return;
    }

    const body: {
      autoExitTarget?: number | null;
      autoExitStopLoss?: number | null;
    } = {};

    if (targetInput.trim() === "") {
      body.autoExitTarget = null;
    } else {
      const t = Number(targetInput);
      if (!Number.isFinite(t) || t < 0) {
        onSaved("Target profit must be a non-negative number.");
        return;
      }
      body.autoExitTarget = t;
    }

    if (stopInput.trim() === "") {
      body.autoExitStopLoss = null;
    } else {
      const s = Number(stopInput);
      if (!Number.isFinite(s) || s <= 0) {
        onSaved("Stop loss must be a positive number.");
        return;
      }
      body.autoExitStopLoss = s;
    }

    setSaving(true);
    try {
      const res = await fetch(
        `${base}/admin/strategies/${strategy.strategyId}/auto-exit`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${localStorage.getItem("token") ?? ""}`,
          },
          body: JSON.stringify(body),
        },
      );
      const payload: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg =
          typeof payload === "object" &&
          payload !== null &&
          "error" in payload &&
          typeof (payload as { error: unknown }).error === "string"
            ? (payload as { error: string }).error
            : `Save failed (${res.status})`;
        throw new Error(msg);
      }
      const saved = parseAutoExitSaved(payload);
      onSaved("Auto-exit settings saved.", saved);
    } catch (e) {
      onSaved(e instanceof Error ? e.message : "Failed to save auto-exit");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="mt-6 overflow-hidden rounded-xl border border-amber-500/25 bg-gradient-to-br from-amber-500/[0.07] via-black/30 to-emerald-500/[0.05] p-4 md:p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5">
            <Shield className="h-5 w-5 text-amber-300" aria-hidden />
          </div>
          <div>
            <h3 className="text-sm font-semibold tracking-wide text-white">
              Risk Management &amp; Summary
            </h3>
            <p className="mt-0.5 max-w-xl text-xs text-white/45">
              Total unrealized PnL across all master legs. When thresholds are
              hit, the trade engine closes every master position (followers copy
              via WebSocket).
            </p>
          </div>
        </div>
        <div className="text-right">
          <p className="text-[10px] font-medium uppercase tracking-wider text-white/40">
            Total live PnL
          </p>
          <p
            className={`mt-0.5 text-2xl font-bold tabular-nums ${
              pnlPositive
                ? "text-emerald-400"
                : pnlNegative
                  ? "text-red-400"
                  : "text-white/70"
            }`}
          >
            {fmtPnl(totalLivePnl)}
          </p>
        </div>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_auto] lg:items-end">
        <label className="block">
          <span className="flex items-center gap-1.5 text-xs font-medium text-white/55">
            <Target className="h-3.5 w-3.5 text-emerald-400/80" aria-hidden />
            Target profit ($)
          </span>
          <input
            type="number"
            min={0}
            step="any"
            placeholder="e.g. 500"
            value={targetInput}
            onChange={(e) => setTargetInput(e.target.value)}
            className="mt-1.5 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-emerald-500/50 focus:outline-none focus:ring-1 focus:ring-emerald-500/30"
          />
        </label>
        <label className="block">
          <span className="flex items-center gap-1.5 text-xs font-medium text-white/55">
            <TrendingDown className="h-3.5 w-3.5 text-red-400/80" aria-hidden />
            Stop loss ($)
          </span>
          <input
            type="number"
            min={0}
            step="any"
            placeholder="e.g. 5 (exits at −$5)"
            value={stopInput}
            onChange={(e) => setStopInput(e.target.value)}
            className="mt-1.5 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-red-500/50 focus:outline-none focus:ring-1 focus:ring-red-500/30"
          />
        </label>
        <button
          type="button"
          disabled={saving}
          onClick={() => void saveAutoExit()}
          className="rounded-lg border border-primary/50 bg-primary/20 px-4 py-2 text-sm font-medium text-primary transition hover:bg-primary/30 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving ? "Saving…" : "Save Auto-Exit"}
        </button>
      </div>
    </div>
  );
}

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function PositionTable({
  rows,
  variant,
  strategyId,
  followerUserId,
  onCloseTrade,
  closingKey,
}: {
  rows: (LiveRow | FollowerRow)[];
  variant: "master" | "follower" | "subscriber";
  strategyId: string;
  followerUserId?: string;
  onCloseTrade: (args: {
    strategyId: string;
    userId?: string;
    symbol: string;
    side: string;
    size: number;
    isMaster: boolean;
  }) => Promise<void>;
  closingKey: string | null;
}) {
  const showSourceColumn = variant !== "subscriber";
  const closeUserId =
    variant === "subscriber"
      ? followerUserId
      : variant === "follower"
        ? (rows[0] as FollowerRow | undefined)?.userId
        : undefined;

  return (
    <div className="scroll-table overflow-x-auto">
      <table className="w-full min-w-[900px] text-left text-sm">
        <thead
          className={
            variant === "master"
              ? "border-b border-primary/35 bg-primary/10"
              : "border-b border-white/[0.08] bg-black/25"
          }
        >
          <tr>
            {showSourceColumn ? (
              variant === "follower" ? (
                <th className="px-3 py-2 font-medium text-white/70">User</th>
              ) : (
                <th className="px-3 py-2 font-medium text-primary/90">Source</th>
              )
            ) : null}
            <th className="px-3 py-2 font-medium text-white/70">Entry time</th>
            <th className="px-3 py-2 font-medium text-white/70">Token</th>
            <th className="px-3 py-2 font-medium text-white/70">Side</th>
            <th className="px-3 py-2 font-medium text-white/70">Entry price</th>
            <th className="px-3 py-2 font-medium text-white/70">Live PnL</th>
            <th
              className="px-3 py-2 font-medium text-white/70"
              title="Delta mark price (same as Terminal — not LTP)"
            >
              Mark price
            </th>
            <th className="px-3 py-2 font-medium text-white/70">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, idx) => (
            <tr
              key={`${r.token}-${r.side}-${idx}`}
              className="border-b border-white/[0.05] last:border-0 hover:bg-white/[0.02]"
            >
              {showSourceColumn ? (
                <td className="whitespace-nowrap px-3 py-2 text-xs text-white/75">
                  {variant === "follower"
                    ? (r as FollowerRow).userEmail
                    : "ADMIN · MASTER DELTA"}
                </td>
              ) : null}
              <td className="whitespace-nowrap px-3 py-2 tabular-nums text-white/55">
                {fmtTime(r.entryTime)}
              </td>
              <td className="px-3 py-2 font-medium text-white">{r.token}</td>
              <td className="px-3 py-2 text-white/65">{r.side}</td>
              <td className="px-3 py-2 tabular-nums text-white/80">
                {fmtPrice(r.entryPrice)}
              </td>
              <td
                className={`px-3 py-2 tabular-nums font-medium ${
                  r.livePnl != null && r.livePnl >= 0
                    ? "text-emerald-400"
                    : r.livePnl != null
                      ? "text-red-300"
                      : "text-white/55"
                }`}
              >
                {fmtPnl(r.livePnl)}
              </td>
              <td className="px-3 py-2 tabular-nums text-white/80">
                {fmtPrice(r.markPrice)}
              </td>
              <td className="px-3 py-2">
                {r.size != null && Number.isFinite(r.size) && r.size > 0 ? (
                  <button
                    type="button"
                    disabled={
                      closingKey ===
                      `${strategyId}:${r.token}:${r.side}:${variant === "master" ? "master" : closeUserId ?? "follower"}`
                    }
                    onClick={() =>
                      void onCloseTrade({
                        strategyId,
                        userId:
                          variant === "master" ? undefined : closeUserId,
                        symbol: r.token,
                        side: r.side,
                        size: r.size ?? 0,
                        isMaster: variant === "master",
                      })
                    }
                    className="rounded-md border border-red-500/45 bg-red-500/15 px-2.5 py-1 text-xs font-medium text-red-200 transition hover:bg-red-500/25 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Close Trade
                  </button>
                ) : (
                  <span className="text-xs text-white/35">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SubscriberUserCard({
  user,
  strategy,
  strategyId,
  onCloseTrade,
  closingKey,
}: {
  user: SubscriberUser;
  strategy: StrategySection;
  strategyId: string;
  onCloseTrade: (args: {
    strategyId: string;
    userId?: string;
    symbol: string;
    side: string;
    size: number;
    isMaster: boolean;
  }) => Promise<void>;
  closingKey: string | null;
}) {
  const totalPnl = sumLivePnl(user.positions);
  const pnlPositive = totalPnl > 0;
  const pnlNegative = totalPnl < 0;
  const mult =
    Number.isFinite(user.multiplier) && user.multiplier > 0
      ? user.multiplier
      : 1;

  const estTarget =
    strategy.autoExitTarget != null && Number.isFinite(strategy.autoExitTarget)
      ? strategy.autoExitTarget * mult
      : null;
  const estStop =
    strategy.autoExitStopLoss != null &&
    Number.isFinite(strategy.autoExitStopLoss)
      ? strategy.autoExitStopLoss * mult
      : null;

  return (
    <div className="overflow-hidden rounded-xl border border-violet-500/20 bg-gradient-to-br from-violet-500/[0.06] via-black/25 to-black/30">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-violet-500/15 bg-violet-500/[0.06] px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="rounded-lg border border-violet-500/25 bg-violet-500/10 p-2">
            <Users className="h-4 w-4 text-violet-300" aria-hidden />
          </div>
          <div>
            <p className="text-sm font-medium text-white">{user.userEmail}</p>
            <p className="text-xs text-white/45">
              Multiplier:{" "}
              <span className="font-semibold text-violet-300">
                {formatMultiplier(mult)}
              </span>
            </p>
          </div>
        </div>
        <p className="font-mono text-[10px] text-white/35">{user.userId}</p>
      </div>

      <div className="grid gap-3 border-b border-white/[0.06] bg-black/20 px-4 py-3 sm:grid-cols-3">
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wider text-white/40">
            Total live PnL
          </p>
          <p
            className={`mt-0.5 text-lg font-bold tabular-nums ${
              pnlPositive
                ? "text-emerald-400"
                : pnlNegative
                  ? "text-red-400"
                  : "text-white/70"
            }`}
          >
            {fmtPnl(totalPnl)}
          </p>
        </div>
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wider text-white/40">
            Est. target
          </p>
          <p className="mt-0.5 text-sm font-semibold tabular-nums text-emerald-300/90">
            {estTarget != null
              ? usdPnlFmt.format(estTarget).replace(/^\+/, "")
              : "—"}
          </p>
        </div>
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wider text-white/40">
            Est. stop loss
          </p>
          <p className="mt-0.5 text-sm font-semibold tabular-nums text-red-300/90">
            {estStop != null
              ? `−${usdPnlFmt.format(estStop).replace(/^\+/, "")}`
              : "—"}
          </p>
        </div>
      </div>

      {user.positions.length > 0 ? (
        <PositionTable
          rows={user.positions}
          variant="subscriber"
          strategyId={strategyId}
          followerUserId={user.userId}
          onCloseTrade={onCloseTrade}
          closingKey={closingKey}
        />
      ) : (
        <p className="px-4 py-6 text-sm text-white/45">No open positions.</p>
      )}
    </div>
  );
}

export default function AdminLiveTradesPage() {
  const [strategies, setStrategies] = useState<StrategySection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [closingKey, setClosingKey] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = Boolean(opts?.silent);
    if (!silent) {
      setLoading(true);
      setError(null);
      setForbidden(false);
    }
    const base = resolveAdminApiBase();
    if (!base) {
      if (!silent) {
        setError(
          "NEXT_PUBLIC_API_URL is not set and same-origin /api could not be resolved.",
        );
        setStrategies([]);
        setLoading(false);
      }
      return;
    }
    try {
      const res = await fetch(
        `${base}/admin/live-trades/grouped?t=${Date.now()}`,
        {
          cache: "no-store",
          headers: {
            Authorization: `Bearer ${localStorage.getItem("token") ?? ""}`,
            "Cache-Control": "no-cache",
            Pragma: "no-cache",
          },
        },
      );
      if (res.status === 403) {
        if (!silent) {
          setForbidden(true);
          setStrategies([]);
        }
        return;
      }
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const data: unknown = await res.json();
      const rawList =
        typeof data === "object" &&
        data !== null &&
        "strategies" in data &&
        Array.isArray((data as { strategies: unknown }).strategies)
          ? (data as { strategies: unknown[] }).strategies
          : [];
      const list: StrategySection[] = rawList.map((item) => {
        const row = item as Record<string, unknown>;
        return {
          strategyId: String(row.strategyId ?? ""),
          strategyTitle: String(row.strategyTitle ?? ""),
          autoExitTarget:
            typeof row.autoExitTarget === "number" ? row.autoExitTarget : null,
          autoExitStopLoss:
            typeof row.autoExitStopLoss === "number"
              ? row.autoExitStopLoss
              : null,
          masterPositions: Array.isArray(row.masterPositions)
            ? (row.masterPositions as LiveRow[])
            : [],
          subscribers: Array.isArray(row.subscribers)
            ? (row.subscribers as SubscriberUser[]).map((sub) => ({
                userId: String((sub as SubscriberUser).userId ?? ""),
                userEmail: String((sub as SubscriberUser).userEmail ?? ""),
                multiplier:
                  typeof (sub as SubscriberUser).multiplier === "number"
                    ? (sub as SubscriberUser).multiplier
                    : 1,
                positions: Array.isArray((sub as SubscriberUser).positions)
                  ? ((sub as SubscriberUser).positions as LiveRow[])
                  : [],
              }))
            : [],
        };
      });
      setStrategies(list);
      setLastRefreshed(new Date());
    } catch (e) {
      if (!silent) {
        setError(e instanceof Error ? e.message : "Failed to load");
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  const closeTrade = useCallback(
    async (args: {
      strategyId: string;
      userId?: string;
      symbol: string;
      side: string;
      size: number;
      isMaster: boolean;
    }) => {
      const key = `${args.strategyId}:${args.symbol}:${args.side}:${args.userId ?? "master"}`;
      setClosingKey(key);
      try {
        const base = resolveAdminApiBase();
        const res = await fetch(`${base}/admin/trades/close-manual`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${localStorage.getItem("token") ?? ""}`,
          },
          body: JSON.stringify(args),
        });
        const payload: unknown = await res.json().catch(() => ({}));
        if (!res.ok) {
          const msg =
            typeof payload === "object" &&
            payload !== null &&
            "error" in payload &&
            typeof (payload as { error: unknown }).error === "string"
              ? (payload as { error: string }).error
              : `Close failed (${res.status})`;
          throw new Error(msg);
        }
        await load({ silent: true });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to close trade");
      } finally {
        setClosingKey(null);
      }
    },
    [load],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- on-mount fetch is a legitimate effect side-effect
    void load();
  }, [load]);

  useEffect(() => {
    const id = window.setInterval(() => {
      void load({ silent: true });
    }, 500);
    return () => window.clearInterval(id);
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(id);
  }, [toast]);

  if (forbidden) {
    return (
      <div className="rounded-xl border border-red-500/35 bg-red-500/10 px-6 py-10 text-center text-sm text-red-100">
        Admin access required.
        <Link href="/dashboard" className="mt-4 block text-primary hover:underline">
          Back to dashboard
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="rounded-xl border border-glassBorder bg-primary/10 p-3">
            <Layers className="h-6 w-6 text-primary" aria-hidden />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">
              Live trades
            </h1>
            <p className="mt-1 text-sm text-white/55">
              Data comes from CCXT + live WebSocket marks. PnL and mark prices refresh about every 0.5 seconds
              while this page is open. New master fills are copied to subscribers by the backend trade
              engine (WebSocket to Delta); restart the API if copy ever stops.
            </p>
            {lastRefreshed && !loading && (
              <p className="mt-0.5 text-xs text-white/40">
                Last refresh: {lastRefreshed.toLocaleTimeString()}
              </p>
            )}
          </div>
        </div>
      </header>

      {toast && (
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">
          {toast}
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="h-10 w-10 animate-spin text-primary" />
        </div>
      ) : (
        <div className="space-y-10">
          {strategies.map((s) => (
            <section
              key={s.strategyId}
              className="glass-card border border-glassBorder p-5 md:p-6"
            >
              <h2 className="text-lg font-semibold text-white">
                {s.strategyTitle}
              </h2>
              <p className="mt-1 text-xs text-white/45">
                Strategy ID:{" "}
                <span className="font-mono text-white/55">{s.strategyId}</span>
              </p>

              <RiskManagementPanel
                strategy={s}
                totalLivePnl={sumLivePnl(s.masterPositions)}
                onSaved={(message, updated) => {
                  setToast(message);
                  if (updated) {
                    setStrategies((prev) =>
                      prev.map((row) =>
                        row.strategyId === s.strategyId
                          ? { ...row, ...updated }
                          : row,
                      ),
                    );
                  }
                  if (message.includes("saved")) {
                    void load({ silent: true });
                  }
                }}
              />

              <div className="mt-6 overflow-hidden rounded-xl border border-primary/25 bg-black/20">
                <div className="border-b border-primary/25 bg-primary/5 px-4 py-2">
                  <p className="text-xs font-semibold uppercase tracking-wider text-primary/90">
                    ADMIN · MASTER DELTA
                  </p>
                  <p className="mt-0.5 text-[11px] font-normal normal-case tracking-normal text-white/45">
                    Open positions from CCXT (<code className="text-white/55">fetchPositions</code>, Delta India)
                  </p>
                </div>
                {s.masterPositions.length > 0 ? (
                  <PositionTable
                    rows={s.masterPositions}
                    variant="master"
                    strategyId={s.strategyId}
                    onCloseTrade={closeTrade}
                    closingKey={closingKey}
                  />
                ) : (
                  <p className="px-4 py-6 text-sm text-white/50">
                    No open positions reported for this strategy&apos;s master Delta account.
                  </p>
                )}
              </div>

              <div className="mt-8">
                <h3 className="text-sm font-medium text-white/80">
                  Subscribers
                </h3>
                <p className="mt-1 text-xs text-white/45">
                  One card per user — all matched open legs on Delta India.
                </p>
                {s.subscribers.length === 0 ? (
                  <p className="mt-3 text-sm text-white/45">
                    No subscriber positions — either the master has no open legs or no active
                    subscribers with matching Delta positions.
                  </p>
                ) : (
                  <div className="mt-4 space-y-6">
                    {s.subscribers.map((user) => (
                      <SubscriberUserCard
                        key={`${s.strategyId}-${user.userId}`}
                        user={user}
                        strategy={s}
                        strategyId={s.strategyId}
                        onCloseTrade={closeTrade}
                        closingKey={closingKey}
                      />
                    ))}
                  </div>
                )}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
