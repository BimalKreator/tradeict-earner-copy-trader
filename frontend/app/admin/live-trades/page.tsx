"use client";

import { useCallback, useEffect, useState } from "react";
import { Layers, Loader2 } from "lucide-react";
import Link from "next/link";

const API_BASE = process.env.NEXT_PUBLIC_API_URL;

function authHeaders(): HeadersInit {
  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

type LiveRow = {
  entryTime: string | null;
  token: string;
  entryPrice: number | null;
  stopLoss: number | null;
  target: number | null;
  livePnl: number | null;
  markPrice: number | null;
  side: string;
};

type FollowerRow = LiveRow & { userEmail: string };

type Group = {
  cosmic: LiveRow;
  followers: FollowerRow[];
};

type StrategySection = {
  strategyId: string;
  strategyTitle: string;
  groups: Group[];
};

function fmtPrice(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 6 })}`;
}

function fmtPnl(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const sign = n >= 0 ? "+" : "";
  return `${sign}₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
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
}: {
  rows: (LiveRow | FollowerRow)[];
  variant: "cosmic" | "follower";
}) {
  return (
    <div className="scroll-table overflow-x-auto">
      <table className="w-full min-w-[880px] text-left text-sm">
        <thead
          className={
            variant === "cosmic"
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
                  : "Cosmic.trade (strategy)"}
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

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setForbidden(false);
    try {
      const res = await fetch(`${API_BASE}/live-trades/admin/grouped`, {
        headers: authHeaders(),
      });
      if (res.status === 403) {
        setForbidden(true);
        setStrategies([]);
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
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
      setStrategies([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
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
              Cosmic positions per strategy and mirrored Delta positions for subscribers.
            </p>
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

              {s.groups.length === 0 ? (
                <p className="mt-6 text-sm text-white/50">
                  No open Cosmic positions for this strategy (or Cosmic API unavailable).
                </p>
              ) : (
                <div className="mt-6 space-y-8">
                  {s.groups.map((g, gi) => (
                    <div
                      key={`${s.strategyId}-${g.cosmic.token}-${g.cosmic.side}-${gi}`}
                      className="rounded-xl border border-white/[0.08] bg-black/20 overflow-hidden"
                    >
                      <div className="border-b border-primary/25 bg-primary/5 px-4 py-2">
                        <p className="text-xs font-medium uppercase tracking-wider text-primary/90">
                          Admin · Cosmic.trade
                        </p>
                      </div>
                      <PositionTable rows={[g.cosmic]} variant="cosmic" />

                      <div className="border-t border-white/[0.06] bg-white/[0.02] px-4 py-2">
                        <p className="text-xs font-medium uppercase tracking-wider text-white/50">
                          Subscribers · Delta Exchange
                        </p>
                      </div>
                      {g.followers.length === 0 ? (
                        <p className="px-4 py-6 text-sm text-white/45">
                          No matching open Delta positions for active subscribers with linked exchange accounts.
                        </p>
                      ) : (
                        <PositionTable rows={g.followers} variant="follower" />
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
