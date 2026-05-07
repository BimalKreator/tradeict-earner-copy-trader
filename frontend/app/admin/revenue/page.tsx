"use client";

import {
  AlertTriangle,
  Banknote,
  CircleDollarSign,
  Clock,
  Loader2,
  RefreshCw,
  Search,
  TrendingUp,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

const API_BASE = process.env.NEXT_PUBLIC_API_URL;

type InvoiceStatus = "PENDING" | "PAID" | "OVERDUE";

type AdminInvoice = {
  id: string;
  userId: string;
  userEmail: string;
  userName: string | null;
  strategyId: string;
  strategyTitle: string;
  month: number;
  year: number;
  totalPnl: number;
  amountDue: number;
  dueDate: string;
  status: InvoiceStatus;
  createdAt: string;
  updatedAt: string;
};

type RevenueStats = {
  totalRevenueGenerated: number;
  thisMonthRevenue: number;
  totalUserPnl: number;
  pendingPaymentsReceivables: number;
};

type StrategyRevenueRow = {
  strategyName: string;
  totalTrades: number;
  totalRevenueForAdmin: number;
  winRate: number;
};

type FilterMode = "all" | "outstanding";

const usdSignedFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  signDisplay: "always",
});

const usdFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const monthLabelFmt = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "long",
});

const dateFmt = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "2-digit",
});

function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return usdFmt.format(n);
}

function fmtUsdSigned(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return usdSignedFmt.format(n);
}

function fmtMonth(month: number, year: number): string {
  try {
    return monthLabelFmt.format(new Date(Date.UTC(year, month - 1, 1)));
  } catch {
    return `${year}-${String(month).padStart(2, "0")}`;
  }
}

function fmtDate(iso: string): string {
  try {
    return dateFmt.format(new Date(iso));
  } catch {
    return iso;
  }
}

function pnlToneClass(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "text-white/70";
  if (n > 0) return "text-emerald-400";
  if (n < 0) return "text-red-300";
  return "text-white/70";
}

function statusBadgeClasses(status: InvoiceStatus): string {
  switch (status) {
    case "PAID":
      return "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30";
    case "OVERDUE":
      return "bg-red-500/15 text-red-300 ring-1 ring-red-500/30";
    case "PENDING":
    default:
      return "bg-amber-500/15 text-amber-200 ring-1 ring-amber-500/30";
  }
}

async function authFetch(path: string): Promise<Response> {
  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;
  return fetch(`${API_BASE}${path}`, {
    cache: "no-store",
    headers: { Authorization: `Bearer ${token ?? ""}` },
  });
}

