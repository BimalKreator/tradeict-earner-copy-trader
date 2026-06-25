"use client";

import {
  AdjustWalletFundsModal,
  type WalletUserRow,
} from "@/components/admin/wallet/AdjustWalletFundsModal";
import {
  ProcessWithdrawalModal,
  type WithdrawalRequestRow,
} from "@/components/admin/wallet/ProcessWithdrawalModal";
import { fmtUsd, formatINR } from "@/lib/currency";
import {
  CircleDollarSign,
  Loader2,
  RefreshCw,
  SlidersHorizontal,
  UserRound,
  Wallet,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

const ENV_API_BASE =
  process.env.NEXT_PUBLIC_API_URL?.trim().replace(/\/$/, "") ?? "";

function resolveApiBase(): string {
  if (ENV_API_BASE) return ENV_API_BASE;
  if (typeof window !== "undefined") {
    return `${window.location.origin.replace(/\/$/, "")}/api`;
  }
  return "";
}

type WalletSummary = {
  totalWalletBalance: number;
  totalLockedBalance: number;
  totalPendingWithdrawals: number;
  pendingWithdrawalCount: number;
};

type TabId = "withdrawals" | "users";

type WithdrawalStatusFilter = "ALL" | "PENDING" | "COMPLETED" | "REJECTED";

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

function withdrawalStatusBadge(status: string): string {
  switch (status.toUpperCase()) {
    case "COMPLETED":
      return "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30";
    case "REJECTED":
      return "bg-red-500/15 text-red-300 ring-1 ring-red-500/30";
    case "PENDING":
    default:
      return "bg-amber-500/15 text-amber-200 ring-1 ring-amber-500/30";
  }
}

export default function AdminWalletPage() {
  const apiBase = useMemo(() => resolveApiBase(), []);
  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;

  const [tab, setTab] = useState<TabId>("withdrawals");
  const [summary, setSummary] = useState<WalletSummary | null>(null);
  const [withdrawals, setWithdrawals] = useState<WithdrawalRequestRow[]>([]);
  const [walletUsers, setWalletUsers] = useState<WalletUserRow[]>([]);
  const [statusFilter, setStatusFilter] = useState<WithdrawalStatusFilter>("ALL");

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [processTarget, setProcessTarget] = useState<WithdrawalRequestRow | null>(
    null,
  );
  const [adjustTarget, setAdjustTarget] = useState<WalletUserRow | null>(null);

  const load = useCallback(async () => {
    if (!token) {
      throw new Error("Not signed in");
    }

    const withdrawalQuery =
      statusFilter === "ALL" ? "" : `?status=${encodeURIComponent(statusFilter)}`;

    const [summaryRes, withdrawalsRes, usersRes] = await Promise.all([
      fetch(`${apiBase}/admin/wallet/summary`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      }),
      fetch(`${apiBase}/admin/wallet/withdrawals${withdrawalQuery}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      }),
      fetch(`${apiBase}/admin/wallet/users`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      }),
    ]);

    if (!summaryRes.ok || !withdrawalsRes.ok || !usersRes.ok) {
      const codes = [summaryRes.status, withdrawalsRes.status, usersRes.status]
        .filter((c) => c >= 400)
        .join("/");
      throw new Error(`Failed to load wallet data (${codes})`);
    }

    const summaryData = (await summaryRes.json()) as WalletSummary;
    const withdrawalsData = (await withdrawalsRes.json()) as {
      items?: WithdrawalRequestRow[];
    };
    const usersData = (await usersRes.json()) as { users?: WalletUserRow[] };

    setSummary(summaryData);
    setWithdrawals(withdrawalsData.items ?? []);
    setWalletUsers(usersData.users ?? []);
  }, [apiBase, statusFilter, token]);

  useEffect(() => {
    void (async () => {
      try {
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load wallet management");
      } finally {
        setLoading(false);
      }
    })();
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 4000);
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

  async function handleMutationSuccess(message: string) {
    setToast(message);
    setRefreshing(true);
    try {
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Refresh failed after update");
    } finally {
      setRefreshing(false);
    }
  }

  const totalUserFunds =
    (summary?.totalWalletBalance ?? 0) + (summary?.totalLockedBalance ?? 0);

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-4">
          <div className="rounded-xl border border-sky-500/30 bg-sky-500/10 p-3">
            <CircleDollarSign className="h-7 w-7 text-sky-300" aria-hidden />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">
              Wallet Management
            </h1>
            <p className="mt-1 text-sm text-white/50">
              User wallet balances, withdrawal requests, and manual adjustments
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
            Total user wallet balances
          </p>
          {loading ? (
            <Loader2 className="mt-3 h-6 w-6 animate-spin text-primary" />
          ) : (
            <>
              <p className="mt-2 text-3xl font-semibold tabular-nums text-white">
                {fmtUsd(totalUserFunds)}
              </p>
              <p className="mt-1 text-sm tabular-nums text-white/45">
                {formatINR(totalUserFunds)}
              </p>
              <p className="mt-2 text-xs text-white/40">
                Available {fmtUsd(summary?.totalWalletBalance ?? 0)} · Locked{" "}
                {fmtUsd(summary?.totalLockedBalance ?? 0)}
              </p>
            </>
          )}
        </div>
        <div className="glass-card border border-glassBorder p-5">
          <p className="text-xs font-medium uppercase tracking-wider text-white/45">
            Total pending withdrawals
          </p>
          {loading ? (
            <Loader2 className="mt-3 h-6 w-6 animate-spin text-primary" />
          ) : (
            <>
              <p className="mt-2 text-3xl font-semibold tabular-nums text-amber-200">
                {fmtUsd(summary?.totalPendingWithdrawals ?? 0)}
              </p>
              <p className="mt-1 text-sm tabular-nums text-white/45">
                {formatINR(summary?.totalPendingWithdrawals ?? 0)}
              </p>
              <p className="mt-2 text-xs text-white/40">
                {summary?.pendingWithdrawalCount ?? 0} open request
                {(summary?.pendingWithdrawalCount ?? 0) === 1 ? "" : "s"}
              </p>
            </>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-2 border-b border-glassBorder pb-1">
        <button
          type="button"
          onClick={() => setTab("withdrawals")}
          className={`rounded-t-lg px-4 py-2.5 text-sm font-medium transition ${
            tab === "withdrawals"
              ? "bg-white/[0.06] text-white ring-1 ring-glassBorder ring-b-transparent"
              : "text-white/55 hover:text-white/80"
          }`}
        >
          Withdrawal requests
        </button>
        <button
          type="button"
          onClick={() => setTab("users")}
          className={`rounded-t-lg px-4 py-2.5 text-sm font-medium transition ${
            tab === "users"
              ? "bg-white/[0.06] text-white ring-1 ring-glassBorder ring-b-transparent"
              : "text-white/55 hover:text-white/80"
          }`}
        >
          User wallets
        </button>
      </div>

      {tab === "withdrawals" ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {(["ALL", "PENDING", "COMPLETED", "REJECTED"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatusFilter(s)}
                className={`rounded-full px-3 py-1 text-xs font-medium uppercase tracking-wide transition ${
                  statusFilter === s
                    ? "bg-primary/20 text-primary ring-1 ring-primary/35"
                    : "bg-white/[0.04] text-white/55 hover:bg-white/[0.08]"
                }`}
              >
                {s}
              </button>
            ))}
          </div>

          <div className="glass-card overflow-hidden border border-glassBorder">
            {loading ? (
              <div className="flex justify-center py-20">
                <Loader2 className="h-8 w-8 animate-spin text-primary" aria-label="Loading" />
              </div>
            ) : withdrawals.length === 0 ? (
              <div className="px-6 py-16 text-center text-sm text-white/45">
                No withdrawal requests
                {statusFilter !== "ALL" ? ` with status ${statusFilter}` : ""}.
              </div>
            ) : (
              <div className="scroll-table w-full overflow-x-auto">
                <table className="w-full min-w-[980px] text-left text-sm">
                  <thead className="border-b border-glassBorder bg-white/[0.03] text-xs uppercase tracking-wider text-white/40">
                    <tr>
                      <th className="px-5 py-3 font-medium sm:px-6">Date</th>
                      <th className="px-5 py-3 font-medium sm:px-6">User</th>
                      <th className="px-5 py-3 font-medium sm:px-6">Amount</th>
                      <th className="px-5 py-3 font-medium sm:px-6">Bank details</th>
                      <th className="px-5 py-3 font-medium sm:px-6">Status</th>
                      <th className="px-5 py-3 text-right font-medium sm:px-6">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-glassBorder/80">
                    {withdrawals.map((row) => (
                      <tr key={row.id} className="align-top hover:bg-white/[0.02]">
                        <td className="whitespace-nowrap px-5 py-4 text-white/65 sm:px-6">
                          {fmtDate(row.createdAt)}
                        </td>
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
                              <p className="mt-0.5 text-xs text-white/45">
                                {row.user.email}
                              </p>
                            </div>
                          </div>
                        </td>
                        <td className="whitespace-nowrap px-5 py-4 sm:px-6">
                          <p className="font-semibold tabular-nums text-white">
                            {fmtUsd(row.amount)}
                          </p>
                          <p className="mt-0.5 text-xs tabular-nums text-white/45">
                            {formatINR(row.amount)}
                          </p>
                        </td>
                        <td className="max-w-xs px-5 py-4 text-xs leading-relaxed text-white/55 sm:px-6">
                          <p>
                            <span className="text-white/35">Bank:</span>{" "}
                            {row.bankName ?? "—"}
                          </p>
                          <p className="mt-1">
                            <span className="text-white/35">A/C:</span>{" "}
                            {row.bankAccountNumber ?? "—"}
                          </p>
                          <p className="mt-1">
                            <span className="text-white/35">IFSC:</span>{" "}
                            {row.bankIfsc ?? "—"}
                          </p>
                        </td>
                        <td className="px-5 py-4 sm:px-6">
                          <span
                            className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium uppercase ${withdrawalStatusBadge(row.status)}`}
                          >
                            {row.status}
                          </span>
                        </td>
                        <td className="whitespace-nowrap px-5 py-4 text-right sm:px-6">
                          {row.status === "PENDING" ? (
                            <button
                              type="button"
                              onClick={() => setProcessTarget(row)}
                              className="inline-flex items-center gap-1.5 rounded-lg bg-primary/20 px-3 py-2 text-xs font-semibold text-primary ring-1 ring-primary/35 transition hover:bg-primary/30"
                            >
                              <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden />
                              Process
                            </button>
                          ) : (
                            <span className="text-xs text-white/35">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="glass-card overflow-hidden border border-glassBorder">
          {loading ? (
            <div className="flex justify-center py-20">
              <Loader2 className="h-8 w-8 animate-spin text-primary" aria-label="Loading" />
            </div>
          ) : walletUsers.length === 0 ? (
            <div className="px-6 py-16 text-center text-sm text-white/45">
              No users found.
            </div>
          ) : (
            <div className="scroll-table w-full overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="border-b border-glassBorder bg-white/[0.03] text-xs uppercase tracking-wider text-white/40">
                  <tr>
                    <th className="px-5 py-3 font-medium sm:px-6">User</th>
                    <th className="px-5 py-3 font-medium sm:px-6">Available balance</th>
                    <th className="px-5 py-3 font-medium sm:px-6">Locked balance</th>
                    <th className="px-5 py-3 text-right font-medium sm:px-6">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-glassBorder/80">
                  {walletUsers.map((row) => (
                    <tr key={row.id} className="align-top hover:bg-white/[0.02]">
                      <td className="px-5 py-4 sm:px-6">
                        <div className="flex items-start gap-2">
                          <Wallet
                            className="mt-0.5 h-4 w-4 shrink-0 text-white/35"
                            aria-hidden
                          />
                          <div>
                            <p className="font-medium text-white">
                              {row.name?.trim() || "—"}
                            </p>
                            <p className="mt-0.5 text-xs text-white/45">{row.email}</p>
                          </div>
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-5 py-4 font-semibold tabular-nums text-emerald-200 sm:px-6">
                        {fmtUsd(row.balance)}
                      </td>
                      <td className="whitespace-nowrap px-5 py-4 tabular-nums text-amber-200/90 sm:px-6">
                        {fmtUsd(row.lockedBalance)}
                      </td>
                      <td className="whitespace-nowrap px-5 py-4 text-right sm:px-6">
                        <button
                          type="button"
                          onClick={() => setAdjustTarget(row)}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-glassBorder bg-white/[0.04] px-3 py-2 text-xs font-semibold text-white/85 transition hover:bg-white/[0.08]"
                        >
                          Adjust funds
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <ProcessWithdrawalModal
        open={processTarget !== null}
        request={processTarget}
        apiBase={apiBase}
        token={token}
        onClose={() => setProcessTarget(null)}
        onSuccess={(message) => void handleMutationSuccess(message)}
        onError={(message) => setError(message)}
      />

      <AdjustWalletFundsModal
        open={adjustTarget !== null}
        user={adjustTarget}
        apiBase={apiBase}
        token={token}
        onClose={() => setAdjustTarget(null)}
        onSuccess={(message) => void handleMutationSuccess(message)}
        onError={(message) => setError(message)}
      />
    </div>
  );
}
