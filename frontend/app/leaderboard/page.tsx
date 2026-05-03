"use client";

import {
  ArrowLeft,
  Crown,
  Loader2,
  Medal,
  Percent,
  TrendingUp,
  Trophy,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { getPublicApiBase } from "@/lib/publicApi";

const API_BASE = `${getPublicApiBase()}/leaderboard`;

type Period = {
  label: string;
  startUtc: string;
  endUtc: string;
};

type StrategyRow = {
  rank: number;
  strategyId: string;
  title: string;
  monthlyProfit: number;
  minCapital: number;
  monthlyRoiPercent: number;
};

type EarnerRow = {
  rank: number;
  maskedEmail: string;
  monthlyProfit: number;
};

type LeaderboardPayload = {
  period: Period;
  strategies: StrategyRow[];
  earners: EarnerRow[];
};

export default function LeaderboardPage() {
  const [data, setData] = useState<LeaderboardPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(API_BASE);
        if (!res.ok) throw new Error(`Could not load leaderboard (${res.status})`);
        const json: unknown = await res.json();
        if (
          typeof json !== "object" ||
          json === null ||
          !("strategies" in json) ||
          !("earners" in json)
        ) {
          throw new Error("Invalid response");
        }
        if (!cancelled) setData(json as LeaderboardPayload);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load");
          setData(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-5xl px-4 py-10 md:px-8 lg:py-14">
        <Link
          href="/login"
          className="inline-flex items-center gap-2 text-sm text-white/55 transition hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Back to login
        </Link>

        <header className="mt-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex items-start gap-4">
            <div className="rounded-2xl border border-glassBorder bg-primary/10 p-4">
              <Trophy className="h-10 w-10 text-primary" aria-hidden />
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-widest text-primary">
                Public leaderboard
              </p>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white md:text-4xl">
                Monthly standings
              </h1>
              <p className="mt-3 max-w-xl text-sm leading-relaxed text-white/55">
                Rankings use aggregated realized PnL from TradeICT this calendar month (UTC).
                Strategy ROI compares total follower profit to each strategy&apos;s minimum
                capital.
              </p>
            </div>
          </div>
          {data?.period && (
            <div className="rounded-xl border border-glassBorder bg-white/[0.03] px-4 py-3 text-right">
              <p className="text-[10px] font-medium uppercase tracking-wider text-white/40">
                Period (UTC)
              </p>
              <p className="mt-1 text-lg font-semibold tabular-nums text-white">
                {data.period.label}
              </p>
            </div>
          )}
        </header>

        {error && (
          <div className="mt-8 rounded-xl border border-red-500/35 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            {error}
          </div>
        )}

        {loading ? (
          <div className="mt-16 flex flex-col items-center justify-center gap-3 text-white/50">
            <Loader2 className="h-10 w-10 animate-spin text-primary" aria-hidden />
            <p className="text-sm">Loading leaderboard…</p>
          </div>
        ) : (
          <div className="mt-12 grid gap-10 lg:grid-cols-5 lg:gap-8">
            <section className="glass-card border border-glassBorder lg:col-span-3">
              <div className="flex items-center gap-2 border-b border-glassBorder px-5 py-4 md:px-6">
                <TrendingUp className="h-5 w-5 text-emerald-400" aria-hidden />
                <h2 className="text-lg font-semibold text-white">
                  Top strategies by monthly ROI
                </h2>
              </div>
              <div className="scroll-table overflow-x-auto">
                <table className="w-full min-w-[520px] text-left text-sm">
                  <thead className="border-b border-white/[0.06] bg-white/[0.02]">
                    <tr>
                      <th className="px-4 py-3 font-medium text-white/55 md:px-6">#</th>
                      <th className="px-4 py-3 font-medium text-white/55 md:px-6">
                        Strategy
                      </th>
                      <th className="px-4 py-3 text-right font-medium text-white/55 md:px-6">
                        Profit (mo.)
                      </th>
                      <th className="px-4 py-3 text-right font-medium text-white/55 md:px-6">
                        ROI
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data?.strategies.length ?? 0) === 0 ? (
                      <tr>
                        <td
                          colSpan={4}
                          className="px-6 py-14 text-center text-white/45"
                        >
                          No strategy PnL recorded this month yet.
                        </td>
                      </tr>
                    ) : (
                      data!.strategies.map((row) => (
                        <tr
                          key={row.strategyId}
                          className="border-b border-white/[0.04] last:border-0 hover:bg-white/[0.02]"
                        >
                          <td className="px-4 py-3.5 md:px-6">
                            <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-white/[0.06] text-xs font-semibold tabular-nums text-white">
                              {row.rank === 1 ? (
                                <Crown className="h-4 w-4 text-amber-400" aria-hidden />
                              ) : row.rank === 2 ? (
                                <Medal className="h-4 w-4 text-slate-300" aria-hidden />
                              ) : row.rank === 3 ? (
                                <Medal className="h-4 w-4 text-amber-700" aria-hidden />
                              ) : (
                                row.rank
                              )}
                            </span>
                          </td>
                          <td className="px-4 py-3.5 font-medium text-white md:px-6">
                            {row.title}
                          </td>
                          <td className="px-4 py-3.5 text-right tabular-nums text-white/85 md:px-6">
                            ₹
                            {row.monthlyProfit.toLocaleString("en-IN", {
                              maximumFractionDigits: 0,
                            })}
                          </td>
                          <td className="px-4 py-3.5 text-right md:px-6">
                            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-semibold tabular-nums text-emerald-300">
                              <Percent className="h-3 w-3 opacity-80" aria-hidden />
                              {row.monthlyRoiPercent.toFixed(1)}%
                            </span>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="glass-card border border-glassBorder lg:col-span-2">
              <div className="flex items-center gap-2 border-b border-glassBorder px-5 py-4 md:px-6">
                <Wallet className="h-5 w-5 text-sky-400" aria-hidden />
                <h2 className="text-lg font-semibold text-white">Top earners</h2>
              </div>
              <div className="divide-y divide-white/[0.06] px-5 py-2 md:px-6">
                {(data?.earners.length ?? 0) === 0 ? (
                  <p className="py-12 text-center text-sm text-white/45">
                    No trader PnL recorded this month yet.
                  </p>
                ) : (
                  data!.earners.map((row) => (
                    <div
                      key={`${row.rank}-${row.maskedEmail}`}
                      className="flex items-center justify-between gap-3 py-4"
                    >
                      <div className="flex items-center gap-3">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-xs font-bold text-primary">
                          {row.rank}
                        </span>
                        <div>
                          <p className="font-mono text-sm text-white">{row.maskedEmail}</p>
                          <p className="text-[11px] text-white/35">Trader</p>
                        </div>
                      </div>
                      <p className="shrink-0 text-sm font-semibold tabular-nums text-emerald-300/95">
                        ₹
                        {row.monthlyProfit.toLocaleString("en-IN", {
                          maximumFractionDigits: 0,
                        })}
                      </p>
                    </div>
                  ))
                )}
              </div>
              <p className="border-t border-glassBorder px-5 py-3 text-[11px] text-white/35 md:px-6">
                Emails are masked for privacy.
              </p>
            </section>
          </div>
        )}

        <p className="mt-14 text-center text-xs text-white/30">
          ROI = Σ monthly follower profit ÷ strategy min. capital · Updated from live PnL
          records.
        </p>
      </div>
    </div>
  );
}
