"use client";

import { useCallback, useEffect, useState } from "react";
import { Layers, Loader2 } from "lucide-react";
import Link from "next/link";

const API_BASE = process.env.NEXT_PUBLIC_API_URL;

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

type CosmicScrapeDiagnostics = {
  payloadChunkCount: number;
  payloadPositionRows: number;
  tradesAfterDeltaFilter: number;
  domRowsMatched?: number;
  domPositionsParsed?: number;
  walletBalanceDom?: string | null;
  scrapeAbortedReason?: string;
  extractError?: string;
};

type StrategySection = {
  strategyId: string;
  strategyTitle: string;
  groups: Group[];
  cosmicMeta?: {
    scraperEnvConfigured: boolean;
    credentialsPresent: boolean;
    fetchException?: string;
    lastScrape?: CosmicScrapeDiagnostics;
  };
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
      const res = await fetch(`${API_BASE}/admin/live-trades/grouped`, {
        headers: {
          Authorization: `Bearer ${localStorage.getItem("token") ?? ""}`,
        },
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
                <div className="mt-6 space-y-2 text-sm text-white/50">
                  <p>No open Cosmic positions were parsed for this strategy.</p>
                  {s.cosmicMeta?.fetchException ? (
                    <p className="rounded-lg border border-red-500/35 bg-red-500/10 px-3 py-2 text-red-100/95">
                      Scrape error:{" "}
                      <span className="font-mono text-xs text-red-50/90">
                        {s.cosmicMeta.fetchException}
                      </span>
                      <span className="mt-1 block text-xs text-red-100/70">
                        Often caused by API timeouts (Puppeteer needs a long-lived Node process),
                        missing Chromium on the server, or blocked outbound HTTPS.
                      </span>
                    </p>
                  ) : null}
                  {s.cosmicMeta?.lastScrape ? (
                    <div className="rounded-lg border border-white/[0.12] bg-white/[0.04] px-3 py-2 font-mono text-[11px] leading-relaxed text-white/65">
                      <p className="mb-1 text-[10px] uppercase tracking-wide text-white/40">
                        Last scrape diagnostics
                      </p>
                      <p>
                        payloadChunks={s.cosmicMeta.lastScrape.payloadChunkCount}{" "}
                        · rowsInPayloads=
                        {s.cosmicMeta.lastScrape.payloadPositionRows} · afterDelta=
                        {s.cosmicMeta.lastScrape.tradesAfterDeltaFilter}
                      </p>
                      {(s.cosmicMeta.lastScrape.domRowsMatched !== undefined ||
                        s.cosmicMeta.lastScrape.domPositionsParsed !==
                          undefined) && (
                        <p>
                          domRowsMatched=
                          {String(s.cosmicMeta.lastScrape.domRowsMatched ?? "—")}{" "}
                          · domPositionsParsed=
                          {String(s.cosmicMeta.lastScrape.domPositionsParsed ?? "—")}
                        </p>
                      )}
                      {s.cosmicMeta.lastScrape.walletBalanceDom ? (
                        <p className="truncate text-emerald-200/80">
                          wallet (DOM): {s.cosmicMeta.lastScrape.walletBalanceDom}
                        </p>
                      ) : null}
                      {s.cosmicMeta.lastScrape.scrapeAbortedReason ? (
                        <p className="text-amber-200/90">
                          aborted: {s.cosmicMeta.lastScrape.scrapeAbortedReason}
                        </p>
                      ) : null}
                      {s.cosmicMeta.lastScrape.extractError ? (
                        <p className="text-amber-200/90">
                          extract: {s.cosmicMeta.lastScrape.extractError}
                        </p>
                      ) : null}
                      {s.cosmicMeta.lastScrape.payloadPositionRows > 0 &&
                      s.cosmicMeta.lastScrape.tradesAfterDeltaFilter === 0 ? (
                        <p className="mt-1 text-white/55">
                          Rows were parsed from Cosmic but none survived Delta symbol mapping —
                          check backend logs for{" "}
                          <code className="rounded bg-black/30 px-1">
                            [cosmic] No Delta mapping
                          </code>
                          .
                        </p>
                      ) : null}
                      {s.cosmicMeta.lastScrape.domRowsMatched === 0 &&
                      (s.cosmicMeta.lastScrape.payloadPositionRows ?? 0) === 0 &&
                      !s.cosmicMeta.lastScrape.scrapeAbortedReason ? (
                        <p className="mt-1 text-white/55">
                          No DOM rows and no JSON payload positions — login may have failed or the
                          portfolio layout differs from Scraper Studio. Confirm{" "}
                          <strong className="text-white/70">COSMIC_SCRAPER_LOGIN_URL</strong> and
                          run <strong className="text-white/70">Test scrape</strong>.
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                  {!s.cosmicMeta?.scraperEnvConfigured ? (
                    <p className="text-amber-200/85">
                      API env missing{" "}
                      <code className="rounded bg-white/10 px-1 text-[11px] text-white/70">
                        COSMIC_SCRAPER_LOGIN_URL
                      </code>
                      — the headless browser never opens Cosmic. Set it on the server and restart.
                    </p>
                  ) : null}
                  {s.cosmicMeta?.scraperEnvConfigured &&
                  !s.cosmicMeta?.credentialsPresent ? (
                    <p className="text-amber-200/85">
                      Strategy has no saved Cosmic email/password — add them under Admin → Strategies → Edit.
                    </p>
                  ) : null}
                  {s.cosmicMeta?.scraperEnvConfigured &&
                  s.cosmicMeta?.credentialsPresent ? (
                    <p>
                      If the master account does have open trades, check Puppeteer selectors and{" "}
                      <code className="rounded bg-white/10 px-1 text-[11px] text-white/70">
                        COSMIC_SCRAPER_RESPONSE_FILTER
                      </code>{" "}
                      on the API host. Use <strong className="text-white/70">Strategies → Test scrape</strong> to debug.
                    </p>
                  ) : null}
                </div>
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
