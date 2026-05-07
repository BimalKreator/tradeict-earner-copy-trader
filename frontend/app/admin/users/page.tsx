"use client";

import Link from "next/link";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";

const ENV_API_BASE =
  process.env.NEXT_PUBLIC_API_URL?.trim().replace(/\/$/, "") ?? "";

/** Backend prefix: env, or same-origin `/api` when env is missing (typical reverse-proxy setup). */
function resolveAdminApiBase(): string {
  if (ENV_API_BASE) return ENV_API_BASE;
  if (typeof window !== "undefined") {
    return `${window.location.origin.replace(/\/$/, "")}/api`;
  }
  return "";
}

function authHeaders(): HeadersInit {
  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

type AdminUser = {
  id: string;
  email: string;
  role: string;
  status: string;
  createdAt: string;
};

type UserStrategyState = {
  id: string;
  strategyId: string;
  strategyTitle: string;
  status: string;
  multiplier: number;
  joinedDate: string;
  exchangeAccount: { id: string; nickname: string; exchange: string } | null;
};

type UserTradeRow = {
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

type UserBillingSummary = {
  totalPnlToDate: number;
  totalAdminCommissionEarned: number;
  amountPaid: number;
  balanceDue: number;
};

export default function AdminUsersPage() {
  const apiBase = useMemo(() => resolveAdminApiBase(), []);

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null);
  const [userStrategies, setUserStrategies] = useState<Record<string, UserStrategyState[]>>({});
  const [userStrategiesLoading, setUserStrategiesLoading] = useState<Record<string, boolean>>({});
  const [detailTabByUser, setDetailTabByUser] = useState<Record<string, "strategies" | "trades">>({});
  const [userTrades, setUserTrades] = useState<Record<string, UserTradeRow[]>>({});
  const [userBillingSummary, setUserBillingSummary] = useState<Record<string, UserBillingSummary | null>>({});
  const [userTradesLoading, setUserTradesLoading] = useState<Record<string, boolean>>({});

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("USER");
  const [status, setStatus] = useState("ACTIVE");

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/admin/users`, {
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const data: unknown = await res.json();
      if (!Array.isArray(data)) throw new Error("Invalid response");
      setUsers(data as AdminUser[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load users");
      setUsers([]);
    } finally {
      setLoading(false);
    }
  }, [apiBase]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- on-mount fetch is a legitimate effect side-effect
    void loadUsers();
  }, [loadUsers]);

  async function handleCreateUser(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setFormError(null);
    try {
      const res = await fetch(`${apiBase}/admin/users`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          email,
          password,
          role,
          status,
        }),
      });
      const body: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg =
          typeof body === "object" &&
          body !== null &&
          "error" in body &&
          typeof (body as { error?: unknown }).error === "string"
            ? (body as { error: string }).error
            : `Create failed (${res.status})`;
        throw new Error(msg);
      }
      setModalOpen(false);
      setEmail("");
      setPassword("");
      setRole("USER");
      setStatus("ACTIVE");
      await loadUsers();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Create failed");
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleUserStrategies(userId: string) {
    if (expandedUserId === userId) {
      setExpandedUserId(null);
      return;
    }
    setExpandedUserId(userId);
    if (userStrategies[userId] !== undefined) return;
    setUserStrategiesLoading((p) => ({ ...p, [userId]: true }));
    try {
      const res = await fetch(`${apiBase}/admin/users/${userId}/strategies`, {
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const data = (await res.json()) as { strategies?: UserStrategyState[] };
      setUserStrategies((p) => ({ ...p, [userId]: data.strategies ?? [] }));
    } catch {
      setUserStrategies((p) => ({ ...p, [userId]: [] }));
    } finally {
      setUserStrategiesLoading((p) => ({ ...p, [userId]: false }));
    }
  }

  async function loadUserTradeBilling(userId: string) {
    if (userTrades[userId] !== undefined && userBillingSummary[userId] !== undefined) return;
    setUserTradesLoading((p) => ({ ...p, [userId]: true }));
    try {
      const res = await fetch(`${apiBase}/admin/users/${userId}/trades-billing`, {
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const data = (await res.json()) as {
        trades?: UserTradeRow[];
        billingSummary?: UserBillingSummary;
      };
      setUserTrades((p) => ({ ...p, [userId]: data.trades ?? [] }));
      setUserBillingSummary((p) => ({ ...p, [userId]: data.billingSummary ?? null }));
    } catch {
      setUserTrades((p) => ({ ...p, [userId]: [] }));
      setUserBillingSummary((p) => ({ ...p, [userId]: null }));
    } finally {
      setUserTradesLoading((p) => ({ ...p, [userId]: false }));
    }
  }

  return (
    <div className="mx-auto max-w-6xl">
      <header className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">
            Users
          </h1>
          <p className="mt-1 text-sm text-white/55">
            Manage platform accounts from the admin API.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setFormError(null);
            setModalOpen(true);
          }}
          className="rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-white shadow-lg shadow-primary/25 transition hover:bg-primary/90"
        >
          Add user
        </button>
      </header>

      {error && (
        <div className="mb-6 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      <div className="glass-card border border-glassBorder overflow-hidden">
        <div className="scroll-table overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="border-b border-glassBorder bg-white/[0.03]">
              <tr>
                <th className="px-4 py-3 font-medium text-white/70">Email</th>
                <th className="px-4 py-3 font-medium text-white/70">Role</th>
                <th className="px-4 py-3 font-medium text-white/70">Status</th>
                <th className="px-4 py-3 font-medium text-white/70">Created</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={4} className="px-4 py-10 text-center text-white/45">
                    Loading users…
                  </td>
                </tr>
              ) : users.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-10 text-center text-white/45">
                    No users found.
                  </td>
                </tr>
              ) : (
                users.map((u) => (
                  <Fragment key={u.id}>
                    <tr
                      className="border-b border-white/[0.06] hover:bg-white/[0.02]"
                    >
                      <td className="px-4 py-3 font-medium text-white">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => void toggleUserStrategies(u.id)}
                            className="text-left hover:text-primary"
                          >
                            {u.email}
                          </button>
                          <Link href={`/admin/users/${u.id}`} className="text-xs text-primary hover:underline">
                            Details
                          </Link>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-white/80">{u.role}</td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                            u.status === "ACTIVE"
                              ? "bg-emerald-500/15 text-emerald-300"
                              : "bg-amber-500/15 text-amber-200"
                          }`}
                        >
                          {u.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-white/55 tabular-nums">
                        {new Date(u.createdAt).toLocaleString()}
                      </td>
                    </tr>
                    {expandedUserId === u.id && (
                      <tr className="border-b border-white/[0.06] bg-white/[0.02]">
                        <td colSpan={4} className="px-4 py-4">
                          <p className="mb-2 text-xs uppercase tracking-wider text-white/50">
                            User Details
                          </p>
                          <div className="mb-3 inline-flex rounded-lg border border-glassBorder bg-white/[0.03] p-1 text-xs">
                            <button
                              type="button"
                              onClick={() =>
                                setDetailTabByUser((p) => ({ ...p, [u.id]: "strategies" }))
                              }
                              className={`rounded-md px-3 py-1.5 ${
                                (detailTabByUser[u.id] ?? "strategies") === "strategies"
                                  ? "bg-primary/20 text-primary"
                                  : "text-white/60 hover:bg-white/5"
                              }`}
                            >
                              Strategy States
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setDetailTabByUser((p) => ({ ...p, [u.id]: "trades" }));
                                void loadUserTradeBilling(u.id);
                              }}
                              className={`rounded-md px-3 py-1.5 ${
                                (detailTabByUser[u.id] ?? "strategies") === "trades"
                                  ? "bg-primary/20 text-primary"
                                  : "text-white/60 hover:bg-white/5"
                              }`}
                            >
                              Trade History
                            </button>
                          </div>
                          {(detailTabByUser[u.id] ?? "strategies") === "strategies" ? (
                            userStrategiesLoading[u.id] ? (
                              <p className="text-sm text-white/55">Loading strategies...</p>
                            ) : (userStrategies[u.id]?.length ?? 0) === 0 ? (
                              <p className="text-sm text-white/55">No strategy interactions.</p>
                            ) : (
                              <div className="space-y-2">
                                {userStrategies[u.id]!.map((s) => (
                                  <div key={s.id} className="flex flex-wrap items-center gap-2 rounded-md border border-white/10 px-3 py-2 text-sm">
                                    <span className="font-medium text-white">{s.strategyTitle}</span>
                                    <span className={`rounded px-2 py-0.5 text-xs ${
                                      s.status === "ACTIVE"
                                        ? "bg-emerald-500/15 text-emerald-300"
                                        : "bg-amber-500/15 text-amber-200"
                                    }`}>
                                      {s.status === "ACTIVE" ? "DEPLOYED" : "PAUSED"}
                                    </span>
                                    <span className="text-white/60">Multiplier: {s.multiplier}x</span>
                                    <span className="text-white/50">
                                      {s.exchangeAccount ? `Account: ${s.exchangeAccount.nickname}` : "Not configured"}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            )
                          ) : (
                            <>
                              {userTradesLoading[u.id] ? (
                                <p className="text-sm text-white/55">Loading trades...</p>
                              ) : (
                                <>
                                  <div className="mb-3 grid gap-3 md:grid-cols-4">
                                    <div className="rounded-lg border border-glassBorder bg-white/[0.02] px-3 py-2">
                                      <p className="text-[10px] uppercase tracking-wider text-white/45">Total P&L to date</p>
                                      <p className="mt-1 text-sm font-semibold text-white tabular-nums">
                                        ${Number(userBillingSummary[u.id]?.totalPnlToDate ?? 0).toFixed(2)}
                                      </p>
                                    </div>
                                    <div className="rounded-lg border border-glassBorder bg-white/[0.02] px-3 py-2">
                                      <p className="text-[10px] uppercase tracking-wider text-white/45">Total Admin Commission Earned</p>
                                      <p className="mt-1 text-sm font-semibold text-white tabular-nums">
                                        ${Number(userBillingSummary[u.id]?.totalAdminCommissionEarned ?? 0).toFixed(2)}
                                      </p>
                                    </div>
                                    <div className="rounded-lg border border-glassBorder bg-white/[0.02] px-3 py-2">
                                      <p className="text-[10px] uppercase tracking-wider text-white/45">Amount Paid</p>
                                      <p className="mt-1 text-sm font-semibold text-emerald-300 tabular-nums">
                                        ${Number(userBillingSummary[u.id]?.amountPaid ?? 0).toFixed(2)}
                                      </p>
                                    </div>
                                    <div className="rounded-lg border border-glassBorder bg-white/[0.02] px-3 py-2">
                                      <p className="text-[10px] uppercase tracking-wider text-white/45">Balance Due</p>
                                      <p className="mt-1 text-sm font-semibold text-red-300 tabular-nums">
                                        ${Number(userBillingSummary[u.id]?.balanceDue ?? 0).toFixed(2)}
                                      </p>
                                    </div>
                                  </div>
                                  <div className="scroll-table overflow-x-auto">
                                    <table className="w-full min-w-[860px] text-left text-xs">
                                      <thead className="border-b border-white/10 text-white/60">
                                        <tr>
                                          <th className="px-2 py-2 font-medium">Time</th>
                                          <th className="px-2 py-2 font-medium">Strategy</th>
                                          <th className="px-2 py-2 font-medium">Symbol</th>
                                          <th className="px-2 py-2 font-medium">Entry</th>
                                          <th className="px-2 py-2 font-medium">Exit</th>
                                          <th className="px-2 py-2 font-medium">P&L</th>
                                          <th className="px-2 py-2 font-medium">Admin Fee/Revenue</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {(userTrades[u.id] ?? []).map((t) => (
                                          <tr key={t.id} className="border-b border-white/[0.06]">
                                            <td className="px-2 py-2 text-white/55">{new Date(t.createdAt).toLocaleString()}</td>
                                            <td className="px-2 py-2 text-white">{t.strategyTitle}</td>
                                            <td className="px-2 py-2 text-white/80">{t.symbol}</td>
                                            <td className="px-2 py-2 text-white/80 tabular-nums">${t.entryPrice.toFixed(2)}</td>
                                            <td className="px-2 py-2 text-white/80 tabular-nums">
                                              {t.exitPrice != null ? `$${t.exitPrice.toFixed(2)}` : "—"}
                                            </td>
                                            <td className={`px-2 py-2 tabular-nums ${t.pnl >= 0 ? "text-emerald-300" : "text-red-300"}`}>
                                              ${t.pnl.toFixed(2)}
                                            </td>
                                            <td className="px-2 py-2 text-white tabular-nums">${t.adminRevenue.toFixed(2)}</td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                </>
                              )}
                            </>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {modalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="add-user-title"
        >
          <div className="glass-card w-full max-w-md border border-glassBorder p-6 shadow-2xl">
            <h2 id="add-user-title" className="text-lg font-semibold text-white">
              Add user
            </h2>
            <p className="mt-1 text-sm text-white/50">
              Creates a user via POST /api/admin/users
            </p>

            <form onSubmit={handleCreateUser} className="mt-6 space-y-4">
              {formError && (
                <p className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                  {formError}
                </p>
              )}
              <label className="block">
                <span className="text-xs font-medium text-white/60">Email</span>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white outline-none ring-primary/30 placeholder:text-white/30 focus:ring-2"
                  placeholder="you@example.com"
                />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-white/60">Password</span>
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white outline-none ring-primary/30 focus:ring-2"
                  placeholder="••••••••"
                />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="text-xs font-medium text-white/60">Role</span>
                  <select
                    value={role}
                    onChange={(e) => setRole(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40"
                  >
                    <option value="USER">USER</option>
                    <option value="ADMIN">ADMIN</option>
                  </select>
                </label>
                <label className="block">
                  <span className="text-xs font-medium text-white/60">Status</span>
                  <select
                    value={status}
                    onChange={(e) => setStatus(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40"
                  >
                    <option value="ACTIVE">ACTIVE</option>
                    <option value="SUSPENDED">SUSPENDED</option>
                  </select>
                </label>
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  className="rounded-lg px-4 py-2 text-sm font-medium text-white/70 transition hover:bg-white/10"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white shadow-lg shadow-primary/20 disabled:opacity-50"
                >
                  {submitting ? "Creating…" : "Create user"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
