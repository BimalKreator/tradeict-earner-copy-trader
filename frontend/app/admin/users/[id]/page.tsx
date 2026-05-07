"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

const API_BASE = process.env.NEXT_PUBLIC_API_URL;

type UserTrade = {
  id: string;
  createdAt: string;
  strategyTitle: string;
  symbol: string;
  side: string;
  size: number;
  entryPrice: number;
  exitPrice: number | null;
  status: string;
  pnl: number;
  adminRevenue: number;
};

type BillingSummary = {
  totalPnlToDate: number;
  totalAdminCommissionEarned: number;
  amountPaid: number;
  balanceDue: number;
};

type UserState = {
  id: string;
  email: string;
  name: string | null;
};

type UserStrategy = {
  id: string;
  strategyTitle: string;
  status: string;
  multiplier: number;
  exchangeAccount: { id: string; nickname: string; exchange: string } | null;
};

export default function AdminUserDetailPage() {
  const params = useParams<{ id: string }>();
  const userId = String(params?.id ?? "");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [user, setUser] = useState<UserState | null>(null);
  const [trades, setTrades] = useState<UserTrade[]>([]);
  const [billing, setBilling] = useState<BillingSummary | null>(null);
  const [strategies, setStrategies] = useState<UserStrategy[]>([]);
  const [tab, setTab] = useState<"trades" | "strategies">("trades");
  const [flushing, setFlushing] = useState(false);

  const authHeaders = useMemo(() => {
    const token =
      typeof window !== "undefined" ? localStorage.getItem("token") : null;
    return { Authorization: `Bearer ${token ?? ""}` };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [tbRes, stRes] = await Promise.all([
        fetch(`${API_BASE}/admin/users/${userId}/trades`, { headers: authHeaders }),
        fetch(`${API_BASE}/admin/users/${userId}/strategies`, { headers: authHeaders }),
      ]);
      if (!tbRes.ok || !stRes.ok) throw new Error(`Request failed (${tbRes.status}/${stRes.status})`);
      const tb = (await tbRes.json()) as {
        user: UserState;
        trades: UserTrade[];
        billingSummary: BillingSummary;
      };
      const st = (await stRes.json()) as { strategies?: UserStrategy[] };
      setUser(tb.user);
      setTrades(tb.trades ?? []);
      setBilling(tb.billingSummary ?? null);
      setStrategies(st.strategies ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [authHeaders, userId]);

  useEffect(() => {
    if (!userId) return;
    void load();
  }, [load, userId]);

  const flushTradeHistory = useCallback(async () => {
    if (!userId) return;
    const ok = window.confirm(
      "Delete all trade records for this user? This action cannot be undone.",
    );
    if (!ok) return;
    setFlushing(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/admin/users/${userId}/trades/flush`, {
        method: "DELETE",
        headers: authHeaders,
      });
      if (!res.ok) throw new Error(`Flush failed (${res.status})`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to flush trade history");
    } finally {
      setFlushing(false);
    }
  }, [authHeaders, load, userId]);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-white">User Detail</h1>
          <p className="mt-1 text-sm text-white/55">
            {user ? `${user.email}${user.name ? ` · ${user.name}` : ""}` : "Loading user..."}
          </p>
        </div>
        <Link href="/admin/users" className="rounded-lg border border-glassBorder px-3 py-2 text-sm text-white/80 hover:bg-white/10">
          Back to Users
        </Link>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {loading ? (
        <div className="py-20 text-center text-white/50">
          <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />
        </div>
      ) : (
        <>
          <div className="grid gap-3 md:grid-cols-4">
            <div className="rounded-lg border border-glassBorder bg-white/[0.02] px-4 py-3">
              <p className="text-[10px] uppercase tracking-wider text-white/45">Total P&L to date</p>
              <p className="mt-1 text-lg font-semibold text-white tabular-nums">${Number(billing?.totalPnlToDate ?? 0).toFixed(2)}</p>
            </div>
            <div className="rounded-lg border border-glassBorder bg-white/[0.02] px-4 py-3">
              <p className="text-[10px] uppercase tracking-wider text-white/45">Total Admin Commission Earned</p>
              <p className="mt-1 text-lg font-semibold text-white tabular-nums">${Number(billing?.totalAdminCommissionEarned ?? 0).toFixed(2)}</p>
            </div>
            <div className="rounded-lg border border-glassBorder bg-white/[0.02] px-4 py-3">
              <p className="text-[10px] uppercase tracking-wider text-white/45">Amount Paid</p>
              <p className="mt-1 text-lg font-semibold text-emerald-300 tabular-nums">${Number(billing?.amountPaid ?? 0).toFixed(2)}</p>
            </div>
            <div className="rounded-lg border border-glassBorder bg-white/[0.02] px-4 py-3">
              <p className="text-[10px] uppercase tracking-wider text-white/45">Balance Due</p>
              <p className="mt-1 text-lg font-semibold text-red-300 tabular-nums">${Number(billing?.balanceDue ?? 0).toFixed(2)}</p>
            </div>
          </div>

          <div className="inline-flex rounded-lg border border-glassBorder bg-white/[0.03] p-1 text-sm">
            <button
              type="button"
              onClick={() => setTab("trades")}
              className={`rounded-md px-3 py-1.5 ${tab === "trades" ? "bg-primary/20 text-primary" : "text-white/70 hover:bg-white/5"}`}
            >
              Trade History
            </button>
            <button
              type="button"
              onClick={() => setTab("strategies")}
              className={`rounded-md px-3 py-1.5 ${tab === "strategies" ? "bg-primary/20 text-primary" : "text-white/70 hover:bg-white/5"}`}
            >
              Strategies
            </button>
          </div>
          {tab === "trades" && (
            <div>
              <button
                type="button"
                onClick={() => void flushTradeHistory()}
                disabled={flushing}
                className="rounded-lg border border-red-500/45 bg-red-500/15 px-3 py-2 text-xs font-medium text-red-200 transition hover:bg-red-500/25 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {flushing ? "Flushing..." : "Flush Trade History"}
              </button>
            </div>
          )}

          {tab === "trades" ? (
            <div className="glass-card border border-glassBorder overflow-hidden">
              <div className="scroll-table overflow-x-auto">
                <table className="w-full min-w-[980px] text-left text-sm">
                  <thead className="border-b border-glassBorder bg-white/[0.03] text-white/70">
                    <tr>
                      <th className="px-3 py-2 font-medium">Time</th>
                      <th className="px-3 py-2 font-medium">Strategy</th>
                      <th className="px-3 py-2 font-medium">Symbol</th>
                      <th className="px-3 py-2 font-medium">Side</th>
                      <th className="px-3 py-2 font-medium">Entry</th>
                      <th className="px-3 py-2 font-medium">Exit</th>
                      <th className="px-3 py-2 font-medium">P&L</th>
                      <th className="px-3 py-2 font-medium">Admin Revenue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trades.length === 0 ? (
                      <tr>
                        <td colSpan={8} className="px-3 py-8 text-center text-white/45">
                          No trade history found.
                        </td>
                      </tr>
                    ) : (
                      trades.map((t) => (
                        <tr key={t.id} className="border-b border-white/[0.06] last:border-0">
                          <td className="px-3 py-2 text-white/55 tabular-nums">{new Date(t.createdAt).toLocaleString()}</td>
                          <td className="px-3 py-2 text-white">{t.strategyTitle}</td>
                          <td className="px-3 py-2 text-white/80">{t.symbol}</td>
                          <td className="px-3 py-2 text-white/80">{t.side}</td>
                          <td className="px-3 py-2 text-white/80 tabular-nums">${t.entryPrice.toFixed(2)}</td>
                          <td className="px-3 py-2 text-white/80 tabular-nums">{t.exitPrice != null ? `$${t.exitPrice.toFixed(2)}` : "—"}</td>
                          <td className={`px-3 py-2 tabular-nums ${t.pnl >= 0 ? "text-emerald-300" : "text-red-300"}`}>${t.pnl.toFixed(2)}</td>
                          <td className="px-3 py-2 text-white tabular-nums">${t.adminRevenue.toFixed(2)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              {strategies.map((s) => (
                <div key={s.id} className="rounded-lg border border-glassBorder bg-white/[0.02] px-4 py-3 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-white">{s.strategyTitle}</span>
                    <span className={`rounded px-2 py-0.5 text-xs ${
                      s.status === "ACTIVE"
                        ? "bg-emerald-500/15 text-emerald-300"
                        : "bg-amber-500/15 text-amber-200"
                    }`}>
                      {s.status}
                    </span>
                  </div>
                  <p className="mt-1 text-white/60">
                    Multiplier: {s.multiplier}x · {s.exchangeAccount ? `Account: ${s.exchangeAccount.nickname}` : "Not configured"}
                  </p>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

