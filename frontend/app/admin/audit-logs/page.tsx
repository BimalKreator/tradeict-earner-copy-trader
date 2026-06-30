"use client";

import { AuditLogDetailsModal } from "@/components/admin/AuditLogDetailsModal";
import { useAdminSession } from "@/context/AdminSessionContext";
import { resolveApiBase } from "@/lib/apiBase";
import { Eye, FileSearch, Loader2, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

const AUDIT_ACTIONS = [
  "CREATE_ADMIN",
  "DELETE_USER",
  "PROCESS_WITHDRAWAL",
  "UPDATE_BALANCE_DISPLAY_OFFSET",
  "UPDATE_DEPOSIT",
  "UPDATE_USER",
  "UPDATE_USER_PROFILE",
  "UPDATE_WALLET",
] as const;

type AuditLogRow = {
  id: string;
  adminId: string;
  action: string;
  resource: string;
  resourceId: string | null;
  details: unknown;
  ipAddress: string | null;
  createdAt: string;
  admin: {
    id: string;
    name: string | null;
    email: string;
    adminRole: string | null;
  };
};

type Pagination = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
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
    second: "2-digit",
  });
}

export default function AdminAuditLogsPage() {
  const router = useRouter();
  const apiBase = useMemo(() => resolveApiBase(), []);
  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;

  const { loading: sessionLoading, canViewAuditLogs } = useAdminSession();

  const [items, setItems] = useState<AuditLogRow[]>([]);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    pageSize: 25,
    total: 0,
    totalPages: 1,
  });

  const [adminEmailFilter, setAdminEmailFilter] = useState("");
  const [actionFilter, setActionFilter] = useState("");
  const [appliedAdminEmail, setAppliedAdminEmail] = useState("");
  const [appliedAction, setAppliedAction] = useState("");

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsTitle, setDetailsTitle] = useState("");
  const [detailsPayload, setDetailsPayload] = useState<unknown>(null);

  const load = useCallback(
    async (
      page: number,
      filters?: { adminEmail?: string; action?: string },
    ) => {
      if (!token) throw new Error("Not signed in");

      const adminEmail = filters?.adminEmail ?? appliedAdminEmail;
      const action = filters?.action ?? appliedAction;

      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pagination.pageSize),
      });
      if (adminEmail.trim()) {
        params.set("adminEmail", adminEmail.trim());
      }
      if (action.trim()) {
        params.set("action", action.trim());
      }

      const res = await fetch(`${apiBase}/admin/audit-logs?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });

      if (res.status === 403) {
        throw new Error("You do not have permission to view audit logs.");
      }
      if (!res.ok) {
        throw new Error(`Failed to load audit logs (${res.status})`);
      }

      const data = (await res.json()) as {
        items?: AuditLogRow[];
        pagination?: Pagination;
      };
      setItems(Array.isArray(data.items) ? data.items : []);
      if (data.pagination) {
        setPagination(data.pagination);
      }
    },
    [apiBase, appliedAction, appliedAdminEmail, pagination.pageSize, token],
  );

  useEffect(() => {
    if (sessionLoading) return;
    if (!canViewAuditLogs) {
      router.replace("/admin");
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    void load(1)
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load audit logs");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [canViewAuditLogs, load, router, sessionLoading]);

  async function handleRefresh() {
    setRefreshing(true);
    setError(null);
    try {
      await load(pagination.page);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to refresh");
    } finally {
      setRefreshing(false);
    }
  }

  function applyFilters(e: React.FormEvent) {
    e.preventDefault();
    setAppliedAdminEmail(adminEmailFilter);
    setAppliedAction(actionFilter);
    setLoading(true);
    setError(null);
    void load(1, {
      adminEmail: adminEmailFilter,
      action: actionFilter,
    })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to apply filters");
      })
      .finally(() => setLoading(false));
  }

  function clearFilters() {
    setAdminEmailFilter("");
    setActionFilter("");
    setAppliedAdminEmail("");
    setAppliedAction("");
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const params = new URLSearchParams({
          page: "1",
          pageSize: String(pagination.pageSize),
        });
        const res = await fetch(`${apiBase}/admin/audit-logs?${params}`, {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`Failed to load audit logs (${res.status})`);
        const data = (await res.json()) as {
          items?: AuditLogRow[];
          pagination?: Pagination;
        };
        setItems(Array.isArray(data.items) ? data.items : []);
        if (data.pagination) setPagination(data.pagination);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to clear filters");
      } finally {
        setLoading(false);
      }
    })();
  }

  function openDetails(row: AuditLogRow) {
    const adminLabel = row.admin.name?.trim() || row.admin.email;
    setDetailsTitle(`${row.action} · ${adminLabel}`);
    setDetailsPayload(row.details);
    setDetailsOpen(true);
  }

  function goToPage(nextPage: number) {
    if (nextPage < 1 || nextPage > pagination.totalPages) return;
    setLoading(true);
    setError(null);
    void load(nextPage)
      .catch((e) => {
        setError(e instanceof Error ? e.message : "Failed to change page");
      })
      .finally(() => setLoading(false));
  }

  if (sessionLoading || (!canViewAuditLogs && !error)) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" aria-hidden />
      </div>
    );
  }

  if (!canViewAuditLogs) {
    return null;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-white">
            <FileSearch className="h-7 w-7 text-primary" aria-hidden />
            Audit logs
          </h1>
          <p className="mt-1 text-sm text-white/55">
            Review admin actions across the platform with full change details.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void handleRefresh()}
          disabled={loading || refreshing}
          className="inline-flex items-center gap-2 self-start rounded-lg border border-glassBorder bg-white/[0.04] px-3 py-2 text-sm font-medium text-white/80 hover:bg-white/10 disabled:opacity-50"
        >
          <RefreshCw
            className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`}
            aria-hidden
          />
          Refresh
        </button>
      </div>

      <form
        onSubmit={applyFilters}
        className="glass-card rounded-xl border border-glassBorder p-4"
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="sm:col-span-2 lg:col-span-2">
            <label
              htmlFor="audit-admin-filter"
              className="block text-xs font-medium uppercase tracking-wider text-white/45"
            >
              Admin name / email
            </label>
            <input
              id="audit-admin-filter"
              type="text"
              value={adminEmailFilter}
              onChange={(e) => setAdminEmailFilter(e.target.value)}
              placeholder="Search by name or email"
              className="mt-2 w-full rounded-lg border border-glassBorder bg-white/[0.04] px-3 py-2.5 text-sm text-white placeholder:text-white/30 focus:border-primary/50 focus:outline-none"
            />
          </div>
          <div>
            <label
              htmlFor="audit-action-filter"
              className="block text-xs font-medium uppercase tracking-wider text-white/45"
            >
              Action
            </label>
            <select
              id="audit-action-filter"
              value={actionFilter}
              onChange={(e) => setActionFilter(e.target.value)}
              className="mt-2 w-full rounded-lg border border-glassBorder bg-white/[0.04] px-3 py-2.5 text-sm text-white focus:border-primary/50 focus:outline-none"
            >
              <option value="" className="bg-slate-900">
                All actions
              </option>
              {AUDIT_ACTIONS.map((action) => (
                <option key={action} value={action} className="bg-slate-900">
                  {action.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-end gap-2">
            <button
              type="submit"
              disabled={loading}
              className="flex-1 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-white hover:bg-primary/90 disabled:opacity-50"
            >
              Apply filters
            </button>
            <button
              type="button"
              onClick={clearFilters}
              disabled={loading}
              className="rounded-lg border border-glassBorder px-3 py-2.5 text-sm text-white/70 hover:bg-white/5 disabled:opacity-50"
            >
              Clear
            </button>
          </div>
        </div>
      </form>

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
                <th className="px-4 py-3 font-semibold">Date / time</th>
                <th className="px-4 py-3 font-semibold">Admin</th>
                <th className="px-4 py-3 font-semibold">Action</th>
                <th className="px-4 py-3 font-semibold">Resource</th>
                <th className="px-4 py-3 font-semibold">Resource ID</th>
                <th className="px-4 py-3 font-semibold text-right">Details</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-white/50">
                    <Loader2
                      className="mx-auto h-6 w-6 animate-spin text-primary"
                      aria-hidden
                    />
                  </td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-white/50">
                    No audit log entries match your filters.
                  </td>
                </tr>
              ) : (
                items.map((row) => (
                  <tr
                    key={row.id}
                    className="border-b border-white/[0.05] hover:bg-white/[0.02]"
                  >
                    <td className="whitespace-nowrap px-4 py-3 text-white/75">
                      {fmtDate(row.createdAt)}
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-medium text-white">
                        {row.admin.name?.trim() || "—"}
                      </p>
                      <p className="text-xs text-white/50">{row.admin.email}</p>
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex rounded-full bg-primary/15 px-2.5 py-0.5 text-xs font-medium text-primary ring-1 ring-primary/30">
                        {row.action.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-white/75">{row.resource}</td>
                    <td className="max-w-[12rem] truncate px-4 py-3 font-mono text-xs text-white/60">
                      {row.resourceId ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => openDetails(row)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-glassBorder px-2.5 py-1.5 text-xs font-medium text-white/80 hover:bg-white/5"
                      >
                        <Eye className="h-3.5 w-3.5" aria-hidden />
                        View details
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="flex flex-col gap-3 border-t border-white/[0.08] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-white/50">
            Showing page {pagination.page} of {pagination.totalPages} ·{" "}
            {pagination.total} total entries
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => goToPage(pagination.page - 1)}
              disabled={loading || pagination.page <= 1}
              className="rounded-lg border border-glassBorder px-3 py-1.5 text-xs text-white/70 hover:bg-white/5 disabled:opacity-40"
            >
              Previous
            </button>
            <button
              type="button"
              onClick={() => goToPage(pagination.page + 1)}
              disabled={loading || pagination.page >= pagination.totalPages}
              className="rounded-lg border border-glassBorder px-3 py-1.5 text-xs text-white/70 hover:bg-white/5 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      </div>

      <AuditLogDetailsModal
        open={detailsOpen}
        title={detailsTitle}
        details={detailsPayload}
        onClose={() => setDetailsOpen(false)}
      />
    </div>
  );
}
