"use client";

import { resolveApiBase } from "@/lib/apiBase";
import {
  Banknote,
  CheckCircle2,
  Loader2,
  RefreshCw,
  UserRound,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { SALES_TEAM_ROLE_LABELS, isSalesTeamMember } from "@/lib/roles";

type PayoutStatus = "PENDING" | "APPROVED" | "COMPLETED" | "REJECTED";

type ActorSummary = {
  id: string;
  name: string | null;
  email: string;
} | null;

type PayoutRow = {
  id: string;
  amount: number;
  status: PayoutStatus;
  requestedAt: string;
  approvedAt: string | null;
  approvedBy: ActorSummary;
  approvalReason: string | null;
  rejectedAt: string | null;
  rejectedBy: ActorSummary;
  rejectionReason: string | null;
  completedAt: string | null;
  completedBy: ActorSummary;
  paymentReference: string | null;
  user: {
    id: string;
    name: string | null;
    email: string;
    mobile: string | null;
    address: string | null;
    panNumber: string | null;
    role: string;
  };
};

const usdFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function fmtUsd(n: number): string {
  return usdFmt.format(n);
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
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

function statusBadgeClass(status: PayoutStatus): string {
  switch (status) {
    case "PENDING":
      return "bg-amber-500/15 text-amber-200 ring-amber-500/35";
    case "APPROVED":
      return "bg-sky-500/15 text-sky-200 ring-sky-500/35";
    case "COMPLETED":
      return "bg-emerald-500/15 text-emerald-200 ring-emerald-500/35";
    case "REJECTED":
      return "bg-red-500/15 text-red-200 ring-red-500/35";
    default:
      return "bg-white/10 text-white/60 ring-white/20";
  }
}

function actorLabel(actor: ActorSummary): string {
  if (!actor) return "—";
  return actor.name?.trim() || actor.email;
}

export default function AdminPayoutsPage() {
  const apiBase = useMemo(() => resolveApiBase(), []);
  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;

  const [payouts, setPayouts] = useState<PayoutRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rowBusy, setRowBusy] = useState<Record<string, boolean>>({});
  const [paymentRefs, setPaymentRefs] = useState<Record<string, string>>({});
  const [rejectReasons, setRejectReasons] = useState<Record<string, string>>({});
  const [confirmEmails, setConfirmEmails] = useState<Record<string, string>>({});
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) {
      setError("Not signed in");
      return;
    }
    const res = await fetch(`${apiBase}/admin/payouts`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body: unknown = await res.json().catch(() => ({}));
      const msg =
        typeof body === "object" &&
        body !== null &&
        "error" in body &&
        typeof (body as { error?: unknown }).error === "string"
          ? (body as { error: string }).error
          : `Failed to load payouts (${res.status})`;
      throw new Error(msg);
    }
    const data = (await res.json()) as { payouts: PayoutRow[] };
    setPayouts(data.payouts ?? []);
  }, [apiBase, token]);

  useEffect(() => {
    void (async () => {
      try {
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load payouts");
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

  async function postAction(
    id: string,
    path: "approve" | "reject" | "complete",
    body: Record<string, string>,
    successMsg: string,
  ) {
    if (!token || rowBusy[id]) return;
    setRowBusy((prev) => ({ ...prev, [id]: true }));
    setError(null);
    try {
      const res = await fetch(`${apiBase}/admin/payouts/${id}/${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const data: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg =
          typeof data === "object" &&
          data !== null &&
          "error" in data &&
          typeof (data as { error?: unknown }).error === "string"
            ? (data as { error: string }).error
            : `Action failed (${res.status})`;
        throw new Error(msg);
      }
      setToast(successMsg);
      setPaymentRefs((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setRejectReasons((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setConfirmEmails((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setRowBusy((prev) => ({ ...prev, [id]: false }));
    }
  }

  const totalPending = payouts.reduce((sum, p) => sum + p.amount, 0);

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-4">
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3">
            <Banknote className="h-7 w-7 text-emerald-300" aria-hidden />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">
              Partner Payouts
            </h1>
            <p className="mt-1 text-sm text-white/50">
              Review, approve, reject, or complete partner commission withdrawals
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

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="glass-card border border-glassBorder p-5">
          <p className="text-xs font-medium uppercase tracking-wider text-white/45">
            Actionable requests
          </p>
          <p className="mt-2 text-3xl font-semibold tabular-nums text-white">
            {payouts.length}
          </p>
        </div>
        <div className="glass-card border border-glassBorder p-5">
          <p className="text-xs font-medium uppercase tracking-wider text-white/45">
            Total in queue
          </p>
          <p className="mt-2 text-3xl font-semibold tabular-nums text-emerald-200">
            {fmtUsd(totalPending)}
          </p>
        </div>
      </div>

      <div className="glass-card overflow-hidden border border-glassBorder">
        {loading ? (
          <div className="flex justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-primary" aria-label="Loading" />
          </div>
        ) : payouts.length === 0 ? (
          <div className="px-6 py-16 text-center text-sm text-white/45">
            No pending or approved payout requests.
          </div>
        ) : (
          <div className="scroll-table w-full overflow-x-auto">
            <table className="w-full min-w-[960px] text-left text-sm">
              <thead className="border-b border-glassBorder bg-white/[0.03] text-xs uppercase tracking-wider text-white/40">
                <tr>
                  <th className="px-5 py-3 font-medium sm:px-6">Partner</th>
                  <th className="px-5 py-3 font-medium sm:px-6">Amount</th>
                  <th className="px-5 py-3 font-medium sm:px-6">Status</th>
                  <th className="px-5 py-3 font-medium sm:px-6">Timeline</th>
                  <th className="px-5 py-3 font-medium sm:px-6">KYC / contact</th>
                  <th className="px-5 py-3 font-medium text-right sm:px-6">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-glassBorder/80">
                {payouts.map((row) => {
                  const roleLabel = isSalesTeamMember(row.user.role)
                    ? SALES_TEAM_ROLE_LABELS[row.user.role]
                    : row.user.role;
                  const rejectReason = (rejectReasons[row.id] ?? "").trim();
                  const paymentRef = (paymentRefs[row.id] ?? "").trim();
                  const confirmEmail = (confirmEmails[row.id] ?? "").trim();
                  const emailMatch = confirmEmail === row.user.email;

                  return (
                    <tr key={row.id} className="align-top hover:bg-white/[0.02]">
                      <td className="px-5 py-4 sm:px-6">
                        <div className="flex items-start gap-2">
                          <UserRound
                            className="mt-0.5 h-4 w-4 shrink-0 text-white/35"
                            aria-hidden
                          />
                          <div>
                            <p className="font-medium text-white">
                              {row.user.name?.trim() || "—"}
                            </p>
                            <p className="mt-0.5 text-xs text-white/45">{row.user.email}</p>
                            <p className="mt-1 text-[11px] text-violet-300/80">{roleLabel}</p>
                          </div>
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-5 py-4 font-semibold tabular-nums text-emerald-200 sm:px-6">
                        {fmtUsd(row.amount)}
                      </td>
                      <td className="px-5 py-4 sm:px-6">
                        <span
                          className={`inline-flex rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ring-1 ${statusBadgeClass(row.status)}`}
                        >
                          {row.status}
                        </span>
                      </td>
                      <td className="max-w-xs px-5 py-4 text-xs leading-relaxed text-white/55 sm:px-6">
                        <p>
                          <span className="text-white/35">Requested:</span>{" "}
                          {fmtDate(row.requestedAt)}
                        </p>
                        {row.approvedAt ? (
                          <p className="mt-1">
                            <span className="text-white/35">Approved:</span>{" "}
                            {fmtDate(row.approvedAt)} by {actorLabel(row.approvedBy)}
                            {row.approvalReason ? (
                              <span className="block text-white/45">
                                Reason: {row.approvalReason}
                              </span>
                            ) : null}
                          </p>
                        ) : null}
                        {row.rejectedAt ? (
                          <p className="mt-1 text-red-200/80">
                            <span className="text-red-300/60">Rejected:</span>{" "}
                            {fmtDate(row.rejectedAt)} by {actorLabel(row.rejectedBy)}
                            {row.rejectionReason ? (
                              <span className="block">{row.rejectionReason}</span>
                            ) : null}
                          </p>
                        ) : null}
                        {row.completedAt ? (
                          <p className="mt-1 text-emerald-200/80">
                            <span className="text-emerald-300/60">Paid:</span>{" "}
                            {fmtDate(row.completedAt)} by {actorLabel(row.completedBy)}
                            {row.paymentReference ? (
                              <span className="block">UTR: {row.paymentReference}</span>
                            ) : null}
                          </p>
                        ) : null}
                      </td>
                      <td className="max-w-xs px-5 py-4 text-xs leading-relaxed text-white/55 sm:px-6">
                        <p>
                          <span className="text-white/35">Mobile:</span>{" "}
                          {row.user.mobile?.trim() || "—"}
                        </p>
                        <p className="mt-1">
                          <span className="text-white/35">PAN:</span>{" "}
                          {row.user.panNumber?.trim() || "—"}
                        </p>
                        <p className="mt-1">
                          <span className="text-white/35">Address:</span>{" "}
                          {row.user.address?.trim() || "—"}
                        </p>
                      </td>
                      <td className="whitespace-nowrap px-5 py-4 text-right sm:px-6">
                        <div className="flex min-w-[220px] flex-col items-end gap-2">
                          {row.status === "PENDING" ? (
                            <>
                              <button
                                type="button"
                                onClick={() =>
                                  void postAction(row.id, "approve", {}, "Payout approved.")
                                }
                                disabled={!!rowBusy[row.id]}
                                className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-sky-500/20 px-3 py-2 text-xs font-semibold text-sky-100 ring-1 ring-sky-500/35 transition hover:bg-sky-500/30 disabled:opacity-50"
                              >
                                {rowBusy[row.id] ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                                ) : (
                                  <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                                )}
                                Approve
                              </button>
                              <input
                                type="text"
                                value={rejectReasons[row.id] ?? ""}
                                onChange={(e) =>
                                  setRejectReasons((prev) => ({
                                    ...prev,
                                    [row.id]: e.target.value,
                                  }))
                                }
                                placeholder="Rejection reason (required)"
                                disabled={!!rowBusy[row.id]}
                                className="w-full rounded-lg border border-glassBorder bg-white/[0.04] px-2.5 py-1.5 text-left text-xs text-white placeholder:text-white/35 focus:border-red-500/50 focus:outline-none disabled:opacity-50"
                              />
                              <input
                                type="text"
                                value={confirmEmails[row.id] ?? ""}
                                onChange={(e) =>
                                  setConfirmEmails((prev) => ({
                                    ...prev,
                                    [row.id]: e.target.value,
                                  }))
                                }
                                placeholder={`Type ${row.user.email} to confirm`}
                                disabled={!!rowBusy[row.id]}
                                className="w-full rounded-lg border border-glassBorder bg-white/[0.04] px-2.5 py-1.5 text-left text-xs text-white placeholder:text-white/35 focus:border-red-500/50 focus:outline-none disabled:opacity-50"
                              />
                              <button
                                type="button"
                                onClick={() =>
                                  void postAction(
                                    row.id,
                                    "reject",
                                    {
                                      reason: rejectReason,
                                      confirmation: confirmEmail,
                                    },
                                    "Payout rejected; commission released.",
                                  )
                                }
                                disabled={
                                  !!rowBusy[row.id] || !rejectReason || !emailMatch
                                }
                                className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-red-500/15 px-3 py-2 text-xs font-semibold text-red-100 ring-1 ring-red-500/35 transition hover:bg-red-500/25 disabled:opacity-50"
                              >
                                {rowBusy[row.id] ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                                ) : (
                                  <XCircle className="h-3.5 w-3.5" aria-hidden />
                                )}
                                Reject
                              </button>
                            </>
                          ) : null}

                          {row.status === "APPROVED" ? (
                            <>
                              <input
                                type="text"
                                value={paymentRefs[row.id] ?? ""}
                                onChange={(e) =>
                                  setPaymentRefs((prev) => ({
                                    ...prev,
                                    [row.id]: e.target.value,
                                  }))
                                }
                                placeholder="UTR / bank txn id"
                                disabled={!!rowBusy[row.id]}
                                className="w-full rounded-lg border border-glassBorder bg-white/[0.04] px-2.5 py-1.5 text-left text-xs text-white placeholder:text-white/35 focus:border-emerald-500/50 focus:outline-none disabled:opacity-50"
                              />
                              <input
                                type="text"
                                value={confirmEmails[row.id] ?? ""}
                                onChange={(e) =>
                                  setConfirmEmails((prev) => ({
                                    ...prev,
                                    [row.id]: e.target.value,
                                  }))
                                }
                                placeholder={`Type ${row.user.email} to confirm`}
                                disabled={!!rowBusy[row.id]}
                                className="w-full rounded-lg border border-glassBorder bg-white/[0.04] px-2.5 py-1.5 text-left text-xs text-white placeholder:text-white/35 focus:border-emerald-500/50 focus:outline-none disabled:opacity-50"
                              />
                              <button
                                type="button"
                                onClick={() =>
                                  void postAction(
                                    row.id,
                                    "complete",
                                    {
                                      paymentReference: paymentRef,
                                      confirmation: confirmEmail,
                                    },
                                    "Payout marked as paid.",
                                  )
                                }
                                disabled={
                                  !!rowBusy[row.id] || !paymentRef || !emailMatch
                                }
                                className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-emerald-500/20 px-3 py-2 text-xs font-semibold text-emerald-100 ring-1 ring-emerald-500/35 transition hover:bg-emerald-500/30 disabled:opacity-50"
                              >
                                {rowBusy[row.id] ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                                ) : (
                                  <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                                )}
                                Complete (mark paid)
                              </button>
                              <input
                                type="text"
                                value={rejectReasons[row.id] ?? ""}
                                onChange={(e) =>
                                  setRejectReasons((prev) => ({
                                    ...prev,
                                    [row.id]: e.target.value,
                                  }))
                                }
                                placeholder="Rejection reason (required)"
                                disabled={!!rowBusy[row.id]}
                                className="w-full rounded-lg border border-glassBorder bg-white/[0.04] px-2.5 py-1.5 text-left text-xs text-white placeholder:text-white/35 focus:border-red-500/50 focus:outline-none disabled:opacity-50"
                              />
                              <button
                                type="button"
                                onClick={() =>
                                  void postAction(
                                    row.id,
                                    "reject",
                                    {
                                      reason: rejectReason,
                                      confirmation: confirmEmail,
                                    },
                                    "Payout rejected; commission released.",
                                  )
                                }
                                disabled={
                                  !!rowBusy[row.id] || !rejectReason || !emailMatch
                                }
                                className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-red-500/15 px-3 py-2 text-xs font-semibold text-red-100 ring-1 ring-red-500/35 transition hover:bg-red-500/25 disabled:opacity-50"
                              >
                                Reject
                              </button>
                            </>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
