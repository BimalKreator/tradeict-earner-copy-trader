"use client";

import { useCallback, useEffect, useState } from "react";
import { Layers, Loader2 } from "lucide-react";
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

type FollowerGroup = {
  token: string;
  side: string;
  followers: FollowerRow[];
};

type StrategySection = {
  strategyId: string;
  strategyTitle: string;
  /** CCXT open positions on the strategy master Delta (India) account. */
  masterPositions: LiveRow[];
  groups: FollowerGroup[];
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
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return usdPnlFmt.format(n);
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
  onCloseTrade,
  closingKey,
}: {
  rows: (LiveRow | FollowerRow)[];
  variant: "master" | "follower";
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
  return (
    <div className="scroll-table overflow-x-auto">
      <table className="w-full min-w-[980px] text-left text-sm">
        <thead
          className={
            variant === "master"
              ? "border-b border-primary/35 bg-primary/10"
              : "border-b border-white/[0.08] bg-black/25"
          }
        >
          <tr>
            {variant === "follower" ? (
              <th className="px-3 py-2 font-medium text-white/70">User</th>
            ) : (
              <th className="px-3 py-2 font-medium text-primary/90">Source</th>
            )}
            <th className="px-3 py-2 font-medium text-white/70">Entry time</th>
            <th className="px-3 py-2 font-medium text-white/70">Token</th>
            <th className="px-3 py-2 font-medium text-white/70">Side</th>
            <th className="px-3 py-2 font-medium text-white/70">
              Entry price
            </th>
            <th className="px-3 py-2 font-medium text-white/70">SL</th>
            <th className="px-3 py-2 font-medium text-white/70">Target</th>
            <th className="px-3 py-2 font-medium text-white/70">Live PnL</th>
            <th className="px-3 py-2 font-medium text-white/70">Mark price</th>
            <th className="px-3 py-2 font-medium text-white/70">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, idx) => (
            <tr
              key={idx}
              className="border-b border-white/[0.05] last:border-0 hover:bg-white/[0.02]"
            >
              <td className="whitespace-nowrap px-3 py-2 text-xs text-white/75">
                {variant === "follower"
                  ? (r as FollowerRow).userEmail
                  : "ADMIN · MASTER DELTA"}
              </td>
              <td className="whitespace-nowrap px-3 py-2 tabular-nums text-white/55">
                {fmtTime(r.entryTime)}
              </td>
              <td className="px-3 py-2 font-medium text-white">{r.token}</td>
              <td className="px-3 py-2 text-white/65">{r.side}</td>
              <td className="px-3 py-2 tabular-nums text-white/80">
                {fmtPrice(r.entryPrice)}
              </td>
              <td className="px-3 py-2 tabular-nums text-white/65">
                {fmtPrice(r.stopLoss)}
              </td>
              <td className="px-3 py-2 tabular-nums text-white/65">
                {fmtPrice(r.target)}
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
                      `${strategyId}:${r.token}:${r.side}:${variant === "follower" ? (r as FollowerRow).userId : "master"}`
                    }
                    onClick={() =>
                      void onCloseTrade({
                        strategyId,
                        userId:
                          variant === "follower"
                            ? (r as FollowerRow).userId
                            : undefined,
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

export default function AdminLiveTradesPage() {
  const [strategies, setStrategies] = useState<StrategySection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [closingKey, setClosingKey] = useState<string | null>(null);

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
      const res = await fetch(`${base}/admin/live-trades/grouped`, {
        headers: {
          Authorization: `Bearer ${localStorage.getItem("token") ?? ""}`,
        },
      });
      if (res.status === 403) {
        if (!silent) {
          setForbidden(true);
          setStrategies([]);
        }
        return;
      }
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const data: unknown = await res.json();
      const list =
        typeof data === "object" &&
        data !== null &&
        "strategies" in data &&
        Array.isArray((data as { strategies: unknown }).strategies)
          ? ((data as { strategies: StrategySection[] }).strategies)
          : [];
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
    }, 8000);
    return () => window.clearInterval(id);
  }, [load]);

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
              Data comes from CCXT + market tickers. PnL and mark prices update about every 5 seconds
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
                  Subscribers (matched legs)
                </h3>
                {s.groups.length === 0 ? (
                  <p className="mt-3 text-sm text-white/45">
                    No legs to match — either the master has no open positions or there are no active
                    subscribers with linked exchange accounts.
                  </p>
                ) : (
                  <div className="mt-4 space-y-8">
                    {s.groups.map((g, gi) => (
                      <div
                        key={`${s.strategyId}-${g.token}-${g.side}-${gi}`}
                        className="overflow-hidden rounded-xl border border-white/[0.08] bg-black/20"
                      >
                        <div className="border-b border-white/[0.06] bg-white/[0.02] px-4 py-2">
                          <p className="text-xs font-semibold uppercase tracking-wider text-white/55">
                            ADMIN · SUBSCRIBERS DELTA · {g.token} · {g.side}
                          </p>
                        </div>
                        {g.followers.length === 0 ? (
                          <p className="px-4 py-6 text-sm text-white/45">
                            No matching open Delta positions for active subscribers on this leg.
                          </p>
                        ) : (
                          <PositionTable
                            rows={g.followers}
                            variant="follower"
                            strategyId={s.strategyId}
                            onCloseTrade={closeTrade}
                            closingKey={closingKey}
                          />
                        )}
                      </div>
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
