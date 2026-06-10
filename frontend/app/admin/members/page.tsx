"use client";

import { Loader2, RefreshCw, UserPlus, UsersRound, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

const ENV_API_BASE =
  process.env.NEXT_PUBLIC_API_URL?.trim().replace(/\/$/, "") ?? "";

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

type SearchUser = {
  id: string;
  email: string;
  label: string;
};

type TeamMember = {
  id: string;
  name: string | null;
  email: string;
  role: string;
  parentId: string | null;
  parent: {
    id: string;
    name: string | null;
    email: string;
    role: string;
  } | null;
  directAcquiredCount: number;
  networkAum: number;
  referralCode: string | null;
  upgradedAt: string | null;
};

type SalesRole = "EXECUTIVE" | "MANAGER" | "DIRECTOR";

const ROLE_LABELS: Record<SalesRole, string> = {
  EXECUTIVE: "Team Executive",
  MANAGER: "Team Manager",
  DIRECTOR: "Team Director",
};

const usdFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

function roleBadgeClass(role: string): string {
  if (role === "DIRECTOR") return "bg-violet-500/15 text-violet-200 ring-violet-500/30";
  if (role === "MANAGER") return "bg-sky-500/15 text-sky-200 ring-sky-500/30";
  if (role === "EXECUTIVE") return "bg-emerald-500/15 text-emerald-200 ring-emerald-500/30";
  return "bg-white/10 text-white/70 ring-white/20";
}

export default function AdminMembersPage() {
  const apiBase = useMemo(() => resolveAdminApiBase(), []);

  const [members, setMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ type: "ok" | "err"; text: string } | null>(
    null,
  );

  const [modalOpen, setModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [userQuery, setUserQuery] = useState("");
  const [userResults, setUserResults] = useState<SearchUser[]>([]);
  const [userSearchLoading, setUserSearchLoading] = useState(false);
  const [selectedUser, setSelectedUser] = useState<SearchUser | null>(null);
  const [newRole, setNewRole] = useState<SalesRole>("EXECUTIVE");
  const [parentId, setParentId] = useState<string>("");

  const loadMembers = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`${apiBase}/admin/members`, {
        headers: authHeaders(),
      });
      if (res.status === 403) {
        throw new Error("Admin access required");
      }
      if (!res.ok) throw new Error(`Failed to load members (${res.status})`);
      const data = (await res.json()) as { members?: TeamMember[] };
      setMembers(
        (data.members ?? []).map((m) => ({
          ...m,
          directAcquiredCount: m.directAcquiredCount ?? 0,
          networkAum: m.networkAum ?? 0,
        })),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
      setMembers([]);
    } finally {
      setLoading(false);
    }
  }, [apiBase]);

  useEffect(() => {
    void loadMembers();
  }, [loadMembers]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 5000);
    return () => window.clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (!modalOpen) return;
    const q = userQuery.trim();
    if (q.length < 3) {
      setUserResults([]);
      return;
    }
    const handle = window.setTimeout(() => {
      void (async () => {
        setUserSearchLoading(true);
        try {
          const res = await fetch(
            `${apiBase}/admin/users/search?q=${encodeURIComponent(q)}`,
            { headers: authHeaders() },
          );
          if (!res.ok) return;
          const data = (await res.json()) as { users?: SearchUser[] };
          setUserResults(data.users ?? []);
        } finally {
          setUserSearchLoading(false);
        }
      })();
    }, 300);
    return () => window.clearTimeout(handle);
  }, [apiBase, modalOpen, userQuery]);

  const parentOptions = useMemo(() => {
    if (newRole === "DIRECTOR") {
      return members.filter((m) => m.role === "DIRECTOR");
    }
    if (newRole === "MANAGER") {
      return members.filter((m) => m.role === "DIRECTOR");
    }
    return members.filter(
      (m) => m.role === "MANAGER" || m.role === "DIRECTOR",
    );
  }, [members, newRole]);

  const parentRequired = newRole !== "DIRECTOR";

  function resetModal() {
    setFormError(null);
    setUserQuery("");
    setUserResults([]);
    setSelectedUser(null);
    setNewRole("EXECUTIVE");
    setParentId("");
  }

  function openModal() {
    resetModal();
    setModalOpen(true);
  }

  async function handleUpgrade(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedUser) {
      setFormError("Select a user to upgrade.");
      return;
    }
    if (parentRequired && !parentId) {
      setFormError("Select an upline (parent) for this role.");
      return;
    }

    setSubmitting(true);
    setFormError(null);
    try {
      const res = await fetch(`${apiBase}/admin/members/upgrade`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          userId: selectedUser.id,
          newRole,
          parentId: parentId || null,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        throw new Error(
          body.error ??
            "Upgrade failed. Ensure the user has an active paid subscription.",
        );
      }
      setModalOpen(false);
      setToast({
        type: "ok",
        text: `${selectedUser.label} upgraded to ${ROLE_LABELS[newRole]}.`,
      });
      await loadMembers();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Upgrade failed";
      setFormError(msg);
      setToast({ type: "err", text: msg });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">
            Member Management
          </h1>
          <p className="mt-1 text-sm text-white/55">
            Assign sales roles, map hierarchy, and view partner network stats.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void loadMembers()}
            className="inline-flex items-center gap-2 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm text-white/80 transition hover:bg-white/10"
          >
            <RefreshCw className="h-4 w-4" aria-hidden />
            Refresh
          </button>
          <button
            type="button"
            onClick={openModal}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-white shadow-lg shadow-primary/25 transition hover:bg-primary/90"
          >
            <UserPlus className="h-4 w-4" aria-hidden />
            Upgrade user to member
          </button>
        </div>
      </header>

      {toast ? (
        <div
          className={`rounded-lg border px-4 py-3 text-sm ${
            toast.type === "ok"
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-100"
              : "border-red-500/40 bg-red-500/10 text-red-200"
          }`}
          role="status"
        >
          {toast.text}
        </div>
      ) : null}

      {error ? (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      ) : null}

      <div className="glass-card border border-glassBorder overflow-hidden">
        <div className="flex items-center gap-2 border-b border-glassBorder bg-white/[0.03] px-4 py-3">
          <UsersRound className="h-4 w-4 text-primary" aria-hidden />
          <span className="text-sm font-medium text-white/80">Team members</span>
          <span className="ml-auto text-xs text-white/40">
            {members.length} member{members.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className="scroll-table overflow-x-auto">
          <table className="w-full min-w-[960px] text-left text-sm">
            <thead className="border-b border-glassBorder bg-white/[0.02]">
              <tr>
                <th className="px-4 py-3 font-medium text-white/70">Name</th>
                <th className="px-4 py-3 font-medium text-white/70">Email</th>
                <th className="px-4 py-3 font-medium text-white/70">Role</th>
                <th className="px-4 py-3 font-medium text-white/70">Upline</th>
                <th className="px-4 py-3 font-medium text-white/70">Direct acquired</th>
                <th className="px-4 py-3 font-medium text-white/70">Network AUM</th>
                <th className="px-4 py-3 font-medium text-white/70">Referral code</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-white/45">
                    <Loader2 className="mx-auto h-6 w-6 animate-spin" aria-hidden />
                    <span className="mt-2 block">Loading team members…</span>
                  </td>
                </tr>
              ) : members.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-white/45">
                    No team members yet. Upgrade a subscribed user to get started.
                  </td>
                </tr>
              ) : (
                members.map((m) => (
                  <tr
                    key={m.id}
                    className="border-b border-white/[0.06] hover:bg-white/[0.02]"
                  >
                    <td className="px-4 py-3 text-white/90">
                      {m.name?.trim() || "—"}
                    </td>
                    <td className="px-4 py-3 font-medium text-white">{m.email}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ${roleBadgeClass(m.role)}`}
                      >
                        {ROLE_LABELS[m.role as SalesRole] ?? m.role}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-white/75">
                      {m.parent ? (
                        <span title={m.parent.email}>
                          {m.parent.name?.trim() || m.parent.email}
                          <span className="ml-1 text-xs text-white/40">
                            ({m.parent.role})
                          </span>
                        </span>
                      ) : (
                        <span className="text-white/35">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-white/85">
                      {m.directAcquiredCount}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-white/85">
                      {usdFmt.format(m.networkAum)}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-primary/90">
                      {m.referralCode ?? "—"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {modalOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="upgrade-member-title"
        >
          <div className="glass-card max-h-[90vh] w-full max-w-lg overflow-y-auto border border-glassBorder p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2
                  id="upgrade-member-title"
                  className="text-lg font-semibold text-white"
                >
                  Upgrade user to team member
                </h2>
                <p className="mt-1 text-sm text-white/50">
                  User must have an active, paid strategy subscription.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="rounded-lg border border-white/10 p-2 text-white/60 hover:bg-white/10 hover:text-white"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={(e) => void handleUpgrade(e)} className="mt-6 space-y-4">
              {formError ? (
                <p className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                  {formError}
                </p>
              ) : null}

              <label className="block">
                <span className="text-xs font-medium text-white/60">
                  Search user (min 3 characters)
                </span>
                <input
                  type="search"
                  value={userQuery}
                  onChange={(e) => {
                    setUserQuery(e.target.value);
                    setSelectedUser(null);
                  }}
                  className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white outline-none ring-primary/30 placeholder:text-white/30 focus:ring-2"
                  placeholder="Name, email, or phone"
                  autoComplete="off"
                />
              </label>

              {userSearchLoading ? (
                <p className="text-xs text-white/45">Searching…</p>
              ) : null}

              {userResults.length > 0 && !selectedUser ? (
                <ul className="max-h-40 overflow-y-auto rounded-lg border border-glassBorder bg-black/30">
                  {userResults.map((u) => (
                    <li key={u.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedUser(u);
                          setUserQuery(u.label);
                          setUserResults([]);
                        }}
                        className="w-full px-3 py-2 text-left text-sm text-white/85 hover:bg-white/10"
                      >
                        <span className="font-medium">{u.label}</span>
                        <span className="ml-2 text-xs text-white/40">{u.email}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}

              {selectedUser ? (
                <p className="rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-sm text-primary/90">
                  Selected: <strong>{selectedUser.label}</strong> ({selectedUser.email})
                </p>
              ) : null}

              <label className="block">
                <span className="text-xs font-medium text-white/60">Sales role</span>
                <select
                  value={newRole}
                  onChange={(e) => {
                    setNewRole(e.target.value as SalesRole);
                    setParentId("");
                  }}
                  className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40"
                >
                  <option value="EXECUTIVE">Team Executive (5% / 2% / 1%)</option>
                  <option value="MANAGER">Team Manager (6% / 2%)</option>
                  <option value="DIRECTOR">Team Director (8%)</option>
                </select>
              </label>

              <label className="block">
                <span className="text-xs font-medium text-white/60">
                  Upline (parent)
                  {!parentRequired ? " — optional for Directors" : " — required"}
                </span>
                <select
                  value={parentId}
                  onChange={(e) => setParentId(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-50"
                  disabled={!parentRequired && parentOptions.length === 0}
                >
                  <option value="">
                    {parentRequired
                      ? "Select upline…"
                      : "No upline (top-level Director)"}
                  </option>
                  {parentOptions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {(p.name?.trim() || p.email) + ` — ${p.role}`}
                    </option>
                  ))}
                </select>
                {parentRequired && parentOptions.length === 0 ? (
                  <p className="mt-1 text-xs text-amber-200/90">
                    No eligible upline yet. Add a Director first, or assign a Manager
                    before upgrading Executives.
                  </p>
                ) : null}
              </label>

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
                  disabled={submitting || !selectedUser}
                  className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white shadow-lg shadow-primary/20 disabled:opacity-50"
                >
                  {submitting ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                      Upgrading…
                    </>
                  ) : (
                    "Upgrade member"
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
