"use client";

import { ChevronDown, ChevronRight, Loader2, RefreshCw, TrendingUp } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  authFetch,
} from "@/lib/authFetch";
import { RevenueInvoiceTable } from "@/components/billing/RevenueInvoiceTable";
import { StrategySubscriptionFees } from "@/components/billing/StrategySubscriptionFees";
import { HighWaterMarkCard } from "@/components/money/HighWaterMarkCard";
import { MoneyDisplay, MoneyDisplayCompact } from "@/components/money/MoneyDisplay";
import {
  DetailRow,
  MoneyRowCard,
  ResponsiveMoneyTable,
} from "@/components/money/MoneyRowCard";
import { useUsdInrRate } from "@/hooks/useUsdInrRate";
import { resolveApiBase } from "@/lib/apiBase";
import { fmtUsd } from "@/lib/currency";
import type { RevenueInvoiceRow } from "@/lib/revenueInvoiceTypes";
import {
  formatIstCalendarDate,
  formatIstDateTime,
  formatIstSnapshotDay,
  currentIstYearMonth,
  isUtcInstantInIstMonth,
} from "@/lib/istDates";

type StructureLeg = {
  id: string;
  botLegId: number;
  legRole: string;
  productId: number;
  symbol: string | null;
  strike: number | null;
  side: string;
  quantity: number;
  openedAt: string;
  closedAt: string | null;
  grossCashflow: number;
  commissionTotal: number;
  realizedPnl: number | null;
  matchedTxnCount: number;
};

type StructureRow = {
  id: string;
  botStructureId: number;
  underlying: string;
  status: string;
  openedAt: string;
  closedAt: string | null;
  closeReason: string | null;
  grossCashflow: number;
  commissionTotal: number;
  realizedPnl: number | null;
  legCount: number;
  closedLegCount: number;
  matchedTxnCount: number;
  legs: StructureLeg[];
};

type DailySnapshot = {
  snapshotDate: string;
  realizedDelta: number;
  cumulativeRealized: number;
  highWaterMark: number;
  commissionAccrued: number;
  commissionCumulative: number;
  openStructureCount: number;
};

type RevenueInvoice = RevenueInvoiceRow;


function fmtDay(iso: string): string {
  return formatIstCalendarDate(iso);
}

function fmtSnapshotDay(iso: string): string {
  return formatIstSnapshotDay(iso);
}

