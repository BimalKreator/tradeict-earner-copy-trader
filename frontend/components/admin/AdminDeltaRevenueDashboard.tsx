"use client";

import {
  AlertTriangle,
  ChevronLeft,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  authFetch,
  buildApiUrl,
  formatFetchError,
  formatFetchErrors,
} from "@/lib/authFetch";
import { resolveApiBase } from "@/lib/apiBase";
import { fmtUsd } from "@/lib/currency";
import {
  formatIstCalendarDate,
  formatIstMonthYear,
  formatIstSnapshotDay,
  currentIstYearMonth,
} from "@/lib/istDates";

const UNMATCHED_AMBER_THRESHOLD = 3;

type OverviewUser = {
  userId: string;
  email: string;
  name: string | null;
  structuresClosed: number;
  realizedPnl: number;
  hwmBefore: number;
  hwmAfter: number;
  billableProfit: number;
  profitSharePct: number;
  commissionAmount: number;
  invoiceStatus: string;
};

type HealthUser = {
  userId: string;
  email: string | null;
  ledgerRowCount: number;
  lastLedgerOccurredAt: string | null;
  lastLedgerSyncAt: string | null;
  structuresMatched: number;
  unmatchedTxnCount: number;
  zeroMatchStructureCount: number;
  overlapCount: number;
};

type UserDetail = {
  user: { id: string; email: string; name: string | null };
  profitShareOverride: number | null;
  strategyProfitShare: number | null;
  strategyTitle: string | null;
  snapshots: Array<{
    snapshotDate: string;
    cumulativeRealized: number;
    highWaterMark: number;
    realizedDelta: number;
    commissionCumulative: number;
  }>;
  structures: Array<{
    botStructureId: number;
    status: string;
    openedAt: string;
    closedAt: string | null;
    realizedPnl: number | null;
    matchedTxnCount: number;
    grossCashflow?: number;
    commissionTotal?: number;
    fundingTotal?: number;
    settlementTotal?: number;
    liquidationFeeTotal?: number;
    legs: Array<{
      legRole: string;
      symbol: string | null;
      productId: number;
      realizedPnl: number | null;
      matchedTxnCount: number;
      grossCashflow?: number;
      commissionTotal?: number;
      fundingTotal?: number | null;
      settlementTotal?: number | null;
      liquidationFeeTotal?: number | null;
    }>;
  }>;
  invoices: Array<{
    periodYear: number;
    periodMonth: number;
    billableProfit: number;
    profitSharePct: number;
    commissionAmount: number;
    status: string;
  }>;
};

function pnlClass(n: number): string {
  if (n > 0) return "text-emerald-400";
  if (n < 0) return "text-red-300";
  return "text-white/70";
}

function defaultPeriod(): { year: number; month: number } {
  return currentIstYearMonth();
}

