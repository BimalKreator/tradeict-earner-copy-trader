"use client";

import Link from "next/link";
import { Eye, Mail } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAdminEmailActions } from "@/components/admin/AdminEmailOptions";
import { EmailManagerModal } from "@/components/admin/EmailManagerModal";

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
  name: string | null;
  email: string;
  role: string;
  status: string;
  createdAt: string;
  totalPnlToDate: number;
  walletBalance: number;
  deltaBalance: number | null;
  deltaConnected: boolean;
};

const usdFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return usdFmt.format(n);
}

export default function AdminUsersPage() {
  const apiBase = useMemo(() => resolveAdminApiBase(), []);

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ type: "ok" | "err"; text: string } | null>(
    null,
  );
  const [modalOpen, setModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("USER");
  const [status, setStatus] = useState("ACTIVE");

  const {
    emailManagerUser,
    isEmailManagerOpen,
    openEmailManager,
    closeEmailManager,
  } = useAdminEmailActions({ onToast: setToast });

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
      setUsers(
        (data as Record<string, unknown>[]).map((row) => ({
          id: String(row.id ?? ""),
          name: typeof row.name === "string" ? row.name : null,
          email: String(row.email ?? ""),
          role: String(row.role ?? ""),
          status: String(row.status ?? ""),
          createdAt: String(row.createdAt ?? ""),
          totalPnlToDate:
            typeof row.totalPnlToDate === "number" && Number.isFinite(row.totalPnlToDate)
              ? row.totalPnlToDate
              : 0,
          walletBalance:
            typeof row.walletBalance === "number" && Number.isFinite(row.walletBalance)
              ? row.walletBalance
              : 0,
          deltaBalance:
            typeof row.deltaBalance === "number" && Number.isFinite(row.deltaBalance)
              ? row.deltaBalance
              : null,
          deltaConnected: row.deltaConnected === true,
        })),
      );
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

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 5000);
    return () => window.clearTimeout(t);
  }, [toast]);

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

  return (
    <div className="mx-auto w-full min-w-0 max-w-6xl">
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

      {toast ? (
        <div
          className={`mb-6 rounded-lg border px-4 py-3 text-sm ${
            toast.type === "ok"
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-100"
              : "border-red-500/40 bg-red-500/10 text-red-200"
          }`}
          role="status"
        >
          {toast.text}
        </div>
      ) : null}

      {error && (
        <div className="mb-6 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      <div className="glass-card border border-glassBorder">
        <div className="scroll-table overflow-x-auto">
          <table className="w-full min-w-[1200px] text-left text-sm">
            <thead className="border-b border-glassBorder bg-white/[0.03]">
              <tr>
                <th className="px-4 py-3 font-medium text-white/70">User Name</th>
                <th className="px-4 py-3 font-medium text-white/70">Email</th>
                <th className="px-4 py-3 font-medium text-white/70">Status</th>
                <th className="px-4 py-3 font-medium text-white/70">Wallet Balance</th>
                <th className="px-4 py-3 font-medium text-white/70">Delta Balance</th>
                <th className="px-4 py-3 font-medium text-white/70">Total PnL</th>
                <th className="px-4 py-3 font-medium text-white/70 min-w-[280px]">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-white/45">
                    Loading users…
                  </td>
                </tr>
              ) : users.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-white/45">
                    No users found.
                  </td>
                </tr>
              ) : (
                users.map((u) => (
                  <tr
                    key={u.id}
                    className="border-b border-white/[0.06] hover:bg-white/[0.02]"
                  >
                    <td className="px-4 py-3 text-white/90">
                      {u.name?.trim() || "—"}
                    </td>
                    <td className="px-4 py-3 font-medium text-white">{u.email}</td>
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
                    <td className="px-4 py-3 tabular-nums text-white/85">
                      {fmtUsd(u.walletBalance)}
                    </td>
                    <td
                      className="px-4 py-3 tabular-nums text-white/85"
                      title={
                        !u.deltaConnected
                          ? "No Delta API keys linked"
                          : u.deltaBalance === null
                            ? "Delta balance unavailable (fetch failed or timed out)"
                            : "Live total balance from Delta Exchange India"
                      }
                    >
                      {fmtUsd(u.deltaBalance)}
                      {!u.deltaConnected ? (
                        <span className="ml-1.5 text-[10px] text-white/35">N/C</span>
                      ) : null}
                    </td>
                    <td
                      className={`px-4 py-3 tabular-nums ${
                        u.totalPnlToDate >= 0 ? "text-emerald-300" : "text-red-300"
                      }`}
                    >
                      {fmtUsd(u.totalPnlToDate)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-row items-center justify-end gap-2">
                        <Link
                          href={`/admin/users/${u.id}`}
                          title="View Details"
                          aria-label="View Details"
                          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-primary/40 bg-primary/15 text-primary transition hover:bg-primary/25"
                        >
                          <Eye className="h-4 w-4" aria-hidden />
                        </Link>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            openEmailManager({
                              id: u.id,
                              email: u.email,
                              name: u.name,
                            });
                          }}
                          title="Email Options"
                          aria-label="Email Options"
                          className="relative z-10 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-sky-500/35 bg-sky-500/10 text-sky-100 transition hover:bg-sky-500/20"
                        >
                          <Mail className="h-4 w-4" aria-hidden />
                        </button>
                      </div>
                    </td>
                  </tr>
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

      <EmailManagerModal
        open={isEmailManagerOpen}
        recipient={emailManagerUser}
        apiBase={apiBase}
        authHeaders={authHeaders}
        onClose={closeEmailManager}
        onToast={setToast}
      />
    </div>
  );
}
