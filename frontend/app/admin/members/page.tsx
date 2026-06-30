"use client";

import {
  Check,
  ClipboardList,
  Loader2,
  Mail,
  RefreshCw,
  UserCog,
  UserPlus,
  Users,
  UsersRound,
  X,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AdminProfileEditModal } from "@/components/admin/AdminProfileEditModal";
import { useAdminEmailActions } from "@/components/admin/AdminEmailOptions";
import { EmailManagerModal } from "@/components/admin/EmailManagerModal";
import { useAdminProfileEdit } from "@/components/admin/useAdminProfileEdit";

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

type SalesRole = "EXECUTIVE" | "MANAGER" | "SENIOR_MANAGER";

type NominatedRole = "EXECUTIVE" | "MANAGER";

type UpgradeRequestRow = {
  id: string;
  targetUserEmail: string;
  requestedRole: NominatedRole;
  status: string;
  createdAt: string;
  requester: {
    id: string;
    name: string | null;
    email: string;
    role: string;
  };
  assignedParent: {
    id: string;
    name: string | null;
    email: string;
    role: string;
  };
  targetUser: {
    id: string;
    name: string | null;
    email: string;
    role: string;
  } | null;
};

const ROLE_LABELS: Record<SalesRole, string> = {
  EXECUTIVE: "Team Executive",
  MANAGER: "Team Manager",
  SENIOR_MANAGER: "Senior Manager",
};

const NOMINATED_ROLE_LABELS: Record<NominatedRole, string> = {
  EXECUTIVE: "Team Executive",
  MANAGER: "Team Manager",
};

function fmtRequestDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const usdFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

function roleBadgeClass(role: string): string {
  if (role === "SENIOR_MANAGER") return "bg-violet-500/15 text-violet-200 ring-violet-500/30";
  if (role === "MANAGER") return "bg-sky-500/15 text-sky-200 ring-sky-500/30";
  if (role === "EXECUTIVE") return "bg-emerald-500/15 text-emerald-200 ring-emerald-500/30";
  return "bg-white/10 text-white/70 ring-white/20";
}