function LegStatusPill({ open }: { open: boolean }) {
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
        open ? "bg-amber-500/15 text-amber-200" : "bg-emerald-500/15 text-emerald-200"
      }`}
    >
      {open ? "Open" : "Closed"}
    </span>
  );
}

function SummaryCard({
  title,
  value,
  basis,
  loading,
}: {
  title: string;
  value: ReactNode;
  basis?: string;
  loading?: boolean;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <p className="text-xs uppercase tracking-wide text-white/45">{title}</p>
      <div className="mt-2 min-h-[2rem] text-xl font-semibold text-white">
        {loading ? <Loader2 className="h-5 w-5 animate-spin text-white/40" /> : value}
      </div>
      {basis ? <p className="mt-2 text-xs leading-relaxed text-white/40">{basis}</p> : null}
    </div>
  );
}

function SectionLoadError({
  onRetry,
  busy,
}: {
  onRetry: () => void;
  busy?: boolean;
}) {
  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-6 text-center">
      <p className="text-sm text-amber-100">Couldn&apos;t load this — retry</p>
      <button
        type="button"
        onClick={onRetry}
        disabled={busy}
        className="mt-3 inline-flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/15 px-3 py-1.5 text-xs font-semibold text-amber-50 hover:bg-amber-500/25 disabled:opacity-50"
      >
        <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} />
        Retry
      </button>
    </div>
  );
}

export function PerformanceDashboard() {
  const { rate: usdInrRate } = useUsdInrRate();
  const [loading, setLoading] = useState(true);
  const [structures, setStructures] = useState<StructureRow[]>([]);
  const [snapshots, setSnapshots] = useState<DailySnapshot[]>([]);
  const [invoices, setInvoices] = useState<RevenueInvoice[]>([]);
  const [walletBalance, setWalletBalance] = useState<number | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [structuresError, setStructuresError] = useState(false);
  const [dailyError, setDailyError] = useState(false);
  const [invoicesError, setInvoicesError] = useState(false);

  const load = useCallback(async () => {
    if (!resolveApiBase()) {
      console.error("[performance] API URL is not configured");
      setLoading(false);
      setStructuresError(true);
      setDailyError(true);
      setInvoicesError(true);
      return;
    }
    setLoading(true);
    try {
      const [sRes, pRes, iRes, wRes] = await Promise.all([
        authFetch("/me/structures?limit=100"),
        authFetch("/me/pnl/daily"),
        authFetch("/me/revenue/invoices"),
        authFetch("/wallet/me"),
      ]);

      if (!sRes.ok) {
        console.error("[performance] structures failed", sRes.status);
        setStructuresError(true);
        setStructures([]);
      } else {
        setStructuresError(false);
        const sJson = (await sRes.json()) as { structures: StructureRow[] };
        setStructures(sJson.structures ?? []);
      }

      if (!pRes.ok) {
        console.error("[performance] daily P&L failed", pRes.status);
        setDailyError(true);
        setSnapshots([]);
      } else {
        setDailyError(false);
        const pJson = (await pRes.json()) as { snapshots: DailySnapshot[] };
        setSnapshots(pJson.snapshots ?? []);
      }

      if (!iRes.ok) {
        console.error("[performance] invoices failed", iRes.status);
        setInvoicesError(true);
        setInvoices([]);
      } else {
        setInvoicesError(false);
        const iJson = (await iRes.json()) as { invoices: RevenueInvoice[] };
        setInvoices(iJson.invoices ?? []);
      }

      if (wRes.ok) {
        const wJson = (await wRes.json()) as {
          balance?: number;
          balanceUsd?: number;
        };
        setWalletBalance(wJson.balanceUsd ?? wJson.balance ?? null);
      } else {
        console.error("[performance] wallet failed", wRes.status);
        setWalletBalance(null);
      }
    } catch (err) {
      console.error("[performance] load failed", err);
      setStructuresError(true);
      setDailyError(true);
      setInvoicesError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (loading || typeof window === "undefined") return;
    if (window.location.hash !== "#invoices") return;
    const el = document.getElementById("invoices");
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [loading]);

  const latest = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;
  const closedStructures = structures.filter((s) => s.status === "closed");
  const openStructures = structures.filter((s) => s.status !== "closed");

  const thisMonthRealized = useMemo(() => {
    const { year, month } = currentIstYearMonth();
    return snapshots
      .filter((s) => isUtcInstantInIstMonth(s.snapshotDate, year, month))
      .reduce((sum, s) => sum + s.realizedDelta, 0);
  }, [snapshots]);

  const chartData = useMemo(
    () =>
      snapshots.map((s) => ({
        day: fmtSnapshotDay(s.snapshotDate),
        cumulativeRealized: s.cumulativeRealized,
        highWaterMark: s.highWaterMark,
        hwmGap: Math.max(0, s.highWaterMark - s.cumulativeRealized),
      })),
    [snapshots],
  );

  const hasClosedHistory =
    !dailyError &&
    (closedStructures.length > 0 ||
      snapshots.some((s) => s.cumulativeRealized !== 0 || s.realizedDelta !== 0));

  const profitSharePct = useMemo(() => {
    if (invoicesError) return null;
    const withShare = invoices.find((inv) => inv.profitSharePct > 0);
    return withShare?.profitSharePct ?? invoices[0]?.profitSharePct ?? null;
  }, [invoices, invoicesError]);

  return (
    <div className="mx-auto max-w-6xl space-y-8 px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-[#0A84FF]">
            <TrendingUp className="h-5 w-5" />
            <span className="text-sm font-medium uppercase tracking-wide">Performance</span>
          </div>
          <h1 className="mt-1 text-2xl font-semibold text-white">Your Delta account</h1>
          <p className="mt-2 max-w-2xl text-sm text-white/55">
            All figures come from your own Delta wallet transactions. Open positions are never
            shown as realized P&amp;L.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-lg border border-white/15 px-3 py-2 text-sm text-white/80 hover:bg-white/5 disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {dailyError ? (
        <SectionLoadError onRetry={() => void load()} busy={loading} />
      ) : (
        <HighWaterMarkCard
          loading={loading}
          hasData={hasClosedHistory}
          cumulativeRealized={latest?.cumulativeRealized ?? null}
          highWaterMark={latest?.highWaterMark ?? null}
          profitSharePct={profitSharePct}
          rate={usdInrRate}
        />
      )}

      <section className="space-y-3">
        <h2 className="text-lg font-medium text-white">Summary</h2>
        {dailyError ? (
          <SectionLoadError onRetry={() => void load()} busy={loading} />
        ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <SummaryCard
            title="Cumulative realized P&L"
            loading={loading}
            basis="Realized from your Delta account. Open positions are not included."
            value={
              <MoneyDisplay
                usd={latest?.cumulativeRealized ?? (hasClosedHistory ? 0 : null)}
                rate={usdInrRate}
                align="left"
              />
            }
          />
          <SummaryCard
            title="High-water mark"
            loading={loading}
            basis="Your lifetime best cumulative realized P&L."
            value={
              <MoneyDisplay
                usd={latest?.highWaterMark ?? (hasClosedHistory ? 0 : null)}
                rate={usdInrRate}
                align="left"
                mode="neutral"
              />
            }
          />
          <SummaryCard
            title="Commission to date"
            loading={loading}
            basis="Accrued only on profit above your previous best."
            value={
              <MoneyDisplay
                usd={latest?.commissionCumulative ?? (hasClosedHistory ? 0 : null)}
                rate={usdInrRate}
                align="left"
                mode="neutral"
              />
            }
          />
          <SummaryCard
            title="Open structures"
            loading={loading}
            value={
              latest != null
                ? String(latest.openStructureCount)
                : openStructures.length > 0
                  ? String(openStructures.length)
                  : "0"
            }
          />
          <SummaryCard
            title="This month's realized"
            loading={loading}
            basis="Structures that closed this calendar month (IST)."
            value={
              <MoneyDisplay
                usd={hasClosedHistory || thisMonthRealized !== 0 ? thisMonthRealized : null}
                rate={usdInrRate}
                align="left"
              />
            }
          />
        </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium text-white">Daily cumulative P&L</h2>
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
          {loading ? (
            <div className="flex h-64 items-center justify-center">
              <Loader2 className="h-8 w-8 animate-spin text-white/30" />
            </div>
          ) : dailyError ? (
            <SectionLoadError onRetry={() => void load()} busy={loading} />
          ) : chartData.length === 0 ? (
            <p className="py-12 text-center text-sm text-white/45">
              No daily snapshots yet. Once a structure closes, your cumulative realized P&amp;L
              will appear here — matched to your Delta account.
            </p>
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <ComposedChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
                <XAxis dataKey="day" tick={{ fill: "rgba(255,255,255,0.45)", fontSize: 11 }} />
                <YAxis tick={{ fill: "rgba(255,255,255,0.45)", fontSize: 11 }} />
                <Tooltip
                  contentStyle={{
                    background: "#1a1a1a",
                    border: "1px solid rgba(255,255,255,0.1)",
                    borderRadius: 8,
                  }}
                  formatter={(value: number, name: string) => {
                    if (name === "hwmGap") return [fmtUsd(value), "Protected (no re-bill)"];
                    return [fmtUsd(value), name === "highWaterMark" ? "High-water mark" : "Cumulative realized"];
                  }}
                />
                <Legend />
                <Area
                  type="monotone"
                  dataKey="cumulativeRealized"
                  stackId="hwm"
                  fill="transparent"
                  stroke="none"
                />
                <Area
                  type="monotone"
                  dataKey="hwmGap"
                  stackId="hwm"
                  fill="rgba(251, 191, 36, 0.15)"
                  stroke="none"
                  name="Protected (no re-bill)"
                />
                <Line
                  type="monotone"
                  dataKey="cumulativeRealized"
                  stroke="#34d399"
                  strokeWidth={2}
                  dot={false}
                  name="Cumulative realized"
                />
                <Line
                  type="stepAfter"
                  dataKey="highWaterMark"
                  stroke="#0A84FF"
                  strokeWidth={2}
                  dot={false}
                  name="High-water mark"
                />
              </ComposedChart>
            </ResponsiveContainer>
          )}
          <p className="mt-2 text-xs text-white/40">
            Shaded area = profit below your high-water mark — you do not pay commission on that
            portion again.
          </p>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium text-white">Structure history</h2>
        {loading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-white/30" />
          </div>
        ) : structuresError ? (
          <SectionLoadError onRetry={() => void load()} busy={loading} />
        ) : structures.length === 0 ? (
          <div className="rounded-xl border border-dashed border-white/15 px-6 py-12 text-center">
            <p className="text-sm text-white/55">No bot structures recorded yet.</p>
            <p className="mt-2 text-xs text-white/40">
              When the bot opens and closes positions on your Delta account, each structure will
              appear here with P&amp;L matched to your wallet transactions.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {structures.map((s) => {
              const isOpen = s.status !== "closed" || s.realizedPnl === null;
              const expanded = expandedId === s.id;
              return (
                <div
                  key={s.id}
                  className="rounded-xl border border-white/10 bg-white/[0.02] overflow-hidden"
                >
                  <button
                    type="button"
                    className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-white/[0.03]"
                    onClick={() => setExpandedId(expanded ? null : s.id)}
                  >
                    {expanded ? (
                      <ChevronDown className="h-4 w-4 shrink-0 text-white/45" />
                    ) : (
                      <ChevronRight className="h-4 w-4 shrink-0 text-white/45" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-white">
                          {s.underlying} · #{s.botStructureId}
                        </span>
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs ${
                            isOpen
                              ? "bg-amber-500/15 text-amber-200"
                              : "bg-emerald-500/15 text-emerald-200"
                          }`}
                        >
                          {s.status}
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs text-white/45">
                        Opened {fmtDay(s.openedAt)}
                        {s.closedAt ? ` · Closed ${fmtDay(s.closedAt)}` : ""}
                      </p>
                    </div>
                    <div className="text-right">
                      {isOpen ? (
                        <div>
                          <span className="text-white/45">—</span>
                          <p className="mt-0.5 max-w-[12rem] text-[10px] text-white/35">
                            Still open — P&L is booked when the structure closes
                          </p>
                        </div>
                      ) : (
                        <MoneyDisplay usd={s.realizedPnl} rate={usdInrRate} align="right" />
                      )}
                    </div>
                  </button>
                  {expanded ? (
                    <div className="border-t border-white/10 px-4 py-3">
                      <ResponsiveMoneyTable
                        table={
                          <table className="w-full text-left text-sm">
                            <thead>
                              <tr className="text-xs uppercase text-white/40">
                                <th className="pb-2 pr-3">Leg</th>
                                <th className="pb-2 pr-3">Symbol</th>
                                <th className="pb-2 pr-3">Window</th>
                                <th className="pb-2 pr-3">Cashflow</th>
                                <th className="pb-2 pr-3">Commission</th>
                                <th className="pb-2 pr-3">Realized</th>
                                <th className="pb-2">Txns</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-white/5">
                              {s.legs.map((leg) => {
                                const legOpen = leg.closedAt == null || leg.realizedPnl === null;
                                return (
                                  <tr key={leg.id} className="text-white/80">
                                    <td className="py-2 pr-3">
                                      {leg.legRole} · {leg.side} ×{leg.quantity}
                                    </td>
                                    <td className="py-2 pr-3">
                                      {leg.symbol ?? leg.productId}
                                      {leg.strike != null ? ` @ ${leg.strike}` : ""}
                                    </td>
                                    <td className="py-2 pr-3 text-xs text-white/50">
                                      {fmtDay(leg.openedAt)}
                                      {leg.closedAt ? ` → ${fmtDay(leg.closedAt)}` : " → open"}
                                    </td>
                                    <td className="py-2 pr-3">
                                      <MoneyDisplay
                                        usd={leg.grossCashflow}
                                        rate={usdInrRate}
                                        align="left"
                                        mode="neutral"
                                      />
                                    </td>
                                    <td className="py-2 pr-3">
                                      <MoneyDisplay
                                        usd={leg.commissionTotal}
                                        rate={usdInrRate}
                                        align="left"
                                        mode="neutral"
                                      />
                                    </td>
                                    <td className="py-2 pr-3">
                                      {legOpen ? (
                                        <span className="text-white/45">—</span>
                                      ) : (
                                        <MoneyDisplay
                                          usd={leg.realizedPnl}
                                          rate={usdInrRate}
                                          align="left"
                                        />
                                      )}
                                    </td>
                                    <td className="py-2 tabular-nums">{leg.matchedTxnCount}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        }
                        cards={
                          <>
                            {s.legs.map((leg) => {
                              const legOpen = leg.closedAt == null || leg.realizedPnl === null;
                              const primary = `${leg.legRole} · ${leg.side} ×${leg.quantity}`;
                              const symbol =
                                `${leg.symbol ?? leg.productId}${leg.strike != null ? ` @ ${leg.strike}` : ""}`;
                              return (
                                <MoneyRowCard
                                  key={leg.id}
                                  primary={primary}
                                  secondary={
                                    <>
                                      <span>{symbol}</span>
                                      <span className="mt-0.5 block">
                                        {formatIstDateTime(leg.openedAt)}
                                        {leg.closedAt
                                          ? ` → ${formatIstDateTime(leg.closedAt)}`
                                          : " → open"}
                                      </span>
                                    </>
                                  }
                                  amount={
                                    legOpen ? (
                                      <span className="text-white/45">—</span>
                                    ) : (
                                      <MoneyDisplayCompact
                                        usd={leg.realizedPnl}
                                        rate={usdInrRate}
                                      />
                                    )
                                  }
                                  status={<LegStatusPill open={legOpen} />}
                                  details={
                                    <div className="divide-y divide-white/5">
                                      <DetailRow
                                        label="Cashflow"
                                        value={
                                          <MoneyDisplay
                                            usd={leg.grossCashflow}
                                            rate={usdInrRate}
                                            align="right"
                                            mode="neutral"
                                          />
                                        }
                                      />
                                      <DetailRow
                                        label="Commission"
                                        value={
                                          <MoneyDisplay
                                            usd={leg.commissionTotal}
                                            rate={usdInrRate}
                                            align="right"
                                            mode="neutral"
                                          />
                                        }
                                      />
                                      <DetailRow
                                        label="Matched txns"
                                        value={
                                          <span className="tabular-nums text-white/80">
                                            {leg.matchedTxnCount}
                                          </span>
                                        }
                                      />
                                    </div>
                                  }
                                />
                              );
                            })}
                          </>
                        }
                      />
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <div id="invoices">
        {invoicesError ? (
          <section className="space-y-3">
            <h2 className="text-lg font-medium text-white">Revenue invoices</h2>
            <SectionLoadError onRetry={() => void load()} busy={loading} />
          </section>
        ) : (
          <RevenueInvoiceTable
            invoices={invoices}
            loading={loading}
            walletBalance={walletBalance}
            rate={usdInrRate}
            onPaid={() => void load()}
          />
        )}
      </div>

      <StrategySubscriptionFees />
    </div>
  );
}
