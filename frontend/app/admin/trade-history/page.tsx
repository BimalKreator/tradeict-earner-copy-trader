"use client";

import { ExitReasonBadge } from "@/components/trades/ExitReasonBadge";
import { History, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

const API_BASE = process.env.NEXT_PUBLIC_API_URL;

type UserOption = {
  id: string;
  email: string;
};

type AdminTradeRow = {
  id: string;
  createdAt: string;
  userId: string;
  userEmail: string;
  userName: string | null;
  strategyId: string;
  strategyTitle: string;
  symbol: string;
  side: string;
  size: number;
  entryPrice: number;
  exitPrice: number | null;
  tradePnl: number;
  tradingFee: number;
  revenueShareAmt: number;
  status: "OPEN" | "CLOSED" | "FAILED";
  exitReason: string | null;
};

const usdPnlFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  signDisplay: "always",
});

const dateFmt = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

function fmtPnl(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return usdPnlFmt.format(n);
}

function pnlClass(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "text-white/50";
  if (n > 0) return "text-emerald-400";
  if (n < 0) return "text-red-300";
  return "text-white/60";
}

function realizedPnl(row: AdminTradeRow): number | null {
  if (Number.isFinite(row.tradePnl) && row.tradePnl !== 0) return row.tradePnl;
  return null;
}

export default function AdminTradeHistoryPage() {
  const [rows, setRows] = useState<AdminTradeRow[]>([]);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const headers = useMemo(
    () => ({ Authorization: `Bearer ${localStorage.getItem("token") ?? ""}` }),
    [],
  );

  const load = useCallback(
    async (silent: boolean) => {
      try {
        const qs = new URLSearchParams({ limit: "300" });
        if (selectedUserId) qs.set("userId", selectedUserId);
        const res = await fetch(`${API_BASE}/admin/trades?${qs.toString()}`, {
          headers,
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`Request failed (${res.status})`);
        const data = (await res.json()) as { trades?: AdminTradeRow[] };
        setRows(data.trades ?? []);
        if (!silent) setError(null);
      } catch (e) {
        if (!silent) {
          setError(e instanceof Error ? e.message : "Failed to load trade history");
        }
      } finally {
        if (silent) setRefreshing(false);
        else setLoading(false);
      }
    },
    [headers, selectedUserId],
  );

  useEffect(() => {
    async function loadUsers(): Promise<void> {
      try {
        const res = await fetch(`${API_BASE}/admin/users/list`, {
          headers,
          cache: "no-store",
        });
        if (!res.ok) return;
        const data = (await res.json()) as UserOption[];
        if (Array.isArray(data)) setUsers(data);
      } catch {
        /* dropdown is optional; trades still load */
      }
    }
    void loadUsers();
  }, [headers]);

  useEffect(() => {
    setLoading(true);
    void load(false);
  }, [load]);

  return (
    <div className="mx-auto max-w-7xl space-y-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="rounded-xl border border-slate-800 bg-slate-900 p-3">
            <History className="h-6 w-6 text-cyan-400" aria-hidden />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">
              Trade History
            </h1>
            <p className="mt-1 text-sm text-slate-400">
              Platform-wide closed and failed trades with exit reasons.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            setRefreshing(true);
            void load(true);
          }}
          disabled={refreshing || loading}
          className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </header>

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <label className="text-sm text-slate-400">
          Filter by User
          <select
            value={selectedUserId}
            onChange={(e) => setSelectedUserId(e.target.value)}
            className="mt-1 block w-full min-w-[240px] rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 outline-none focus:ring-2 focus:ring-cyan-500/40 sm:max-w-md"
          >
            <option value="">All users</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.email}
              </option>
            ))}
          </select>
        </label>
      </div>

      <section className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900 shadow-lg shadow-black/20">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1180px] text-left text-sm">
            <thead className="border-b border-slate-800 bg-slate-950/60">
              <tr className="text-xs uppercase tracking-wider text-slate-500">
                <th className="px-4 py-3 font-medium">Date</th>
                <th className="px-4 py-3 font-medium">User</th>
                <th className="px-4 py-3 font-medium">Strategy</th>
                <th className="px-4 py-3 font-medium">Symbol</th>
                <th className="px-4 py-3 font-medium">Side</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Close Reason</th>
                <th className="px-4 py-3 text-right font-medium">Net PnL</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={8} className="px-4 py-16 text-center">
                    <Loader2 className="mx-auto h-8 w-8 animate-spin text-cyan-400" />
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-16 text-center text-slate-500">
                    No trades recorded yet.
                  </td>
                </tr>
              ) : (
                rows.map((r) => {
                  const pnl = realizedPnl(r);
                  return (
                    <tr
                      key={r.id}
                      className="border-b border-slate-800/80 hover:bg-slate-800/30"
                    >
                      <td className="whitespace-nowrap px-4 py-3 text-slate-400">
                        {dateFmt.format(new Date(r.createdAt))}
                      </td>
                      <td className="max-w-[180px] truncate px-4 py-3 text-slate-200">
                        <span title={r.userEmail}>{r.userName ?? r.userEmail}</span>
                      </td>
                      <td className="max-w-[160px] truncate px-4 py-3 text-slate-300">
                        {r.strategyTitle}
                      </td>
                      <td className="px-4 py-3 font-mono text-slate-200">{r.symbol}</td>
                      <td className="px-4 py-3 text-slate-300">{r.side}</td>
                      <td className="px-4 py-3">
                        <span className="rounded-md bg-slate-800 px-2 py-0.5 text-xs text-slate-300">
                          {r.status}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <ExitReasonBadge reason={r.exitReason} />
                      </td>
                      <td
                        className={`px-4 py-3 text-right font-medium tabular-nums ${pnlClass(pnl)}`}
                      >
                        {fmtPnl(pnl)}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      {!loading && rows.length > 0 ? (
        <p className="text-xs text-slate-500">
          Showing {rows.length} most recent trade{rows.length === 1 ? "" : "s"}.
        </p>
      ) : null}
    </div>
  );
}
