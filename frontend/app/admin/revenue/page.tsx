"use client";

import {
  AlertTriangle,
  Banknote,
  Clock,
  Loader2,
  Mail,
  RefreshCw,
  Search,
  TrendingUp,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

const API_BASE = "http://localhost:5000/api/admin";

type InvoiceStatus = "UNPAID" | "PAID" | "OVERDUE";

type RevenueInvoice = {
  id: string;
  userId: string;
  amount: number;
  status: InvoiceStatus;
  dueDate: string;
  createdAt: string;
  user: { email: string };
};

type RevenueResponse = {
  stats: {
    totalRevenueReceived: number;
    pendingDuesUnpaid: number;
    projectedEarnings: number;
  };
  invoices: RevenueInvoice[];
};

function statusLabel(status: InvoiceStatus): string {
  switch (status) {
    case "PAID":
      return "Paid";
    case "OVERDUE":
      return "Overdue";
    default:
      return "Unpaid";
  }
}

function statusClasses(status: InvoiceStatus): string {
  switch (status) {
    case "PAID":
      return "bg-emerald-500/15 text-emerald-300";
    case "OVERDUE":
      return "bg-red-500/15 text-red-300";
    default:
      return "bg-amber-500/15 text-amber-200";
  }
}

export default function AdminRevenuePage() {
  const [data, setData] = useState<RevenueResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [unauthorized, setUnauthorized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emailQuery, setEmailQuery] = useState("");

  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;

  const load = useCallback(async () => {
    setError(null);
    if (!token) {
      setUnauthorized(true);
      setForbidden(false);
      setLoading(false);
      setData(null);
      return;
    }

    setLoading(true);
    setUnauthorized(false);
    setForbidden(false);

    try {
      const res = await fetch(`${API_BASE}/revenue`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (res.status === 401) {
        setUnauthorized(true);
        setData(null);
        return;
      }
      if (res.status === 403) {
        setForbidden(true);
        setData(null);
        return;
      }

      if (!res.ok) {
        const body: unknown = await res.json().catch(() => ({}));
        const msg =
          typeof body === "object" &&
          body !== null &&
          "error" in body &&
          typeof (body as { error?: unknown }).error === "string"
            ? (body as { error: string }).error
            : `Failed to load (${res.status})`;
        throw new Error(msg);
      }

      const raw: unknown = await res.json();
      if (
        typeof raw !== "object" ||
        raw === null ||
        !("stats" in raw) ||
        !("invoices" in raw)
      ) {
        throw new Error("Invalid response");
      }
      setData(raw as RevenueResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load revenue");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const filteredInvoices = useMemo(() => {
    const list = data?.invoices ?? [];
    const q = emailQuery.trim().toLowerCase();
    if (!q) return list;
    return list.filter((inv) =>
      inv.user.email.toLowerCase().includes(q),
    );
  }, [data?.invoices, emailQuery]);

  const stats = data?.stats;

  if (unauthorized) {
    return (
      <div className="mx-auto max-w-lg rounded-xl border border-amber-500/35 bg-amber-500/10 px-6 py-10 text-center">
        <AlertTriangle className="mx-auto h-10 w-10 text-amber-300" aria-hidden />
        <h1 className="mt-4 text-lg font-semibold text-white">Sign in required</h1>
        <p className="mt-2 text-sm text-white/60">
          Sign in with an admin account to view revenue and invoices.
        </p>
        <Link
          href="/login"
          className="mt-6 inline-flex rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-white hover:bg-primary/90"
        >
          Go to login
        </Link>
      </div>
    );
  }

  if (forbidden) {
    return (
      <div className="mx-auto max-w-lg rounded-xl border border-red-500/35 bg-red-500/10 px-6 py-10 text-center">
        <AlertTriangle className="mx-auto h-10 w-10 text-red-300" aria-hidden />
        <h1 className="mt-4 text-lg font-semibold text-white">Admin access only</h1>
        <p className="mt-2 text-sm text-white/60">
          Your account does not have permission to view this page.
        </p>
        <Link
          href="/dashboard"
          className="mt-6 inline-flex rounded-lg border border-glassBorder px-5 py-2.5 text-sm font-medium text-white hover:bg-white/10"
        >
          User dashboard
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl">
      <header className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">
            Revenue
          </h1>
          <p className="mt-2 max-w-xl text-sm text-white/55">
            Invoice totals, outstanding dues, and commission accrued this month
            (projected from PnL records).
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-glassBorder bg-white/[0.04] px-4 py-2.5 text-sm font-medium text-white hover:bg-white/10 disabled:opacity-50"
        >
          <RefreshCw
            className={`h-4 w-4 ${loading ? "animate-spin" : ""}`}
            aria-hidden
          />
          Refresh
        </button>
      </header>

      {error && (
        <div className="mb-6 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      <div className="mb-8 grid gap-4 sm:grid-cols-3">
        <div className="glass-card border border-glassBorder p-5">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-emerald-500/15 p-2.5">
              <Banknote className="h-5 w-5 text-emerald-400" aria-hidden />
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-wider text-white/45">
                Total revenue (received)
              </p>
              <p className="mt-1 text-xl font-semibold tabular-nums text-white">
                {loading && !stats
                  ? "—"
                  : `₹${(stats?.totalRevenueReceived ?? 0).toLocaleString("en-IN", {
                      maximumFractionDigits: 2,
                    })}`}
              </p>
            </div>
          </div>
          <p className="mt-3 text-xs text-white/40">Sum of paid invoices</p>
        </div>

        <div className="glass-card border border-glassBorder p-5">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-amber-500/15 p-2.5">
              <Clock className="h-5 w-5 text-amber-400" aria-hidden />
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-wider text-white/45">
                Pending dues (unpaid)
              </p>
              <p className="mt-1 text-xl font-semibold tabular-nums text-white">
                {loading && !stats
                  ? "—"
                  : `₹${(stats?.pendingDuesUnpaid ?? 0).toLocaleString("en-IN", {
                      maximumFractionDigits: 2,
                    })}`}
              </p>
            </div>
          </div>
          <p className="mt-3 text-xs text-white/40">
            Unpaid + overdue invoice balances
          </p>
        </div>

        <div className="glass-card border border-glassBorder p-5">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-sky-500/15 p-2.5">
              <TrendingUp className="h-5 w-5 text-sky-400" aria-hidden />
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-wider text-white/45">
                Projected earnings
              </p>
              <p className="mt-1 text-xl font-semibold tabular-nums text-white">
                {loading && !stats
                  ? "—"
                  : `₹${(stats?.projectedEarnings ?? 0).toLocaleString("en-IN", {
                      maximumFractionDigits: 2,
                    })}`}
              </p>
            </div>
          </div>
          <p className="mt-3 text-xs text-white/40">
            Commission from PnL this month (UTC)
          </p>
        </div>
      </div>

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <label className="relative flex w-full max-w-md items-center">
          <Search
            className="pointer-events-none absolute left-3 h-4 w-4 text-white/35"
            aria-hidden
          />
          <input
            type="search"
            placeholder="Filter by user email…"
            value={emailQuery}
            onChange={(e) => setEmailQuery(e.target.value)}
            className="w-full rounded-lg border border-glassBorder bg-black/40 py-2.5 pl-10 pr-4 text-sm text-white outline-none ring-primary/25 placeholder:text-white/35 focus:ring-2"
          />
        </label>
      </div>

      <div className="glass-card border border-glassBorder overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-left text-sm">
            <thead className="border-b border-glassBorder bg-white/[0.03]">
              <tr>
                <th className="px-4 py-3 font-medium text-white/70">User email</th>
                <th className="px-4 py-3 font-medium text-white/70">Invoice amount</th>
                <th className="px-4 py-3 font-medium text-white/70">Due date</th>
                <th className="px-4 py-3 font-medium text-white/70">Status</th>
                <th className="px-4 py-3 font-medium text-white/70">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={5} className="px-4 py-16 text-center text-white/45">
                    <Loader2
                      className="mx-auto h-8 w-8 animate-spin text-primary"
                      aria-hidden
                    />
                    <p className="mt-3">Loading invoices…</p>
                  </td>
                </tr>
              ) : filteredInvoices.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-14 text-center text-white/45">
                    {(data?.invoices.length ?? 0) === 0
                      ? "No invoices yet."
                      : "No invoices match this filter."}
                  </td>
                </tr>
              ) : (
                filteredInvoices.map((inv) => (
                  <tr
                    key={inv.id}
                    className="border-b border-white/[0.06] last:border-0 hover:bg-white/[0.02]"
                  >
                    <td className="px-4 py-3 font-medium text-white">
                      {inv.user.email}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-white/85">
                      ₹{inv.amount.toLocaleString("en-IN", { maximumFractionDigits: 2 })}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-white/55">
                      {new Date(inv.dueDate).toLocaleString()}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusClasses(inv.status)}`}
                      >
                        {statusLabel(inv.status)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => {
                          console.log(inv.user.email);
                        }}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-glassBorder bg-white/[0.06] px-3 py-1.5 text-xs font-medium text-white/90 hover:bg-white/10"
                      >
                        <Mail className="h-3.5 w-3.5 text-primary/90" aria-hidden />
                        Send reminder
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
