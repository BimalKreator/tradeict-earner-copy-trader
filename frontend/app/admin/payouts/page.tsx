"use client";

import {
  Banknote,
  CheckCircle2,
  Loader2,
  RefreshCw,
  UserRound,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { SALES_TEAM_ROLE_LABELS, isSalesTeamMember } from "@/lib/roles";

const ENV_API_BASE =
  process.env.NEXT_PUBLIC_API_URL?.trim().replace(/\/$/, "") ?? "";

function resolveApiBase(): string {
  if (ENV_API_BASE) return ENV_API_BASE;
  if (typeof window !== "undefined") {
    return `${window.location.origin.replace(/\/$/, "")}/api`;
  }
  return "";
}

type PayoutRow = {
  id: string;
  amount: number;
  status: "PENDING" | "COMPLETED";
  requestedAt: string;
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

export default function AdminPayoutsPage() {
  const apiBase = useMemo(() => resolveApiBase(), []);
  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;

  const [payouts, setPayouts] = useState<PayoutRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rowBusy, setRowBusy] = useState<Record<string, boolean>>({});
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

  async function markPaid(id: string) {
    if (!token || rowBusy[id]) return;
    setRowBusy((prev) => ({ ...prev, [id]: true }));
    setError(null);
    try {
      const res = await fetch(`${apiBase}/admin/payouts/${id}/complete`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const body: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg =
          typeof body === "object" &&
          body !== null &&
          "error" in body &&
          typeof (body as { error?: unknown }).error === "string"
            ? (body as { error: string }).error
            : `Could not complete payout (${res.status})`;
        throw new Error(msg);
      }
      setToast("Payout marked as paid.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to mark payout paid");
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
              Pending commission withdrawal requests from sales team members
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
            Pending requests
          </p>
          <p className="mt-2 text-3xl font-semibold tabular-nums text-white">
            {payouts.length}
          </p>
        </div>
        <div className="glass-card border border-glassBorder p-5">
          <p className="text-xs font-medium uppercase tracking-wider text-white/45">
            Total pending amount
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
            No pending partner payout requests.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="border-b border-glassBorder bg-white/[0.03] text-xs uppercase tracking-wider text-white/40">
                <tr>
                  <th className="px-5 py-3 font-medium sm:px-6">Partner</th>
                  <th className="px-5 py-3 font-medium sm:px-6">Amount</th>
                  <th className="px-5 py-3 font-medium sm:px-6">Requested</th>
                  <th className="px-5 py-3 font-medium sm:px-6">KYC / contact</th>
                  <th className="px-5 py-3 font-medium text-right sm:px-6">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-glassBorder/80">
                {payouts.map((row) => {
                  const roleLabel = isSalesTeamMember(row.user.role)
                    ? SALES_TEAM_ROLE_LABELS[row.user.role]
                    : row.user.role;
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
                      <td className="whitespace-nowrap px-5 py-4 text-white/65 sm:px-6">
                        {fmtDate(row.requestedAt)}
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
                        <button
                          type="button"
                          onClick={() => void markPaid(row.id)}
                          disabled={!!rowBusy[row.id]}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500/20 px-3 py-2 text-xs font-semibold text-emerald-100 ring-1 ring-emerald-500/35 transition hover:bg-emerald-500/30 disabled:opacity-50"
                        >
                          {rowBusy[row.id] ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                          ) : (
                            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                          )}
                          Mark as Paid
                        </button>
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