export function AdminDeltaRevenueDashboard() {
  const [period, setPeriod] = useState(defaultPeriod);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [users, setUsers] = useState<OverviewUser[]>([]);
  const [totals, setTotals] = useState({
    structuresClosed: 0,
    realizedPnl: 0,
    billableProfit: 0,
    commissionAmount: 0,
  });
  const [health, setHealth] = useState<HealthUser[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [detail, setDetail] = useState<UserDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [overrideInput, setOverrideInput] = useState("");
  const [savingOverride, setSavingOverride] = useState(false);

  const loadOverview = useCallback(async () => {
    if (!resolveApiBase()) return;
    setLoading(true);
    setError(null);
    try {
      const overviewPath = `/admin/revenue/overview?year=${period.year}&month=${period.month}`;
      const healthPath = "/admin/revenue/health";
      const [ovRes, hRes] = await Promise.all([
        authFetch(overviewPath),
        authFetch(healthPath),
      ]);
      const failures: Array<{ label: string; res: Response; url: string }> = [];
      if (!ovRes.ok) {
        failures.push({
          label: "overview",
          res: ovRes,
          url: buildApiUrl(overviewPath),
        });
      }
      if (!hRes.ok) {
        failures.push({
          label: "health",
          res: hRes,
          url: buildApiUrl(healthPath),
        });
      }
      if (failures.length > 0) {
        throw new Error(formatFetchErrors(failures));
      }
      const ov = (await ovRes.json()) as {
        users: OverviewUser[];
        totals: typeof totals;
      };
      const h = (await hRes.json()) as { users: HealthUser[] };
      setUsers(ov.users ?? []);
      setTotals(ov.totals ?? totals);
      setHealth(h.users ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, [period.month, period.year]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  const loadDetail = useCallback(async (userId: string) => {
    if (!resolveApiBase()) return;
    setDetailLoading(true);
    try {
      const detailPath = `/admin/revenue/user/${userId}`;
      const res = await authFetch(detailPath);
      if (!res.ok) {
        throw new Error(formatFetchError("user detail", res, buildApiUrl(detailPath)));
      }
      const data = (await res.json()) as UserDetail;
      setDetail(data);
      setOverrideInput(
        data.profitShareOverride != null ? String(data.profitShareOverride) : "",
      );
    } catch {
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedUserId) void loadDetail(selectedUserId);
    else setDetail(null);
  }, [selectedUserId, loadDetail]);

  const healthByUser = useMemo(
    () => new Map(health.map((h) => [h.userId, h])),
    [health],
  );

  const chartData = useMemo(
    () =>
      (detail?.snapshots ?? []).map((s) => ({
        day: formatIstSnapshotDay(s.snapshotDate),
        cumulativeRealized: s.cumulativeRealized,
        highWaterMark: s.highWaterMark,
        hwmGap: Math.max(0, s.highWaterMark - s.cumulativeRealized),
      })),
    [detail],
  );

  async function saveOverride() {
    if (!selectedUserId || !resolveApiBase()) return;
    setSavingOverride(true);
    try {
      const val = overrideInput.trim();
      const body =
        val === ""
          ? { profitShareOverride: null }
          : { profitShareOverride: parseFloat(val) };
      const overridePath = `/admin/revenue/user/${selectedUserId}/profit-share`;
      const res = await authFetch(overridePath, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw new Error(formatFetchError("profit share", res, buildApiUrl(overridePath)));
      }
      await loadDetail(selectedUserId);
      await loadOverview();
    } finally {
      setSavingOverride(false);
    }
  }

  if (selectedUserId && detail) {
    return (
      <div className="mx-auto max-w-6xl space-y-6 px-4 py-8">
        <button
          type="button"
          onClick={() => setSelectedUserId(null)}
          className="inline-flex items-center gap-1 text-sm text-white/60 hover:text-white"
        >
          <ChevronLeft className="h-4 w-4" /> Back to overview
        </button>
        <div>
          <h1 className="text-2xl font-semibold text-white">{detail.user.email}</h1>
          <p className="text-sm text-white/50">
            Strategy: {detail.strategyTitle ?? "—"} · default share{" "}
            {detail.strategyProfitShare ?? 0}%
          </p>
        </div>

        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
          <p className="text-sm font-medium text-white">Profit share override</p>
          <p className="mt-1 text-xs text-white/45">
            Per-user override (null = use strategy default). Applied on next invoice
            recompute.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <input
              type="number"
              step="0.1"
              min="0"
              placeholder="Strategy default"
              value={overrideInput}
              onChange={(e) => setOverrideInput(e.target.value)}
              className="rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-sm text-white"
            />
            <button
              type="button"
              disabled={savingOverride}
              onClick={() => void saveOverride()}
              className="rounded-lg bg-[#0A84FF] px-4 py-2 text-sm text-white disabled:opacity-50"
            >
              {savingOverride ? "Saving…" : "Save override"}
            </button>
          </div>
        </div>

        <div className="rounded-xl border border-white/10 p-4">
          <h2 className="mb-3 text-lg font-medium text-white">Daily cumulative (IST)</h2>
          {detailLoading ? (
            <Loader2 className="mx-auto h-8 w-8 animate-spin text-white/30" />
          ) : chartData.length === 0 ? (
            <p className="text-sm text-white/45">No snapshots yet.</p>
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <ComposedChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
                <XAxis dataKey="day" tick={{ fill: "rgba(255,255,255,0.45)", fontSize: 10 }} />
                <YAxis tick={{ fill: "rgba(255,255,255,0.45)", fontSize: 10 }} />
                <Tooltip />
                <Area dataKey="cumulativeRealized" stackId="h" fill="transparent" stroke="none" />
                <Area dataKey="hwmGap" stackId="h" fill="rgba(251,191,36,0.12)" stroke="none" />
                <Line dataKey="cumulativeRealized" stroke="#34d399" dot={false} />
                <Line type="stepAfter" dataKey="highWaterMark" stroke="#0A84FF" dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="space-y-2">
          <h2 className="text-lg font-medium text-white">Invoices</h2>
          {detail.invoices.length === 0 ? (
            <p className="text-sm text-white/45">No invoices yet.</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-white/10">
              <table className="w-full text-left text-sm">
                <thead className="text-xs uppercase text-white/40">
                  <tr>
                    <th className="px-4 py-2">Period</th>
                    <th className="px-4 py-2">Billable</th>
                    <th className="px-4 py-2">Share</th>
                    <th className="px-4 py-2">Commission</th>
                    <th className="px-4 py-2">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {detail.invoices.map((inv) => (
                    <tr key={`${inv.periodYear}-${inv.periodMonth}`}>
                      <td className="px-4 py-2">
                        {formatIstMonthYear(inv.periodMonth, inv.periodYear)}
                      </td>
                      <td className="px-4 py-2 tabular-nums">{fmtUsd(inv.billableProfit)}</td>
                      <td className="px-4 py-2 tabular-nums">{inv.profitSharePct.toFixed(1)}%</td>
                      <td className="px-4 py-2 tabular-nums">{fmtUsd(inv.commissionAmount)}</td>
                      <td className="px-4 py-2">{inv.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="space-y-2">
          <h2 className="text-lg font-medium text-white">Structures</h2>
          {detail.structures.map((s) => (
            <div
              key={s.botStructureId}
              className="rounded-lg border border-white/10 px-4 py-3 text-sm"
            >
              <div className="flex justify-between">
                <span>
                  #{s.botStructureId} · {s.status} · {formatIstCalendarDate(s.openedAt)}
                  {s.closedAt ? ` → ${formatIstCalendarDate(s.closedAt)}` : ""}
                </span>
                <span className={pnlClass(s.realizedPnl ?? 0)}>
                  {s.realizedPnl != null ? fmtUsd(s.realizedPnl) : "—"}
                </span>
              </div>
              <p className="mt-1 text-xs text-white/40">
                {s.legs.length} legs · {s.matchedTxnCount} matched txns
                {" · "}
                cash {fmtUsd(s.grossCashflow ?? 0)}
                {" · "}
                fee {fmtUsd(s.commissionTotal ?? 0)}
                {" · "}
                funding {fmtUsd(s.fundingTotal ?? 0)}
                {" · "}
                settlement {fmtUsd(s.settlementTotal ?? 0)}
                {" · "}
                liq {fmtUsd(s.liquidationFeeTotal ?? 0)}
              </p>
              {s.legs.length > 0 ? (
                <div className="mt-2 overflow-x-auto rounded border border-white/5">
                  <table className="w-full min-w-[640px] text-left text-xs text-white/70">
                    <thead className="bg-white/[0.03] text-[10px] uppercase tracking-wide text-white/35">
                      <tr>
                        <th className="px-2 py-1.5 font-medium">Leg</th>
                        <th className="px-2 py-1.5 font-medium">Cashflow</th>
                        <th className="px-2 py-1.5 font-medium">Commission</th>
                        <th className="px-2 py-1.5 font-medium">Funding</th>
                        <th className="px-2 py-1.5 font-medium">Settlement</th>
                        <th className="px-2 py-1.5 font-medium">Liq fee</th>
                        <th className="px-2 py-1.5 font-medium">Realized</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {s.legs.map((leg, idx) => (
                        <tr key={`${s.botStructureId}-${leg.productId}-${idx}`}>
                          <td className="px-2 py-1.5">
                            {leg.legRole}
                            {leg.symbol ? ` · ${leg.symbol}` : ""}
                          </td>
                          <td className="px-2 py-1.5 tabular-nums">
                            {fmtUsd(leg.grossCashflow ?? 0)}
                          </td>
                          <td className="px-2 py-1.5 tabular-nums">
                            {fmtUsd(leg.commissionTotal ?? 0)}
                          </td>
                          <td className="px-2 py-1.5 tabular-nums">
                            {fmtUsd(leg.fundingTotal ?? 0)}
                          </td>
                          <td className="px-2 py-1.5 tabular-nums">
                            {fmtUsd(leg.settlementTotal ?? 0)}
                          </td>
                          <td className="px-2 py-1.5 tabular-nums">
                            {fmtUsd(leg.liquidationFeeTotal ?? 0)}
                          </td>
                          <td
                            className={`px-2 py-1.5 tabular-nums ${pnlClass(leg.realizedPnl ?? 0)}`}
                          >
                            {leg.realizedPnl != null
                              ? fmtUsd(leg.realizedPnl)
                              : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-[#0A84FF]">
            <ShieldCheck className="h-5 w-5" />
            <span className="text-sm uppercase tracking-wide">Admin</span>
          </div>
          <h1 className="mt-1 text-2xl font-semibold text-white">Revenue (Delta)</h1>
          <p className="mt-1 text-sm text-white/50">
            From customer Delta ledger → structure P&L → monthly invoices. Not bot MTM.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={period.month}
            onChange={(e) =>
              setPeriod((p) => ({ ...p, month: parseInt(e.target.value, 10) }))
            }
            className="rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-sm text-white"
          >
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
              <option key={m} value={m}>
                {formatIstMonthYear(m, period.year)}
              </option>
            ))}
          </select>
          <input
            type="number"
            value={period.year}
            onChange={(e) =>
              setPeriod((p) => ({ ...p, year: parseInt(e.target.value, 10) || p.year }))
            }
            className="w-24 rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-sm text-white"
          />
          <button
            type="button"
            onClick={() => void loadOverview()}
            className="rounded-lg border border-white/15 p-2 text-white/70 hover:bg-white/5"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      <p className="text-xs text-white/40">
        Legacy bot-reported view:{" "}
        <Link href="/admin/revenue" className="text-[#0A84FF] underline">
          Revenue Analytics (legacy)
        </Link>
      </p>

      {error ? (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      ) : null}

      <section className="rounded-xl border border-white/10 overflow-hidden">
        <h2 className="border-b border-white/10 bg-white/[0.03] px-4 py-3 text-sm font-medium text-white">
          Pipeline health
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="text-xs uppercase text-white/40">
              <tr>
                <th className="px-4 py-2">User</th>
                <th className="px-4 py-2">Ledger rows</th>
                <th className="px-4 py-2">Last txn (IST)</th>
                <th className="px-4 py-2">Last sync</th>
                <th className="px-4 py-2">Unmatched</th>
                <th className="px-4 py-2">Zero-match</th>
                <th className="px-4 py-2">Overlap</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {health.map((h) => {
                const unmatchedWarn = h.unmatchedTxnCount >= UNMATCHED_AMBER_THRESHOLD;
                const zeroMatchBad = h.zeroMatchStructureCount > 0;
                const overlapBad = h.overlapCount > 0;
                return (
                  <tr key={h.userId} className="text-white/80">
                    <td className="px-4 py-2">{h.email ?? h.userId.slice(0, 8)}</td>
                    <td className="px-4 py-2 tabular-nums">{h.ledgerRowCount}</td>
                    <td className="px-4 py-2 text-xs">
                      {h.lastLedgerOccurredAt
                        ? formatIstCalendarDate(h.lastLedgerOccurredAt)
                        : "—"}
                    </td>
                    <td className="px-4 py-2 text-xs">
                      {h.lastLedgerSyncAt
                        ? formatIstCalendarDate(h.lastLedgerSyncAt)
                        : "—"}
                    </td>
                    <td
                      className={`px-4 py-2 tabular-nums ${unmatchedWarn ? "text-amber-300" : ""}`}
                    >
                      {h.unmatchedTxnCount}
                    </td>
                    <td
                      className={`px-4 py-2 tabular-nums ${zeroMatchBad ? "text-red-300 font-medium" : ""}`}
                    >
                      {h.zeroMatchStructureCount}
                    </td>
                    <td
                      className={`px-4 py-2 tabular-nums ${overlapBad ? "text-red-300 font-medium" : ""}`}
                    >
                      {h.overlapCount}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-xl border border-white/10 overflow-hidden">
        <h2 className="border-b border-white/10 bg-white/[0.03] px-4 py-3 text-sm font-medium text-white">
          {formatIstMonthYear(period.month, period.year)} — all users
        </h2>
        {loading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="h-8 w-8 animate-spin text-white/30" />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1000px] text-left text-sm">
              <thead className="text-xs uppercase text-white/40">
                <tr>
                  <th className="px-4 py-2">User</th>
                  <th className="px-4 py-2">Closed</th>
                  <th className="px-4 py-2">Realized</th>
                  <th className="px-4 py-2">HWM before</th>
                  <th className="px-4 py-2">HWM after</th>
                  <th className="px-4 py-2">Billable</th>
                  <th className="px-4 py-2">Share</th>
                  <th className="px-4 py-2">Commission</th>
                  <th className="px-4 py-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {users.map((u) => (
                  <tr
                    key={u.userId}
                    className="cursor-pointer text-white/85 hover:bg-white/[0.03]"
                    onClick={() => setSelectedUserId(u.userId)}
                  >
                    <td className="px-4 py-2">{u.email}</td>
                    <td className="px-4 py-2 tabular-nums">{u.structuresClosed}</td>
                    <td className={`px-4 py-2 tabular-nums ${pnlClass(u.realizedPnl)}`}>
                      {fmtUsd(u.realizedPnl)}
                    </td>
                    <td className="px-4 py-2 tabular-nums">{fmtUsd(u.hwmBefore)}</td>
                    <td className="px-4 py-2 tabular-nums">{fmtUsd(u.hwmAfter)}</td>
                    <td className="px-4 py-2 tabular-nums">{fmtUsd(u.billableProfit)}</td>
                    <td className="px-4 py-2 tabular-nums">{u.profitSharePct.toFixed(1)}%</td>
                    <td className="px-4 py-2 tabular-nums">{fmtUsd(u.commissionAmount)}</td>
                    <td className="px-4 py-2">{u.invoiceStatus}</td>
                  </tr>
                ))}
                <tr className="bg-white/[0.04] font-medium text-white">
                  <td className="px-4 py-2">Totals</td>
                  <td className="px-4 py-2 tabular-nums">{totals.structuresClosed}</td>
                  <td className={`px-4 py-2 tabular-nums ${pnlClass(totals.realizedPnl)}`}>
                    {fmtUsd(totals.realizedPnl)}
                  </td>
                  <td className="px-4 py-2" colSpan={2} />
                  <td className="px-4 py-2 tabular-nums">{fmtUsd(totals.billableProfit)}</td>
                  <td className="px-4 py-2" />
                  <td className="px-4 py-2 tabular-nums">{fmtUsd(totals.commissionAmount)}</td>
                  <td className="px-4 py-2" />
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </section>

      {users.length === 0 && !loading ? (
        <p className="flex items-center gap-2 text-sm text-white/45">
          <AlertTriangle className="h-4 w-4" />
          No eligible bot-strategy users or no invoices for this period yet.
        </p>
      ) : null}
    </div>
  );
}