function getDescendantIds(members: TeamMember[], rootId: string): Set<string> {
  const byParent = new Map<string, string[]>();
  for (const m of members) {
    if (m.parentId) {
      const list = byParent.get(m.parentId) ?? [];
      list.push(m.id);
      byParent.set(m.parentId, list);
    }
  }
  const out = new Set<string>();
  const stack = [...(byParent.get(rootId) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    stack.push(...(byParent.get(id) ?? []));
  }
  return out;
}

function eligibleUplineOptions(
  members: TeamMember[],
  member: TeamMember,
): TeamMember[] {
  const role = member.role as SalesRole;
  const descendants = getDescendantIds(members, member.id);
  let base: TeamMember[];
  if (role === "SENIOR_MANAGER") {
    base = members.filter((m) => m.role === "SENIOR_MANAGER");
  } else if (role === "MANAGER") {
    base = members.filter((m) => m.role === "SENIOR_MANAGER");
  } else {
    base = members.filter(
      (m) => m.role === "MANAGER" || m.role === "SENIOR_MANAGER",
    );
  }
  return base.filter((m) => m.id !== member.id && !descendants.has(m.id));
}

function uplineRequiredForRole(role: string): boolean {
  return role !== "SENIOR_MANAGER";
}

export default function AdminMembersPage() {
  const apiBase = useMemo(() => resolveAdminApiBase(), []);

  const [activeTab, setActiveTab] = useState<"members" | "nominations">("members");
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [upgradeRequests, setUpgradeRequests] = useState<UpgradeRequestRow[]>([]);
  const [requestsLoading, setRequestsLoading] = useState(false);
  const [actionRequestId, setActionRequestId] = useState<string | null>(null);
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

  const [uplineModalMember, setUplineModalMember] = useState<TeamMember | null>(
    null,
  );
  const [uplineParentId, setUplineParentId] = useState("");
  const [uplineSubmitting, setUplineSubmitting] = useState(false);
  const [uplineFormError, setUplineFormError] = useState<string | null>(null);

  const {
    emailManagerUser,
    isEmailManagerOpen,
    openEmailManager,
    closeEmailManager,
  } = useAdminEmailActions({ onToast: setToast });

  const {
    profileEditUser,
    isProfileEditOpen,
    openProfileEdit,
    closeProfileEdit,
  } = useAdminProfileEdit();

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

  const loadUpgradeRequests = useCallback(async () => {
    setRequestsLoading(true);
    try {
      const res = await fetch(`${apiBase}/admin/upgrade-requests`, {
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error(`Failed to load requests (${res.status})`);
      const data = (await res.json()) as { requests?: UpgradeRequestRow[] };
      setUpgradeRequests(data.requests ?? []);
    } catch (e) {
      setToast({
        type: "err",
        text: e instanceof Error ? e.message : "Could not load nomination requests",
      });
      setUpgradeRequests([]);
    } finally {
      setRequestsLoading(false);
    }
  }, [apiBase]);

  useEffect(() => {
    void loadMembers();
    void loadUpgradeRequests();
  }, [loadMembers, loadUpgradeRequests]);

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
    if (newRole === "SENIOR_MANAGER") {
      return members.filter((m) => m.role === "SENIOR_MANAGER");
    }
    if (newRole === "MANAGER") {
      return members.filter((m) => m.role === "SENIOR_MANAGER");
    }
    return members.filter(
      (m) => m.role === "MANAGER" || m.role === "SENIOR_MANAGER",
    );
  }, [members, newRole]);

  const parentRequired = newRole !== "SENIOR_MANAGER";

  const uplineEditOptions = useMemo(() => {
    if (!uplineModalMember) return [];
    return eligibleUplineOptions(members, uplineModalMember);
  }, [members, uplineModalMember]);

  const uplineEditRequired = uplineModalMember
    ? uplineRequiredForRole(uplineModalMember.role)
    : true;

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

  function openUplineModal(member: TeamMember) {
    setUplineModalMember(member);
    setUplineParentId(member.parentId ?? "");
    setUplineFormError(null);
  }

  function closeUplineModal() {
    setUplineModalMember(null);
    setUplineParentId("");
    setUplineFormError(null);
  }

  async function handleChangeUpline(e: React.FormEvent) {
    e.preventDefault();
    if (!uplineModalMember) return;
    if (uplineEditRequired && !uplineParentId) {
      setUplineFormError("Select an upline (parent) for this role.");
      return;
    }

    setUplineSubmitting(true);
    setUplineFormError(null);
    try {
      const res = await fetch(
        `${apiBase}/admin/members/${encodeURIComponent(uplineModalMember.id)}/upline`,
        {
          method: "PATCH",
          headers: authHeaders(),
          body: JSON.stringify({
            parentId: uplineParentId || null,
          }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        throw new Error(body.error ?? "Failed to update upline");
      }
      const label =
        uplineModalMember.name?.trim() || uplineModalMember.email;
      closeUplineModal();
      setToast({
        type: "ok",
        text: `Upline updated for ${label}.`,
      });
      await loadMembers();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to update upline";
      setUplineFormError(msg);
      setToast({ type: "err", text: msg });
    } finally {
      setUplineSubmitting(false);
    }
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
        throw new Error(body.error ?? "Upgrade failed.");
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

  async function handleApproveRequest(id: string) {
    setActionRequestId(id);
    try {
      const res = await fetch(`${apiBase}/admin/upgrade-requests/${encodeURIComponent(id)}/approve`, {
        method: "POST",
        headers: authHeaders(),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        throw new Error(body.error ?? "Approval failed");
      }
      setToast({ type: "ok", text: "Nomination approved and user upgraded." });
      await Promise.all([loadUpgradeRequests(), loadMembers()]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Approval failed";
      setToast({ type: "err", text: msg });
    } finally {
      setActionRequestId(null);
    }
  }

  async function handleRejectRequest(id: string) {
    setActionRequestId(id);
    try {
      const res = await fetch(`${apiBase}/admin/upgrade-requests/${encodeURIComponent(id)}/reject`, {
        method: "POST",
        headers: authHeaders(),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        throw new Error(body.error ?? "Reject failed");
      }
      setToast({ type: "ok", text: "Nomination rejected." });
      await loadUpgradeRequests();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Reject failed";
      setToast({ type: "err", text: msg });
    } finally {
      setActionRequestId(null);
    }
  }

  return (
    <div className="mx-auto w-full min-w-0 max-w-6xl space-y-6">
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

      <div className="flex gap-1 rounded-xl border border-glassBorder bg-white/[0.03] p-1">
        <button
          type="button"
          onClick={() => setActiveTab("members")}
          className={`inline-flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition sm:flex-none ${
            activeTab === "members"
              ? "bg-primary/20 text-primary"
              : "text-white/55 hover:bg-white/[0.06] hover:text-white/80"
          }`}
        >
          <UsersRound className="h-4 w-4" aria-hidden />
          Team members
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("nominations")}
          className={`inline-flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition sm:flex-none ${
            activeTab === "nominations"
              ? "bg-primary/20 text-primary"
              : "text-white/55 hover:bg-white/[0.06] hover:text-white/80"
          }`}
        >
          <ClipboardList className="h-4 w-4" aria-hidden />
          Nomination requests
          {upgradeRequests.length > 0 ? (
            <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-semibold text-amber-200">
              {upgradeRequests.length}
            </span>
          ) : null}
        </button>
      </div>

      {activeTab === "members" ? (
      <div className="glass-card border border-glassBorder">
        <div className="flex items-center gap-2 border-b border-glassBorder bg-white/[0.03] px-4 py-3">
          <UsersRound className="h-4 w-4 text-primary" aria-hidden />
          <span className="text-sm font-medium text-white/80">Team members</span>
          <span className="ml-auto text-xs text-white/40">
            {members.length} member{members.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className="scroll-table overflow-x-auto">
          <table className="w-full min-w-[1100px] text-left text-sm">
            <thead className="border-b border-glassBorder bg-white/[0.02]">
              <tr>
                <th className="px-4 py-3 font-medium text-white/70">Name</th>
                <th className="px-4 py-3 font-medium text-white/70">Email</th>
                <th className="px-4 py-3 font-medium text-white/70">Role</th>
                <th className="px-4 py-3 font-medium text-white/70">Upline</th>
                <th className="px-4 py-3 font-medium text-white/70">Direct acquired</th>
                <th className="px-4 py-3 font-medium text-white/70">Network AUM</th>
                <th className="px-4 py-3 font-medium text-white/70">Referral code</th>
                <th className="px-4 py-3 font-medium text-white/70">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-white/45">
                    <Loader2 className="mx-auto h-6 w-6 animate-spin" aria-hidden />
                    <span className="mt-2 block">Loading team members…</span>
                  </td>
                </tr>
              ) : members.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-white/45">
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
                    <td className="px-4 py-3">
                      <div className="flex flex-row items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => openUplineModal(m)}
                          title="Change Upline"
                          aria-label="Change Upline"
                          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/15 bg-white/5 text-white/75 transition hover:bg-white/10 hover:text-white"
                        >
                          <Users className="h-4 w-4" aria-hidden />
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            openProfileEdit({
                              id: m.id,
                              email: m.email,
                              name: m.name,
                            });
                          }}
                          title="View/Edit Profile"
                          aria-label="View/Edit Profile"
                          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-violet-500/35 bg-violet-500/10 text-violet-100 transition hover:bg-violet-500/20"
                        >
                          <UserCog className="h-4 w-4" aria-hidden />
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            openEmailManager({
                              id: m.id,
                              email: m.email,
                              name: m.name,
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
      ) : (
      <div className="glass-card border border-glassBorder overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-glassBorder bg-white/[0.03] px-4 py-3">
          <ClipboardList className="h-4 w-4 text-primary" aria-hidden />
          <span className="text-sm font-medium text-white/80">Pending nominations</span>
          <button
            type="button"
            onClick={() => void loadUpgradeRequests()}
            disabled={requestsLoading}
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1.5 text-xs text-white/70 hover:bg-white/10 disabled:opacity-50"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${requestsLoading ? "animate-spin" : ""}`}
              aria-hidden
            />
            Refresh
          </button>
        </div>
        <div className="scroll-table overflow-x-auto">
          <table className="w-full min-w-[960px] text-left text-sm">
            <thead className="border-b border-glassBorder bg-white/[0.02]">
              <tr>
                <th className="px-4 py-3 font-medium text-white/70">Date</th>
                <th className="px-4 py-3 font-medium text-white/70">Requester</th>
                <th className="px-4 py-3 font-medium text-white/70">Target email</th>
                <th className="px-4 py-3 font-medium text-white/70">Requested role</th>
                <th className="px-4 py-3 font-medium text-white/70">Upline</th>
                <th className="px-4 py-3 font-medium text-white/70">Actions</th>
              </tr>
            </thead>
            <tbody>
              {requestsLoading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-white/45">
                    <Loader2 className="mx-auto h-6 w-6 animate-spin" aria-hidden />
                    <span className="mt-2 block">Loading nominations…</span>
                  </td>
                </tr>
              ) : upgradeRequests.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-white/45">
                    No pending nomination requests.
                  </td>
                </tr>
              ) : (
                upgradeRequests.map((r) => (
                  <tr
                    key={r.id}
                    className="border-b border-white/[0.06] hover:bg-white/[0.02]"
                  >
                    <td className="whitespace-nowrap px-4 py-3 text-white/60">
                      {fmtRequestDate(r.createdAt)}
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-medium text-white">
                        {r.requester.name?.trim() || r.requester.email}
                      </p>
                      <p className="text-xs text-white/40">
                        {ROLE_LABELS[r.requester.role as SalesRole] ?? r.requester.role}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-white/85">{r.targetUserEmail}</p>
                      {r.targetUser ? (
                        <p className="text-xs text-white/40">
                          {r.targetUser.name?.trim() || "Registered user"}
                        </p>
                      ) : (
                        <p className="text-xs text-amber-300/80">User not found</p>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ${roleBadgeClass(r.requestedRole)}`}
                      >
                        {NOMINATED_ROLE_LABELS[r.requestedRole]}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-white/80">
                        {r.assignedParent.name?.trim() || r.assignedParent.email}
                      </p>
                      <p className="text-xs text-white/40">
                        {ROLE_LABELS[r.assignedParent.role as SalesRole] ??
                          r.assignedParent.role}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={actionRequestId === r.id}
                          onClick={() => void handleApproveRequest(r.id)}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/35 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-200 hover:bg-emerald-500/15 disabled:opacity-50"
                        >
                          {actionRequestId === r.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                          ) : (
                            <Check className="h-3.5 w-3.5" aria-hidden />
                          )}
                          Approve
                        </button>
                        <button
                          type="button"
                          disabled={actionRequestId === r.id}
                          onClick={() => void handleRejectRequest(r.id)}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/35 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-200 hover:bg-red-500/15 disabled:opacity-50"
                        >
                          <XCircle className="h-3.5 w-3.5" aria-hidden />
                          Reject
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
      )}

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
                  Assign a sales role and upline. Strategy subscription is not required.
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
                  <option value="SENIOR_MANAGER">Senior Manager (8%)</option>
                </select>
              </label>

              <label className="block">
                <span className="text-xs font-medium text-white/60">
                  Upline (parent)
                  {!parentRequired ? " — optional for Senior Managers" : " — required"}
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
                      : "No upline (top-level Senior Manager)"}
                  </option>
                  {parentOptions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {(p.name?.trim() || p.email) + ` — ${p.role}`}
                    </option>
                  ))}
                </select>
                {parentRequired && parentOptions.length === 0 ? (
                  <p className="mt-1 text-xs text-amber-200/90">
                    No eligible upline yet. Add a Senior Manager first, or assign a Manager
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

      {uplineModalMember ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="change-upline-title"
        >
          <div className="glass-card max-h-[90vh] w-full max-w-lg overflow-y-auto border border-glassBorder p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2
                  id="change-upline-title"
                  className="text-lg font-semibold text-white"
                >
                  Change upline
                </h2>
                <p className="mt-1 text-sm text-white/50">
                  {uplineModalMember.name?.trim() || uplineModalMember.email}
                  {" · "}
                  {ROLE_LABELS[uplineModalMember.role as SalesRole] ??
                    uplineModalMember.role}
                </p>
              </div>
              <button
                type="button"
                onClick={closeUplineModal}
                className="rounded-lg border border-white/10 p-2 text-white/60 hover:bg-white/10 hover:text-white"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form
              onSubmit={(e) => void handleChangeUpline(e)}
              className="mt-6 space-y-4"
            >
              {uplineFormError ? (
                <p className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                  {uplineFormError}
                </p>
              ) : null}

              <label className="block">
                <span className="text-xs font-medium text-white/60">
                  Upline (parent)
                  {!uplineEditRequired
                    ? " — optional for Senior Managers"
                    : " — required"}
                </span>
                <select
                  value={uplineParentId}
                  onChange={(e) => setUplineParentId(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-50"
                  disabled={!uplineEditRequired && uplineEditOptions.length === 0}
                >
                  <option value="">
                    {uplineEditRequired
                      ? "Select upline…"
                      : "No upline (top-level Senior Manager)"}
                  </option>
                  {uplineEditOptions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {(p.name?.trim() || p.email) + ` — ${p.role}`}
                    </option>
                  ))}
                </select>
                {uplineEditRequired && uplineEditOptions.length === 0 ? (
                  <p className="mt-1 text-xs text-amber-200/90">
                    No eligible upline available for this role.
                  </p>
                ) : null}
              </label>

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={closeUplineModal}
                  className="rounded-lg px-4 py-2 text-sm font-medium text-white/70 transition hover:bg-white/10"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={uplineSubmitting}
                  className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white shadow-lg shadow-primary/20 disabled:opacity-50"
                >
                  {uplineSubmitting ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                      Saving…
                    </>
                  ) : (
                    "Save upline"
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      <EmailManagerModal
        open={isEmailManagerOpen}
        recipient={emailManagerUser}
        apiBase={apiBase}
        authHeaders={authHeaders}
        onClose={closeEmailManager}
        onToast={setToast}
      />

      <AdminProfileEditModal
        open={isProfileEditOpen}
        userId={profileEditUser?.id ?? null}
        userLabel={profileEditUser?.name ?? profileEditUser?.email}
        apiBase={apiBase}
        authHeaders={authHeaders}
        onClose={closeProfileEdit}
        onToast={setToast}
      />
    </div>
  );
}