export default function AdminRevenuePage() {
  const [stats, setStats] = useState<RevenueStats | null>(null);
  const [strategyRows, setStrategyRows] = useState<StrategyRevenueRow[]>([]);
  const [invoices, setInvoices] = useState<AdminInvoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [filterMode, setFilterMode] = useState<FilterMode>("all");
  const [emailQuery, setEmailQuery] = useState("");

  const load = useCallback(async (silent: boolean) => {
    try {
      const [statsRes, invRes] = await Promise.all([
        authFetch("/admin/revenue/analytics"),
        authFetch("/admin/invoices"),
      ]);

      if (statsRes.status === 401 || invRes.status === 401) {
        if (!silent) {
          setUnauthorized(true);
          setStats(null);
          setInvoices([]);
        }
        return;
      }
      if (statsRes.status === 403 || invRes.status === 403) {
        if (!silent) {
          setForbidden(true);
          setStats(null);
          setInvoices([]);
        }
        return;
      }
      if (!statsRes.ok || !invRes.ok) {
        const codes = [statsRes.status, invRes.status]
          .filter((c) => c >= 400)
          .join("/");
        throw new Error(`Request failed (${codes})`);
      }

      const s = (await statsRes.json()) as {
        stats: RevenueStats;
        strategyWisePerformance?: StrategyRevenueRow[];
      };
      const inv = (await invRes.json()) as { invoices?: AdminInvoice[] };
      setStats(s.stats);
      setStrategyRows(Array.isArray(s.strategyWisePerformance) ? s.strategyWisePerformance : []);
      setInvoices(Array.isArray(inv.invoices) ? inv.invoices : []);
      if (!silent) {
        setError(null);
        setUnauthorized(false);
        setForbidden(false);
      }
    } catch (e) {
      if (!silent) {
        setError(e instanceof Error ? e.message : "Failed to load revenue");
      }
    } finally {
      if (silent) setRefreshing(false);
      else setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Initial data fetch on mount. setState inside `load` is gated behind
    // an `await`, so it never runs synchronously from this effect body.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- on-mount fetch is a legitimate effect side-effect
    void load(false);
  }, [load]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    void load(true);
  }, [load]);

  const filtered = useMemo(() => {
    const q = emailQuery.trim().toLowerCase();
    return invoices.filter((inv) => {
      if (filterMode === "outstanding") {
        if (inv.status !== "PENDING" && inv.status !== "OVERDUE") return false;
      }
      if (q) {
        const haystack = `${inv.userEmail} ${inv.userName ?? ""} ${inv.strategyTitle}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [invoices, filterMode, emailQuery]);

  if (unauthorized) {
    return (
      <div className="mx-auto max-w-lg rounded-xl border border-amber-500/35 bg-amber-500/10 px-6 py-10 text-center">
        <AlertTriangle className="mx-auto h-10 w-10 text-amber-300" aria-hidden />
        <h1 className="mt-4 text-lg font-semibold text-white">Sign in required</h1>
        <p className="mt-2 text-sm text-white/60">
          Sign in with an admin account to view platform revenue and invoices.
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
        <div className="flex items-start gap-3">
          <div className="rounded-xl border border-glassBorder bg-primary/10 p-3">
            <CircleDollarSign className="h-6 w-6 text-primary" aria-hidden />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">
              Platform revenue
            </h1>
            <p className="mt-2 max-w-xl text-sm text-white/55">
              Global high-water-mark accruals, collected revenue, and an
              invoice-by-invoice view across every user.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={refreshing || loading}
          className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-glassBorder bg-white/[0.04] px-4 py-2.5 text-sm font-medium text-white hover:bg-white/10 disabled:opacity-50"
        >
          <RefreshCw
            className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`}
            aria-hidden
          />
          Refresh
        </button>
      </header>

      {error ? (
        <div className="mb-6 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      ) : null}

      <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          tone="sky"
          icon={<TrendingUp className="h-5 w-5 text-sky-400" aria-hidden />}
          label="Total User P&L"
          subLabel="All-time across closed trades"
          value={loading && !stats ? "—" : fmtUsdSigned(stats?.totalUserPnl ?? 0)}
          valueToneClass={pnlToneClass(stats?.totalUserPnl ?? null)}
        />
        <StatCard
          tone="primary"
          icon={
            <CircleDollarSign className="h-5 w-5 text-primary" aria-hidden />
          }
          label="Total Revenue Generated"
          subLabel="Collected from PAID invoices"
          value={loading && !stats ? "—" : fmtUsd(stats?.totalRevenueGenerated ?? 0)}
        />
        <StatCard
          tone="emerald"
          icon={<Banknote className="h-5 w-5 text-emerald-400" aria-hidden />}
          label="This Month Revenue"
          subLabel="Estimated from profit-share this month"
          value={loading && !stats ? "—" : fmtUsd(stats?.thisMonthRevenue ?? 0)}
        />
        <StatCard
          tone="amber"
          icon={<Clock className="h-5 w-5 text-amber-400" aria-hidden />}
          label="Pending Payments (Receivables)"
          subLabel="Outstanding invoices"
          value={loading && !stats ? "—" : fmtUsd(stats?.pendingPaymentsReceivables ?? 0)}
        />
      </div>

      <div className="glass-card mb-8 border border-glassBorder overflow-hidden">
        <div className="border-b border-glassBorder bg-white/[0.03] px-4 py-3">
          <h2 className="text-sm font-semibold text-white">Strategy Wise Performance</h2>
        </div>
        <div className="scroll-table overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="border-b border-glassBorder bg-white/[0.02]">
              <tr>
                <th className="px-4 py-3 font-medium text-white/70">Strategy Name</th>
                <th className="px-4 py-3 text-right font-medium text-white/70">Total Trades</th>
                <th className="px-4 py-3 text-right font-medium text-white/70">Total Revenue for Admin</th>
                <th className="px-4 py-3 text-right font-medium text-white/70">Overall Win Rate</th>
              </tr>
            </thead>
            <tbody>
              {strategyRows.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-white/45">
                    No strategy data yet.
                  </td>
                </tr>
              ) : (
                strategyRows.map((r) => (
                  <tr key={r.strategyName} className="border-b border-white/[0.06] last:border-0 hover:bg-white/[0.02]">
                    <td className="px-4 py-3 text-white">{r.strategyName}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-white/80">{r.totalTrades}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-white">{fmtUsd(r.totalRevenueForAdmin)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-white/80">{r.winRate.toFixed(1)}%</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div
          role="tablist"
          aria-label="Invoice filter"
          className="inline-flex rounded-lg border border-glassBorder bg-white/[0.03] p-1 text-sm"
        >
          <FilterTab
            active={filterMode === "all"}
            onClick={() => setFilterMode("all")}
            label="All invoices"
            count={invoices.length}
          />
          <FilterTab
            active={filterMode === "outstanding"}
            onClick={() => setFilterMode("outstanding")}
            label="Outstanding only"
            count={
              invoices.filter(
                (i) => i.status === "PENDING" || i.status === "OVERDUE",
              ).length
            }
            highlight
          />
        </div>
        <label className="relative flex w-full max-w-md items-center">
          <Search
            className="pointer-events-none absolute left-3 h-4 w-4 text-white/35"
            aria-hidden
          />
          <input
            type="search"
            placeholder="Search by email, name, or strategy…"
            value={emailQuery}
            onChange={(e) => setEmailQuery(e.target.value)}
            className="w-full rounded-lg border border-glassBorder bg-black/40 py-2.5 pl-10 pr-4 text-sm text-white outline-none ring-primary/25 placeholder:text-white/35 focus:ring-2"
          />
        </label>
      </div>

      <div className="glass-card border border-glassBorder overflow-hidden">
        <div className="scroll-table overflow-x-auto">
          <table className="w-full min-w-[920px] text-left text-sm">
            <thead className="border-b border-glassBorder bg-white/[0.03]">
              <tr>
                <th className="px-4 py-3 font-medium text-white/70">
                  User
                </th>
                <th className="px-4 py-3 font-medium text-white/70">
                  Strategy
                </th>
                <th className="px-4 py-3 font-medium text-white/70">
                  Period
                </th>
                <th className="px-4 py-3 text-right font-medium text-white/70">
                  Amount
                </th>
                <th className="px-4 py-3 font-medium text-white/70">
                  Status
                </th>
                <th className="px-4 py-3 font-medium text-white/70">
                  Due date
                </th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-16 text-center text-white/45"
                  >
                    <Loader2
                      className="mx-auto h-8 w-8 animate-spin text-primary"
                      aria-hidden
                    />
                    <p className="mt-3">Loading invoices…</p>
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-14 text-center text-white/45"
                  >
                    {invoices.length === 0
                      ? "No invoices have been generated yet."
                      : filterMode === "outstanding"
                        ? "No outstanding invoices — all caught up."
                        : "No invoices match this filter."}
                  </td>
                </tr>
              ) : (
                filtered.map((inv) => (
                  <tr
                    key={inv.id}
                    className="border-b border-white/[0.06] last:border-0 hover:bg-white/[0.02]"
                  >
                    <td className="px-4 py-3">
                      <div className="flex flex-col">
                        <span className="font-medium text-white">
                          {inv.userEmail}
                        </span>
                        {inv.userName ? (
                          <span className="text-xs text-white/45">
                            {inv.userName}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="max-w-[220px] truncate px-4 py-3 text-white/80">
                      <span title={inv.strategyTitle}>{inv.strategyTitle}</span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-white/80">
                      {fmtMonth(inv.month, inv.year)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums font-semibold text-white">
                      {fmtUsd(inv.amountDue)}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium uppercase tracking-wide ${statusBadgeClasses(inv.status)}`}
                      >
                        {inv.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 tabular-nums text-white/55">
                      {fmtDate(inv.dueDate)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {!loading && filtered.length > 0 ? (
        <p className="mt-3 text-xs text-white/40">
          Showing {filtered.length} of {invoices.length} invoices.
        </p>
      ) : null}
    </div>
  );
}

function StatCard({
  tone,
  icon,
  label,
  subLabel,
  value,
  valueToneClass,
}: {
  tone: "primary" | "emerald" | "amber" | "sky";
  icon: React.ReactNode;
  label: string;
  subLabel: string;
  value: string;
  valueToneClass?: string;
}): React.ReactElement {
  const toneBg: Record<typeof tone, string> = {
    primary: "bg-primary/15",
    emerald: "bg-emerald-500/15",
    amber: "bg-amber-500/15",
    sky: "bg-sky-500/15",
  };
  return (
    <div className="glass-card border border-glassBorder p-5">
      <div className="flex items-center gap-3">
        <div className={`rounded-lg p-2.5 ${toneBg[tone]}`}>{icon}</div>
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wider text-white/45">
            {label}
          </p>
          <p
            className={`mt-1 text-xl font-semibold tabular-nums ${valueToneClass ?? "text-white"}`}
          >
            {value}
          </p>
        </div>
      </div>
      <p className="mt-3 text-xs text-white/40">{subLabel}</p>
    </div>
  );
}

function FilterTab({
  active,
  onClick,
  label,
  count,
  highlight = false,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  highlight?: boolean;
}): React.ReactElement {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`relative inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium transition ${
        active
          ? "bg-primary/15 text-primary ring-1 ring-primary/40"
          : "text-white/60 hover:bg-white/5 hover:text-white"
      }`}
    >
      {label}
      <span
        className={`rounded-full px-1.5 py-0.5 text-[10px] tabular-nums ${
          active
            ? "bg-primary/25 text-primary"
            : highlight && count > 0
              ? "bg-red-500/25 text-red-200"
              : "bg-white/10 text-white/55"
        }`}
      >
        {count}
      </span>
    </button>
  );
}
