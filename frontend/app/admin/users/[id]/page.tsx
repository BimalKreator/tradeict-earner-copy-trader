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
  tradingFee: number;
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
  mobile?: string | null;
  address?: string | null;
  panNumber?: string | null;
  aadhaarNumber?: string | null;
  status: string;
};

type UserStrategy = {
  id: string;
  strategyTitle: string;
  status: string;
  multiplier: number;
  exchangeAccount: { id: string; nickname: string; exchange: string } | null;
};

type ManagementPayload = {
  user: UserState;
  deltaApiKey:
    | { id: string; nickname: string; apiKey: string; apiSecret: string }
    | null;
  exchangeAccount:
    | {
        id: string;
        nickname: string;
        exchange: string;
        apiKey: string;
        apiSecret: string;
      }
    | null;
};

type ProfileChangeRequest = {
  id: string;
  address: string | null;
  panNumber: string | null;
  aadhaarNumber: string | null;
  status: string;
  createdAt: string;
};

type UserTransaction = {
  id: string;
  amount: number;
  type: string;
  status: string;
  createdAt: string;
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
  const [tab, setTab] = useState<
    "management" | "subscriptions" | "changeRequests" | "trades" | "transactions"
  >("management");
  const [flushing, setFlushing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sendingReset, setSendingReset] = useState(false);
  const [statusDraft, setStatusDraft] = useState("ACTIVE");
  const [nicknameDraft, setNicknameDraft] = useState("Primary");
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [apiSecretDraft, setApiSecretDraft] = useState("");
  const [exchangeHint, setExchangeHint] = useState<string>("");
  const [balanceUsd, setBalanceUsd] = useState<number | null>(null);
  const [requests, setRequests] = useState<ProfileChangeRequest[]>([]);
  const [currentProfile, setCurrentProfile] = useState<{
    address: string | null;
    panNumber: string | null;
    aadhaarNumber: string | null;
  } | null>(null);
  const [transactions, setTransactions] = useState<UserTransaction[]>([]);

  const authHeaders = useMemo(() => {
    const token =
      typeof window !== "undefined" ? localStorage.getItem("token") : null;
    return { Authorization: `Bearer ${token ?? ""}` };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [tbRes, stRes, mgRes, balRes, reqRes, txRes] = await Promise.all([
        fetch(`${API_BASE}/admin/users/${userId}/trades`, { headers: authHeaders }),
        fetch(`${API_BASE}/admin/users/${userId}/strategies`, { headers: authHeaders }),
        fetch(`${API_BASE}/admin/users/${userId}/management`, { headers: authHeaders }),
        fetch(`${API_BASE}/admin/users/${userId}/balance`, { headers: authHeaders }),
        fetch(`${API_BASE}/admin/users/${userId}/change-requests`, { headers: authHeaders }),
        fetch(`${API_BASE}/admin/users/${userId}/transactions`, { headers: authHeaders }),
      ]);
      if (!tbRes.ok || !stRes.ok || !mgRes.ok || !balRes.ok || !reqRes.ok || !txRes.ok) {
        throw new Error(
          `Request failed (${tbRes.status}/${stRes.status}/${mgRes.status}/${balRes.status}/${reqRes.status}/${txRes.status})`,
        );
      }
      const tb = (await tbRes.json()) as {
        user: UserState;
        trades: UserTrade[];
        billingSummary: BillingSummary;
      };
      const st = (await stRes.json()) as { strategies?: UserStrategy[] };
      const mg = (await mgRes.json()) as ManagementPayload;
      const bal = (await balRes.json()) as { totalBalanceUsd?: number };
      const reqData = (await reqRes.json()) as {
        current?: { address: string | null; panNumber: string | null; aadhaarNumber: string | null };
        requests?: ProfileChangeRequest[];
      };
      const txData = (await txRes.json()) as { transactions?: UserTransaction[] };
      setUser(mg.user);
      setStatusDraft(mg.user.status);
      const source = mg.deltaApiKey ?? mg.exchangeAccount;
      setNicknameDraft(source?.nickname ?? "Primary");
      setApiKeyDraft(source?.apiKey ?? "");
      setApiSecretDraft(source?.apiSecret ?? "");
      setExchangeHint(
        mg.exchangeAccount
          ? `Exchange account detected: ${mg.exchangeAccount.exchange} / ${mg.exchangeAccount.nickname}`
          : "Using Delta API key profile",
      );
      setTrades(tb.trades ?? []);
      setBilling(tb.billingSummary ?? null);
      setStrategies(st.strategies ?? []);
      setBalanceUsd(Number.isFinite(bal.totalBalanceUsd ?? NaN) ? (bal.totalBalanceUsd as number) : 0);
      setRequests(reqData.requests ?? []);
      setCurrentProfile(reqData.current ?? null);
      setTransactions(txData.transactions ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [authHeaders, userId]);

  const sendResetLink = useCallback(async () => {
    if (!userId) return;
    setSendingReset(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/admin/users/${userId}/reset-password-link`, {
        method: "POST",
        headers: authHeaders,
      });
      const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
      if (!res.ok) throw new Error(body.error ?? `Reset link failed (${res.status})`);
      setError(body.message ?? "Password reset link sent successfully.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send reset password link");
    } finally {
      setSendingReset(false);
    }
  }, [authHeaders, userId]);

  const decideRequest = useCallback(
    async (requestId: string, action: "approve" | "reject") => {
      if (!userId) return;
      setError(null);
      try {
        const res = await fetch(
          `${API_BASE}/admin/users/${userId}/change-requests/${requestId}/${action}`,
          { method: "POST", headers: authHeaders },
        );
        if (!res.ok) throw new Error(`${action} failed (${res.status})`);
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : `Failed to ${action} request`);
      }
    },
    [authHeaders, load, userId],
  );

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

  const saveManagement = useCallback(async () => {
    if (!userId) return;
    setSaving(true);
    setError(null);
    try {
      const [statusRes, keysRes] = await Promise.all([
        fetch(`${API_BASE}/admin/users/${userId}/status`, {
          method: "PATCH",
          headers: {
            ...authHeaders,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ status: statusDraft }),
        }),
        fetch(`${API_BASE}/admin/users/${userId}/api-keys`, {
          method: "PUT",
          headers: {
            ...authHeaders,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            nickname: nicknameDraft,
            apiKey: apiKeyDraft,
            apiSecret: apiSecretDraft,
          }),
        }),
      ]);
      if (!statusRes.ok || !keysRes.ok) {
        throw new Error(`Save failed (${statusRes.status}/${keysRes.status})`);
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save management changes");
    } finally {
      setSaving(false);
    }
  }, [apiKeyDraft, apiSecretDraft, authHeaders, load, nicknameDraft, statusDraft, userId]);

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
            <div className="rounded-lg border border-glassBorder bg-white/[0.02] px-4 py-3">
              <p className="text-[10px] uppercase tracking-wider text-white/45">Delta Total Balance</p>
              <p className="mt-1 text-lg font-semibold text-cyan-300 tabular-nums">${Number(balanceUsd ?? 0).toFixed(2)}</p>
            </div>
          </div>

          <div className="rounded-xl border border-glassBorder bg-white/[0.02] p-4">
            <p className="text-xs uppercase tracking-wider text-white/45">Profile Overview</p>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <ProfileField label="Full Name" value={user?.name ?? "—"} />
              <ProfileField label="Email" value={user?.email ?? "—"} />
              <ProfileField label="Mobile Number" value={user?.mobile ?? "—"} />
              <ProfileField label="Current Address" value={user?.address ?? "—"} />
              <ProfileField label="PAN Number" value={user?.panNumber ?? "—"} />
              <ProfileField label="Aadhaar Number" value={user?.aadhaarNumber ?? "—"} />
            </div>
          </div>

          <div className="inline-flex rounded-lg border border-glassBorder bg-white/[0.03] p-1 text-sm">
            <button
              type="button"
              onClick={() => setTab("management")}
              className={`rounded-md px-3 py-1.5 ${tab === "management" ? "bg-primary/20 text-primary" : "text-white/70 hover:bg-white/5"}`}
            >
              Management
            </button>
            <button
              type="button"
              onClick={() => setTab("subscriptions")}
              className={`rounded-md px-3 py-1.5 ${tab === "subscriptions" ? "bg-primary/20 text-primary" : "text-white/70 hover:bg-white/5"}`}
            >
              Subscriptions
            </button>
            <button
              type="button"
              onClick={() => setTab("trades")}
              className={`rounded-md px-3 py-1.5 ${tab === "trades" ? "bg-primary/20 text-primary" : "text-white/70 hover:bg-white/5"}`}
            >
              Trade History
            </button>
            <button
              type="button"
              onClick={() => setTab("changeRequests")}
              className={`rounded-md px-3 py-1.5 ${tab === "changeRequests" ? "bg-primary/20 text-primary" : "text-white/70 hover:bg-white/5"}`}
            >
              Change Requests
            </button>
            <button
              type="button"
              onClick={() => setTab("transactions")}
              className={`rounded-md px-3 py-1.5 ${tab === "transactions" ? "bg-primary/20 text-primary" : "text-white/70 hover:bg-white/5"}`}
            >
              Transactions
            </button>
          </div>

          {tab === "management" ? (
            <div className="space-y-4 rounded-xl border border-glassBorder bg-white/[0.02] p-4">
              <div className="grid gap-4 md:grid-cols-2">
                <label className="text-sm text-white/70">
                  User Status
                  <select
                    value={statusDraft}
                    onChange={(e) => setStatusDraft(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40"
                  >
                    <option value="ACTIVE">ACTIVE</option>
                    <option value="SUSPENDED">SUSPENDED</option>
                  </select>
                </label>
                <label className="text-sm text-white/70">
                  API Nickname
                  <input
                    value={nicknameDraft}
                    onChange={(e) => setNicknameDraft(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40"
                  />
                </label>
                <label className="text-sm text-white/70">
                  API Key
                  <input
                    value={apiKeyDraft}
                    onChange={(e) => setApiKeyDraft(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40"
                  />
                </label>
                <label className="text-sm text-white/70">
                  API Secret
                  <input
                    value={apiSecretDraft}
                    onChange={(e) => setApiSecretDraft(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40"
                  />
                </label>
              </div>
              <p className="text-xs text-white/45">{exchangeHint}</p>
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => void saveManagement()}
                  disabled={saving}
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition hover:bg-primary/90 disabled:opacity-60"
                >
                  {saving ? "Saving..." : "Save Management Changes"}
                </button>
                <button
                  type="button"
                  onClick={() => void sendResetLink()}
                  disabled={sendingReset}
                  className="rounded-lg border border-blue-500/45 bg-blue-500/15 px-3 py-2 text-xs font-medium text-blue-200 transition hover:bg-blue-500/25 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {sendingReset ? "Sending..." : "Send Password Reset Link"}
                </button>
                <button
                  type="button"
                  onClick={() => void flushTradeHistory()}
                  disabled={flushing}
                  className="rounded-lg border border-red-500/45 bg-red-500/15 px-3 py-2 text-xs font-medium text-red-200 transition hover:bg-red-500/25 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {flushing ? "Flushing..." : "Flush Trade History"}
                </button>
              </div>
            </div>
          ) : tab === "subscriptions" ? (
            <div className="space-y-2">
              {strategies.length === 0 ? (
                <p className="text-sm text-white/55">No deployed strategies found.</p>
              ) : (
                strategies.map((s) => (
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
                ))
              )}
            </div>
          ) : tab === "changeRequests" ? (
            <div className="space-y-3">
              {requests.length === 0 ? (
                <p className="text-sm text-white/55">No pending profile change requests.</p>
              ) : (
                requests.map((r) => (
                  <div key={r.id} className="rounded-lg border border-glassBorder bg-white/[0.02] p-4 text-sm">
                    <p className="text-xs text-white/45">Requested on {new Date(r.createdAt).toLocaleString()}</p>
                    <div className="mt-2 grid gap-2 md:grid-cols-3">
                      <RequestField label="Address" current={currentProfile?.address ?? null} requested={r.address} />
                      <RequestField label="PAN Number" current={currentProfile?.panNumber ?? null} requested={r.panNumber} />
                      <RequestField label="Aadhaar Number" current={currentProfile?.aadhaarNumber ?? null} requested={r.aadhaarNumber} />
                    </div>
                    <div className="mt-3 flex gap-2">
                      <button
                        type="button"
                        onClick={() => void decideRequest(r.id, "approve")}
                        className="rounded-md bg-emerald-500/20 px-3 py-1.5 text-xs font-medium text-emerald-200 hover:bg-emerald-500/30"
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        onClick={() => void decideRequest(r.id, "reject")}
                        className="rounded-md bg-red-500/20 px-3 py-1.5 text-xs font-medium text-red-200 hover:bg-red-500/30"
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          ) : tab === "transactions" ? (
            <div className="glass-card border border-glassBorder overflow-hidden">
              <div className="scroll-table overflow-x-auto">
                <table className="w-full min-w-[700px] text-left text-sm">
                  <thead className="border-b border-glassBorder bg-white/[0.03] text-white/70">
                    <tr>
                      <th className="px-3 py-2 font-medium">Date</th>
                      <th className="px-3 py-2 font-medium">Type</th>
                      <th className="px-3 py-2 font-medium">Status</th>
                      <th className="px-3 py-2 font-medium">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {transactions.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="px-3 py-8 text-center text-white/45">
                          No transactions found.
                        </td>
                      </tr>
                    ) : (
                      transactions.map((t) => (
                        <tr key={t.id} className="border-b border-white/[0.06] last:border-0">
                          <td className="px-3 py-2 text-white/60">{new Date(t.createdAt).toLocaleString()}</td>
                          <td className="px-3 py-2 text-white">{t.type}</td>
                          <td className="px-3 py-2 text-white/80">{t.status}</td>
                          <td className="px-3 py-2 text-white tabular-nums">${t.amount.toFixed(2)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
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
                      <th className="px-3 py-2 font-medium">Trading Fee</th>
                      <th className="px-3 py-2 font-medium">Admin Revenue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trades.length === 0 ? (
                      <tr>
                        <td colSpan={9} className="px-3 py-8 text-center text-white/45">
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
                          <td className="px-3 py-2 text-white tabular-nums">${t.tradingFee.toFixed(2)}</td>
                          <td className="px-3 py-2 text-white tabular-nums">${t.adminRevenue.toFixed(2)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function ProfileField({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-white/10 px-3 py-2">
      <p className="text-[11px] uppercase tracking-wider text-white/45">{label}</p>
      <p className="mt-1 text-sm text-white">{value || "—"}</p>
    </div>
  );
}

function RequestField({
  label,
  current,
  requested,
}: {
  label: string;
  current: string | null;
  requested: string | null;
}) {
  return (
    <div className="rounded-md border border-white/10 px-3 py-2">
      <p className="text-[11px] uppercase tracking-wider text-white/45">{label}</p>
      <p className="mt-1 text-xs text-white/50">Current: {current ?? "—"}</p>
      <p className="mt-1 text-sm text-cyan-200">Requested: {requested ?? "—"}</p>
    </div>
  );
}

