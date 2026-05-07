"use client";

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
                        <button
                          type="button"
                          onClick={() => void toggleUserStrategies(u.id)}
                          className="text-left hover:text-primary"
                        >
                          {u.email}
                        </button>
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
                            Strategy Lifecycle States
                          </p>
                          {userStrategiesLoading[u.id] ? (
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
