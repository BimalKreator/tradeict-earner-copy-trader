"use client";

import {
  Check,
  Inbox,
  Loader2,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { resolveApiBase } from "@/lib/apiBase";
import { SALES_TEAM_ROLE_LABELS, type SalesTeamRole } from "@/lib/roles";

type ReferralStatus = "PENDING" | "APPROVED" | "REJECTED";

type ReferralRequestRow = {
  id: string;
  referredEmail: string;
  status: ReferralStatus;
  createdAt: string;
  updatedAt: string;
  sponsor: {
    id: string;
    name: string | null;
    email: string;
    role: string;
    referralCode: string | null;
  };
  referredUser: {
    id: string;
    name: string | null;
    email: string;
    acquiredById: string | null;
  } | null;
};

type StatusFilter = "ALL" | ReferralStatus;

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

function statusBadgeClass(status: ReferralStatus): string {
  if (status === "APPROVED") {
    return "bg-emerald-500/15 text-emerald-200 ring-emerald-500/30";
  }
  if (status === "REJECTED") {
    return "bg-red-500/15 text-red-200 ring-red-500/30";
  }
  return "bg-amber-500/15 text-amber-200 ring-amber-500/30";
}

function authHeaders(token: string | null): HeadersInit {
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export default function AdminReferralRequestsPage() {
  const apiBase = useMemo(() => resolveApiBase(), []);
  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;

  const [requests, setRequests] = useState<ReferralRequestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const [actionId, setActionId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) {
      setError("Not signed in");
      return;
    }
    const qs =
      statusFilter !== "ALL" ? `?status=${encodeURIComponent(statusFilter)}` : "";
    const res = await fetch(`${apiBase}/admin/referral-requests${qs}`, {
      headers: authHeaders(token),
    });
    if (!res.ok) {
      const body: unknown = await res.json().catch(() => ({}));
      const msg =
        typeof body === "object" &&
        body !== null &&
        "error" in body &&
        typeof (body as { error?: unknown }).error === "string"
          ? (body as { error: string }).error
          : `Failed to load referral requests (${res.status})`;
      throw new Error(msg);
    }
    const data = (await res.json()) as { requests: ReferralRequestRow[] };
    setRequests(data.requests ?? []);
  }, [apiBase, statusFilter, token]);

  useEffect(() => {
    void (async () => {
      try {
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load requests");
      } finally {
        setLoading(false);
      }
    })();
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 3500);
    return () => window.clearTimeout(t);
  }, [toast]);

  async function handleRefresh() {
    setRefreshing(true);
    setError(null);
    try {
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Refresh failed");
    } finally {
      setRefreshing(false);
    }
  }

  async function patchStatus(id: string, status: "APPROVED" | "REJECTED") {
    if (!token || actionId) return;
    setActionId(id);
    setError(null);
    try {
      const res = await fetch(
        `${apiBase}/admin/referral-requests/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          headers: authHeaders(token),
          body: JSON.stringify({ status }),
        },
      );
      const body: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg =
          typeof body === "object" &&
          body !== null &&
          "error" in body &&
          typeof (body as { error?: unknown }).error === "string"
            ? (body as { error: string }).error
            : `Request failed (${res.status})`;
        throw new Error(msg);
      }

      const tierMsg =
        status === "APPROVED" &&
        typeof body === "object" &&
        body !== null &&
        "tierEvaluation" in body &&
        typeof (body as { tierEvaluation?: { upgraded?: boolean; message?: string } })
          .tierEvaluation === "object" &&
        (body as { tierEvaluation: { upgraded?: boolean; message?: string } })
          .tierEvaluation?.upgraded
          ? ` Sponsor tier upgraded.`
          : "";

      setToast(
        status === "APPROVED"
          ? `Referral approved.${tierMsg}`
          : "Referral rejected.",
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setActionId(null);
    }
  }

  const pendingCount = requests.filter((r) => r.status === "PENDING").length;

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-4">
          <div className="rounded-xl border border-primary/30 bg-primary/10 p-3">
            <Inbox className="h-7 w-7 text-primary" aria-hidden />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">
              Referral Requests
            </h1>
            <p className="mt-1 text-sm text-white/50">
              Partner-submitted email referrals awaiting admin review
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void handleRefresh()}
          disabled={loading || refreshing}
          className="inline-flex items-center gap-2 self-start rounded-xl border border-glassBorder bg-white/[0.04] px-4 py-2.5 text-sm font-medium text-white/80 transition hover:bg-white/[0.08] disabled:opacity-50"
        >
          <RefreshCw
            className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`}
            aria-hidden
          />
          Refresh
        </button>
      </header>

      {toast ? (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">
          {toast}
        </div>
      ) : null}

      {error ? (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <label className="text-xs font-medium uppercase tracking-wider text-white/45">
          Filter
        </label>
        {(["ALL", "PENDING", "APPROVED", "REJECTED"] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => {
              setLoading(true);
              setStatusFilter(value);
            }}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
              statusFilter === value
                ? "bg-primary/15 text-primary ring-1 ring-primary/40"
                : "border border-white/10 text-white/60 hover:bg-white/5 hover:text-white"
            }`}
          >
            {value === "ALL" ? "All" : value.charAt(0) + value.slice(1).toLowerCase()}
          </button>
        ))}
        <span className="ml-auto text-xs text-white/40">
          {statusFilter === "ALL" ? `${pendingCount} pending in view` : null}
        </span>
      </div>

      <div className="glass-card overflow-hidden border border-glassBorder">
        {loading ? (
          <div className="flex justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-primary" aria-label="Loading" />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead>
                <tr className="border-b border-white/[0.08] bg-white/[0.02] text-xs uppercase tracking-wider text-white/45">
                  <th className="px-4 py-3 font-medium">Date</th>
                  <th className="px-4 py-3 font-medium">Sponsor</th>
                  <th className="px-4 py-3 font-medium">Referred Email</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {requests.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-12 text-center text-white/45">
                      No referral requests found.
                    </td>
                  </tr>
                ) : (
                  requests.map((r) => (
                    <tr
                      key={r.id}
                      className="border-b border-white/[0.06] hover:bg-white/[0.02]"
                    >
                      <td className="whitespace-nowrap px-4 py-3 text-white/60">
                        {fmtDate(r.createdAt)}
                      </td>
                      <td className="px-4 py-3">
                        <p className="font-medium text-white">
                          {r.sponsor.name?.trim() || r.sponsor.email}
                        </p>
                        <p className="text-xs text-white/40">{r.sponsor.email}</p>
                        <p className="mt-0.5 font-mono text-[10px] text-white/30">
                          {r.sponsor.id.slice(0, 8)}…
                        </p>
                        <p className="text-xs text-white/45">
                          {SALES_TEAM_ROLE_LABELS[r.sponsor.role as SalesTeamRole] ??
                            r.sponsor.role}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <p className="text-white/85">{r.referredEmail}</p>
                        {r.referredUser ? (
                          <p className="text-xs text-emerald-300/80">
                            Registered · {r.referredUser.name?.trim() || "User"}
                          </p>
                        ) : (
                          <p className="text-xs text-amber-300/80">Not registered yet</p>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ${statusBadgeClass(r.status)}`}
                        >
                          {r.status}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {r.status === "PENDING" ? (
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              disabled={actionId === r.id}
                              onClick={() => void patchStatus(r.id, "APPROVED")}
                              className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/35 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-200 hover:bg-emerald-500/15 disabled:opacity-50"
                            >
                              {actionId === r.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                              ) : (
                                <Check className="h-3.5 w-3.5" aria-hidden />
                              )}
                              Approve
                            </button>
                            <button
                              type="button"
                              disabled={actionId === r.id}
                              onClick={() => void patchStatus(r.id, "REJECTED")}
                              className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/35 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-200 hover:bg-red-500/15 disabled:opacity-50"
                            >
                              <XCircle className="h-3.5 w-3.5" aria-hidden />
                              Reject
                            </button>
                          </div>
                        ) : (
                          <span className="text-xs text-white/35">—</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
