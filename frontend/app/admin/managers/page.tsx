"use client";

import { CreateAdminModal } from "@/components/admin/CreateAdminModal";
import { useAdminSession } from "@/context/AdminSessionContext";
import type { PlatformAdminRole } from "@/context/AdminSessionContext";
import { resolveApiBase } from "@/lib/apiBase";
import { Loader2, Plus, RefreshCw, Shield, UserCog } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

type AdminAccount = {
  id: string;
  email: string;
  name: string | null;
  adminRole: PlatformAdminRole;
  status: string;
  createdAt: string;
};

function fmtDate(iso: string): string {
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

function roleBadgeClass(role: PlatformAdminRole): string {
  switch (role) {
    case "SUPER_ADMIN":
      return "bg-violet-500/15 text-violet-200 ring-1 ring-violet-500/35";
    case "MANAGER":
      return "bg-sky-500/15 text-sky-200 ring-1 ring-sky-500/35";
    case "SUPPORT":
      return "bg-amber-500/15 text-amber-200 ring-1 ring-amber-500/35";
    default:
      return "bg-white/10 text-white/70 ring-1 ring-white/15";
  }
}

function statusBadgeClass(status: string): string {
  switch (status.toUpperCase()) {
    case "ACTIVE":
      return "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30";
    case "SUSPENDED":
    case "INACTIVE":
      return "bg-red-500/15 text-red-300 ring-1 ring-red-500/30";
    default:
      return "bg-white/10 text-white/70 ring-1 ring-white/15";
  }
}

export default function AdminManagersPage() {
  const router = useRouter();
  const apiBase = useMemo(() => resolveApiBase(), []);
  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;

  const { loading: sessionLoading, isSuperAdmin } = useAdminSession();

  const [admins, setAdmins] = useState<AdminAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const load = useCallback(async () => {
    if (!token) throw new Error("Not signed in");

    const res = await fetch(`${apiBase}/admin/managers`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });

    if (res.status === 403) {
      throw new Error("You do not have permission to view admin accounts.");
    }
    if (!res.ok) {
      throw new Error(`Failed to load admins (${res.status})`);
    }

    const data = (await res.json()) as { admins?: AdminAccount[] };
    setAdmins(Array.isArray(data.admins) ? data.admins : []);
  }, [apiBase, token]);

  useEffect(() => {
    if (sessionLoading) return;
    if (!isSuperAdmin) {
      router.replace("/admin");
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    void load()
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load admins");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isSuperAdmin, load, router, sessionLoading]);

  async function handleRefresh() {
    setRefreshing(true);
    setError(null);
    try {
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to refresh");
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(t);
  }, [toast]);

  if (sessionLoading || (!isSuperAdmin && !error)) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" aria-hidden />
      </div>
    );
  }

  if (!isSuperAdmin) {
    return null;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-white">
            <Shield className="h-7 w-7 text-primary" aria-hidden />
            Admin managers
          </h1>
          <p className="mt-1 text-sm text-white/55">
            Create and review platform admin accounts and their roles.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void handleRefresh()}
            disabled={loading || refreshing}
            className="inline-flex items-center gap-2 rounded-lg border border-glassBorder bg-white/[0.04] px-3 py-2 text-sm font-medium text-white/80 hover:bg-white/10 disabled:opacity-50"
          >
            <RefreshCw
              className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`}
              aria-hidden
            />
            Refresh
          </button>
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" aria-hidden />
            Create admin
          </button>
        </div>
      </div>

      {toast ? (
        <div
          className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200"
          role="status"
        >
          {toast}
        </div>
      ) : null}

      {error ? (
        <div
          className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200"
          role="alert"
        >
          {error}
        </div>
      ) : null}

      <div className="glass-card overflow-hidden rounded-xl border border-glassBorder">
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead>
              <tr className="border-b border-white/[0.08] bg-white/[0.03] text-xs uppercase tracking-wider text-white/45">
                <th className="px-4 py-3 font-semibold">Admin</th>
                <th className="px-4 py-3 font-semibold">Role</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 font-semibold">Created</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={4} className="px-4 py-12 text-center text-white/50">
                    <Loader2
                      className="mx-auto h-6 w-6 animate-spin text-primary"
                      aria-hidden
                    />
                  </td>
                </tr>
              ) : admins.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-12 text-center text-white/50">
                    No admin accounts found.
                  </td>
                </tr>
              ) : (
                admins.map((admin) => (
                  <tr
                    key={admin.id}
                    className="border-b border-white/[0.05] hover:bg-white/[0.02]"
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <UserCog className="h-4 w-4 shrink-0 text-white/40" aria-hidden />
                        <div>
                          <p className="font-medium text-white">
                            {admin.name?.trim() || "—"}
                          </p>
                          <p className="text-xs text-white/50">{admin.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${roleBadgeClass(admin.adminRole)}`}
                      >
                        {admin.adminRole.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${statusBadgeClass(admin.status)}`}
                      >
                        {admin.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-white/70">
                      {fmtDate(admin.createdAt)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <CreateAdminModal
        open={createOpen}
        apiBase={apiBase}
        token={token}
        onClose={() => setCreateOpen(false)}
        onSuccess={() => {
          setToast("Admin account created.");
          void handleRefresh();
        }}
        onError={(msg) => setError(msg)}
      />
    </div>
  );
}
