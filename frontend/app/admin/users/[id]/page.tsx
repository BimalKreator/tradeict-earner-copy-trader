"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { ExitReasonBadge } from "@/components/trades/ExitReasonBadge";
import { Loader2 } from "lucide-react";

const API_BASE = process.env.NEXT_PUBLIC_API_URL;

type UserState = {
  id: string;
  email: string;
  name: string | null;
  mobile: string | null;
  address: string | null;
  panNumber: string | null;
  aadhaarNumber: string | null;
  status: "ACTIVE" | "SUSPENDED" | string;
  copyTradingPaused?: boolean;
  cryptoArbitrageEnabled?: boolean;
  cryptoBalance?: number;
  cryptoCapitalPerTradePercent?: number;
};

type ManagementPayload = {
  user: UserState;
  deltaApiKey: { id: string; nickname: string; apiKey: string; apiSecret: string } | null;
  exchangeAccount:
    | {
        id: string;
        nickname: string;
        exchange: string;
        apiKey: string;
        apiSecret: string;
      }
    | null;
};

type UserStrategy = {
  id: string;
  strategyTitle: string;
  status: string;
  multiplier: number;
};

type UserTrade = {
  id: string;
  createdAt: string;
  symbol: string;
  side: string;
  status: string;
  pnl: number;
  tradingFee: number;
  adminRevenue: number;
  exitReason: string | null;
};

type UserTransaction = {
  id: string;
  amount: number;
  type: string;
  status: string;
  createdAt: string;
};

type ProfileChangeRequest = {
  id: string;
  address: string | null;
  panNumber: string | null;
  aadhaarNumber: string | null;
  createdAt: string;
};

export default function AdminUserDetails({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const router = useRouter();
  const { id } = React.use(params);
  const userId = String(id ?? "");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<
    "management" | "subscriptions" | "trades" | "transactions"
  >("management");

  const [user, setUser] = useState<UserState | null>(null);
  const [balanceUsd, setBalanceUsd] = useState<number>(0);
  const [balanceStatus, setBalanceStatus] = useState<string | null>(null);
  const [strategies, setStrategies] = useState<UserStrategy[]>([]);
  const [trades, setTrades] = useState<UserTrade[]>([]);
  const [transactions, setTransactions] = useState<UserTransaction[]>([]);
  const [requests, setRequests] = useState<ProfileChangeRequest[]>([]);
  const [currentProfile, setCurrentProfile] = useState<{
    address: string | null;
    panNumber: string | null;
    aadhaarNumber: string | null;
  } | null>(null);

  const [statusDraft, setStatusDraft] = useState("ACTIVE");
  const [copyTradingPausedDraft, setCopyTradingPausedDraft] = useState(false);
  const [nicknameDraft, setNicknameDraft] = useState("Primary");
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [apiSecretDraft, setApiSecretDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [flushing, setFlushing] = useState(false);
  const [selectedTradeIds, setSelectedTradeIds] = useState<string[]>([]);
  const [sendingReset, setSendingReset] = useState(false);
  const [tradeStartDate, setTradeStartDate] = useState("");
  const [tradeEndDate, setTradeEndDate] = useState("");
  const [exporting, setExporting] = useState(false);
  const [cryptoArbitrageEnabledDraft, setCryptoArbitrageEnabledDraft] = useState(false);
  const [cryptoBalanceDraft, setCryptoBalanceDraft] = useState(0);
  const [cryptoBalanceAdjustment, setCryptoBalanceAdjustment] = useState("");
  const [cryptoAllocationDraft, setCryptoAllocationDraft] = useState("10");
  const [savingArbitrage, setSavingArbitrage] = useState(false);

  const authHeaders = useMemo(() => {
    const token =
      typeof window !== "undefined" ? localStorage.getItem("token") : null;
    return { Authorization: `Bearer ${token ?? ""}` };
  }, []);

  async function loadAll(): Promise<void> {
    if (!userId) return;
    setLoading(true);
    setError(null);
    try {
      const results = await Promise.allSettled([
        fetch(`${API_BASE}/admin/users/${userId}/management`, { headers: authHeaders }),
        fetch(`${API_BASE}/admin/users/${userId}/balance`, { headers: authHeaders }),
        fetch(`${API_BASE}/admin/users/${userId}/strategies`, { headers: authHeaders }),
        fetch(`${API_BASE}/admin/users/${userId}/trades`, { headers: authHeaders }),
        fetch(`${API_BASE}/admin/users/${userId}/transactions`, { headers: authHeaders }),
        fetch(`${API_BASE}/admin/users/${userId}/change-requests`, { headers: authHeaders }),
      ]);

      const mgRes = results[0].status === "fulfilled" ? results[0].value : null;
      const balRes = results[1].status === "fulfilled" ? results[1].value : null;
      const stRes = results[2].status === "fulfilled" ? results[2].value : null;
      const trRes = results[3].status === "fulfilled" ? results[3].value : null;
      const txRes = results[4].status === "fulfilled" ? results[4].value : null;
      const reqRes = results[5].status === "fulfilled" ? results[5].value : null;

      if (!mgRes?.ok) {
        throw new Error("Failed to load user details.");
      }

      const mg = (await mgRes.json()) as ManagementPayload;
      const st = stRes?.ok
        ? ((await stRes.json()) as { strategies?: UserStrategy[] })
        : { strategies: [] as UserStrategy[] };
      const tr = trRes?.ok
        ? ((await trRes.json()) as { trades?: UserTrade[] })
        : { trades: [] as UserTrade[] };
      const tx = txRes?.ok
        ? ((await txRes.json()) as { transactions?: UserTransaction[] })
        : { transactions: [] as UserTransaction[] };
      const reqData = reqRes?.ok
        ? ((await reqRes.json()) as {
            current?: {
              address: string | null;
              panNumber: string | null;
              aadhaarNumber: string | null;
            };
            requests?: ProfileChangeRequest[];
          })
        : { current: null, requests: [] as ProfileChangeRequest[] };

      let nextBalance = 0;
      let nextBalanceStatus: string | null = null;
      if (balRes?.ok) {
        const bal = (await balRes.json()) as {
          balance?: number;
          totalBalanceUsd?: number;
          status?: string;
          error?: string;
        };
        const raw =
          typeof bal.balance === "number"
            ? bal.balance
            : typeof bal.totalBalanceUsd === "number"
              ? bal.totalBalanceUsd
              : 0;
        nextBalance = Number.isFinite(raw) ? raw : 0;
        if (bal.status === "Connected") {
          nextBalanceStatus = null;
        } else {
          const err = bal.error?.toLowerCase() ?? "";
          nextBalanceStatus =
            err.includes("credential") || err.includes("configured")
              ? "Keys not set"
              : "Not connected";
        }
      } else {
        nextBalanceStatus = "Keys not set";
      }

      setUser(mg.user);
      setStatusDraft(mg.user.status === "SUSPENDED" ? "SUSPENDED" : "ACTIVE");
      setCopyTradingPausedDraft(Boolean(mg.user.copyTradingPaused));
      setCryptoArbitrageEnabledDraft(Boolean(mg.user.cryptoArbitrageEnabled));
      setCryptoBalanceDraft(
        typeof mg.user.cryptoBalance === "number" && Number.isFinite(mg.user.cryptoBalance)
          ? mg.user.cryptoBalance
          : 0,
      );
      setCryptoAllocationDraft(
        typeof mg.user.cryptoCapitalPerTradePercent === "number" &&
          Number.isFinite(mg.user.cryptoCapitalPerTradePercent)
          ? String(mg.user.cryptoCapitalPerTradePercent)
          : "10",
      );
      setCryptoBalanceAdjustment("");
      const source = mg.deltaApiKey ?? mg.exchangeAccount;
      setNicknameDraft(source?.nickname ?? "Primary");
      setApiKeyDraft(source?.apiKey ?? "");
      setApiSecretDraft(source?.apiSecret ?? "");
      setBalanceUsd(nextBalance);
      setBalanceStatus(nextBalanceStatus);
      setStrategies(st.strategies ?? []);
      setTrades(tr.trades ?? []);
      setTransactions(tx.transactions ?? []);
      setCurrentProfile(reqData.current ?? null);
      setRequests(reqData.requests ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load page.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- on-mount/user switch fetch is intentional
    void loadAll();
  }, [userId]); // eslint-disable-line react-hooks/exhaustive-deps

  const filteredTrades = useMemo(() => {
    const start = tradeStartDate ? new Date(`${tradeStartDate}T00:00:00`) : null;
    const end = tradeEndDate ? new Date(`${tradeEndDate}T23:59:59.999`) : null;
    return trades.filter((t) => {
      const when = new Date(t.createdAt);
      if (start && when < start) return false;
      if (end && when > end) return false;
      return true;
    });
  }, [tradeEndDate, tradeStartDate, trades]);

  const flushableFilteredTrades = useMemo(
    () => filteredTrades.filter((t) => t.status !== "OPEN"),
    [filteredTrades],
  );

  const allFlushableSelected =
    flushableFilteredTrades.length > 0 &&
    flushableFilteredTrades.every((t) => selectedTradeIds.includes(t.id));

  function toggleTradeSelection(tradeId: string, checked: boolean): void {
    setSelectedTradeIds((prev) =>
      checked ? [...new Set([...prev, tradeId])] : prev.filter((id) => id !== tradeId),
    );
  }

  function toggleSelectAllFlushable(checked: boolean): void {
    if (!checked) {
      setSelectedTradeIds((prev) =>
        prev.filter((id) => !flushableFilteredTrades.some((t) => t.id === id)),
      );
      return;
    }
    setSelectedTradeIds((prev) => [
      ...new Set([...prev, ...flushableFilteredTrades.map((t) => t.id)]),
    ]);
  }

  async function saveCryptoArbitrage(): Promise<void> {
    setSavingArbitrage(true);
    setError(null);
    setNotice(null);
    try {
      const allocation = Number(cryptoAllocationDraft);
      if (!Number.isFinite(allocation) || allocation <= 0 || allocation > 100) {
        throw new Error("Trade allocation must be greater than 0 and at most 100.");
      }

      const adjustment = cryptoBalanceAdjustment.trim();
      const requests: Promise<Response>[] = [
        fetch(`${API_BASE}/admin/users/${userId}/crypto-arbitrage/enabled`, {
          method: "PATCH",
          headers: { ...authHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: cryptoArbitrageEnabledDraft }),
        }),
        fetch(`${API_BASE}/admin/users/${userId}/crypto-arbitrage/allocation`, {
          method: "PATCH",
          headers: { ...authHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ percent: allocation }),
        }),
      ];

      if (adjustment !== "") {
        const delta = Number(adjustment);
        if (!Number.isFinite(delta)) {
          throw new Error("Balance adjustment must be a valid number.");
        }
        requests.push(
          fetch(`${API_BASE}/admin/users/${userId}/crypto-arbitrage/balance`, {
            method: "PATCH",
            headers: { ...authHeaders, "Content-Type": "application/json" },
            body: JSON.stringify({ delta }),
          }),
        );
      }

      const results = await Promise.all(requests);
      if (results.some((r) => !r.ok)) {
        throw new Error("Failed to save crypto arbitrage settings.");
      }

      const balanceRes = results.find((r) =>
        r.url.includes("/crypto-arbitrage/balance"),
      );
      if (balanceRes?.ok) {
        const bal = (await balanceRes.json()) as { cryptoBalance?: number };
        if (typeof bal.cryptoBalance === "number") {
          setCryptoBalanceDraft(bal.cryptoBalance);
        }
      }

      setCryptoBalanceAdjustment("");
      setNotice("Crypto arbitrage settings updated successfully.");
      await loadAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save crypto arbitrage settings.");
    } finally {
      setSavingArbitrage(false);
    }
  }

  async function saveManagement(): Promise<void> {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const [statusRes, keysRes, copyRes] = await Promise.all([
        fetch(`${API_BASE}/admin/users/${userId}/status`, {
          method: "PATCH",
          headers: { ...authHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ status: statusDraft }),
        }),
        fetch(`${API_BASE}/admin/users/${userId}/api-keys`, {
          method: "PUT",
          headers: { ...authHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({
            nickname: nicknameDraft,
            apiKey: apiKeyDraft,
            apiSecret: apiSecretDraft,
          }),
        }),
        fetch(`${API_BASE}/admin/users/${userId}/copy-trading`, {
          method: "PATCH",
          headers: { ...authHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ paused: copyTradingPausedDraft }),
        }),
      ]);
      if (!statusRes.ok || !keysRes.ok || !copyRes.ok) {
        throw new Error("Failed to save management settings.");
      }
      setNotice("Management settings updated successfully.");
      await loadAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save settings.");
    } finally {
      setSaving(false);
    }
  }

  async function deleteUser(): Promise<void> {
    const ok = window.confirm(
      "Permanently delete this user and all related data? This cannot be undone.",
    );
    if (!ok) return;
    setDeleting(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`${API_BASE}/admin/users/${userId}`, {
        method: "DELETE",
        headers: authHeaders,
      });
      if (!res.ok) throw new Error("Failed to delete user.");
      router.push("/admin/users");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete user.");
    } finally {
      setDeleting(false);
    }
  }

  async function flushTrades(tradeIds?: string[]): Promise<void> {
    const selective = Boolean(tradeIds?.length);
    const ok = window.confirm(
      selective
        ? `Delete ${tradeIds!.length} selected closed/failed trade(s)? A backup CSV will be created.`
        : "Delete all closed/failed trades for this user? Open trades will be kept and a backup CSV will be created.",
    );
    if (!ok) return;
    setFlushing(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`${API_BASE}/admin/users/flush-trades`, {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          ...(selective ? { tradeIds } : {}),
        }),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(errBody.error ?? "Failed to flush trade history.");
      }
      const body = (await res.json()) as {
        backupFile?: string;
        deleted?: number;
        analyticsRemoved?: number;
      };
      setSelectedTradeIds([]);
      setNotice(
        body.backupFile
          ? `Flush backup created. ${body.deleted ?? 0} trade(s) removed; ${body.analyticsRemoved ?? 0} analytics row(s) cleared.`
          : `${body.deleted ?? 0} trade(s) removed; ${body.analyticsRemoved ?? 0} analytics row(s) cleared.`,
      );
      await loadAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to flush trade history.");
    } finally {
      setFlushing(false);
    }
  }

  async function flushTradeHistory(): Promise<void> {
    await flushTrades();
  }

  async function flushSelectedTrades(): Promise<void> {
    if (selectedTradeIds.length === 0) {
      setError("Select at least one closed or failed trade to flush.");
      return;
    }
    await flushTrades(selectedTradeIds);
  }

  async function sendResetLink(): Promise<void> {
    setSendingReset(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`${API_BASE}/admin/users/${userId}/reset-password-link`, {
        method: "POST",
        headers: authHeaders,
      });
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) throw new Error("Failed to send password reset link.");
      setNotice(body.message ?? "Password reset link sent successfully.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send reset link.");
    } finally {
      setSendingReset(false);
    }
  }

  async function generateTradeExport(): Promise<void> {
    setExporting(true);
    setError(null);
    setNotice(null);
    try {
      const qs = new URLSearchParams();
      if (tradeStartDate) qs.set("startDate", tradeStartDate);
      if (tradeEndDate) qs.set("endDate", tradeEndDate);
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      const res = await fetch(`${API_BASE}/admin/trades/export${suffix}`, {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      if (!res.ok) throw new Error("Failed to trigger export.");
      setNotice("File is being generated. Check the Downloads page shortly.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to trigger export.");
    } finally {
      setExporting(false);
    }
  }

  async function decideRequest(
    requestId: string,
    action: "approve" | "reject",
  ): Promise<void> {
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(
        `${API_BASE}/admin/users/${userId}/change-requests/${requestId}/${action}`,
        { method: "POST", headers: authHeaders },
      );
      if (!res.ok) throw new Error(`Failed to ${action} request.`);
      setNotice(
        action === "approve"
          ? "Profile update request approved."
          : "Profile update request rejected.",
      );
      await loadAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : `Failed to ${action} request.`);
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-white">User Management</h1>
          <p className="mt-1 text-sm text-white/55">
            {user ? `${user.name ?? "Unnamed User"} · ${user.email}` : "Loading user details..."}
          </p>
        </div>
        <Link
          href="/admin/users"
          className="rounded-lg border border-glassBorder px-3 py-2 text-sm text-white/80 hover:bg-white/10"
        >
          Back to Users
        </Link>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
          {notice}
        </div>
      )}

      {loading ? (
        <div className="py-16 text-center text-white/60">
          <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />
        </div>
      ) : (
        <>
          <div className="rounded-xl border border-glassBorder bg-white/[0.02] p-4">
            <div className="grid gap-3 md:grid-cols-3">
              <InfoField label="Name" value={user?.name ?? "—"} />
              <InfoField label="Email" value={user?.email ?? "—"} />
              <InfoField label="Mobile" value={user?.mobile ?? "—"} />
              <InfoField label="Current Address" value={user?.address ?? "—"} />
              <InfoField label="PAN" value={user?.panNumber ?? "—"} />
              <InfoField label="Aadhaar" value={user?.aadhaarNumber ?? "—"} />
              <InfoField
                label="Delta Exchange Total Balance"
                value={
                  balanceStatus
                    ? balanceStatus
                    : `$${balanceUsd.toFixed(2)}`
                }
              />
            </div>
            <div className="mt-4">
              <button
                type="button"
                onClick={() => void sendResetLink()}
                disabled={sendingReset}
                className="rounded-lg border border-blue-500/45 bg-blue-500/15 px-3 py-2 text-xs font-medium text-blue-200 hover:bg-blue-500/25 disabled:opacity-60"
              >
                {sendingReset ? "Sending..." : "Send Password Reset Link"}
              </button>
            </div>
          </div>

          <div className="inline-flex rounded-lg border border-glassBorder bg-white/[0.03] p-1 text-sm">
            <TabButton active={tab === "management"} onClick={() => setTab("management")}>
              Management
            </TabButton>
            <TabButton active={tab === "subscriptions"} onClick={() => setTab("subscriptions")}>
              Subscriptions
            </TabButton>
            <TabButton active={tab === "trades"} onClick={() => setTab("trades")}>
              Trade History
            </TabButton>
            <TabButton active={tab === "transactions"} onClick={() => setTab("transactions")}>
              Transactions & Approvals
            </TabButton>
          </div>

          {tab === "management" && (
            <div className="space-y-4">
            <div className="space-y-4 rounded-xl border border-glassBorder bg-white/[0.02] p-4">
              <div className="grid gap-4 md:grid-cols-2">
                <label className="text-sm text-white/70">
                  Account Status
                  <select
                    value={statusDraft}
                    onChange={(e) => setStatusDraft(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40"
                  >
                    <option value="ACTIVE">Active</option>
                    <option value="SUSPENDED">Suspended</option>
                  </select>
                </label>
                <label className="text-sm text-white/70">
                  Copy Trading
                  <select
                    value={copyTradingPausedDraft ? "paused" : "active"}
                    onChange={(e) =>
                      setCopyTradingPausedDraft(e.target.value === "paused")
                    }
                    className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40"
                  >
                    <option value="active">Active</option>
                    <option value="paused">Paused</option>
                  </select>
                </label>
                <label className="text-sm text-white/70">
                  API Nickname
                  <input
                    value={nicknameDraft}
                    onChange={(e) => setNicknameDraft(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40"
                  />
                </label>
                <label className="text-sm text-white/70">
                  API Key
                  <input
                    value={apiKeyDraft}
                    onChange={(e) => setApiKeyDraft(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40"
                  />
                </label>
                <label className="text-sm text-white/70">
                  API Secret
                  <input
                    value={apiSecretDraft}
                    onChange={(e) => setApiSecretDraft(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40"
                  />
                </label>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => void saveManagement()}
                  disabled={saving}
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-60"
                >
                  {saving ? "Saving..." : "Save Management Changes"}
                </button>
                <button
                  type="button"
                  onClick={() => void flushTradeHistory()}
                  disabled={flushing}
                  className="rounded-lg border border-red-500/45 bg-red-500/15 px-3 py-2 text-xs font-medium text-red-200 hover:bg-red-500/25 disabled:opacity-60"
                >
                  {flushing ? "Flushing..." : "Flush Trade History"}
                </button>
                <button
                  type="button"
                  onClick={() => void deleteUser()}
                  disabled={deleting}
                  className="rounded-lg border border-red-600/55 bg-red-600/20 px-3 py-2 text-xs font-medium text-red-100 hover:bg-red-600/30 disabled:opacity-60"
                >
                  {deleting ? "Deleting..." : "Delete User"}
                </button>
              </div>
            </div>

            <div className="space-y-4 rounded-xl border border-cyan-500/25 bg-cyan-500/[0.03] p-4">
              <h2 className="text-lg font-semibold text-white">
                Crypto Arbitrage Trading Management
              </h2>
              <p className="text-sm text-white/55">
                Enable arbitrage, fund the user&apos;s crypto balance, and set per-trade capital
                allocation.
              </p>

              <label className="flex cursor-pointer items-center justify-between gap-4 rounded-lg border border-glassBorder bg-black/30 px-4 py-3">
                <span className="text-sm text-white/80">Arbitrage enabled</span>
                <span className="relative inline-flex h-6 w-11 shrink-0 items-center">
                  <input
                    type="checkbox"
                    checked={cryptoArbitrageEnabledDraft}
                    onChange={(e) => setCryptoArbitrageEnabledDraft(e.target.checked)}
                    className="peer sr-only"
                  />
                  <span className="absolute inset-0 rounded-full bg-slate-700 transition peer-checked:bg-cyan-600" />
                  <span className="absolute left-0.5 h-5 w-5 rounded-full bg-white transition peer-checked:translate-x-5" />
                </span>
              </label>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="rounded-lg border border-glassBorder bg-black/30 px-4 py-3">
                  <p className="text-xs uppercase tracking-wider text-white/45">
                    Current crypto balance
                  </p>
                  <p className="mt-1 text-2xl font-semibold tabular-nums text-white">
                    {cryptoBalanceDraft.toFixed(2)} USDT
                  </p>
                </div>
                <label className="text-sm text-white/70">
                  Adjust balance (add or subtract)
                  <input
                    type="number"
                    step="0.01"
                    placeholder="e.g. 100 or -25"
                    value={cryptoBalanceAdjustment}
                    onChange={(e) => setCryptoBalanceAdjustment(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-cyan-500/40"
                  />
                  <span className="mt-1 block text-xs text-white/45">
                    Leave empty to keep balance unchanged. Negative values reduce capital.
                  </span>
                </label>
                <label className="text-sm text-white/70 md:col-span-2">
                  Trade Allocation % (
                  <code className="text-cyan-300/90">cryptoCapitalPerTradePercent</code>)
                  <input
                    type="number"
                    min={0.01}
                    max={100}
                    step={0.1}
                    value={cryptoAllocationDraft}
                    onChange={(e) => setCryptoAllocationDraft(e.target.value)}
                    className="mt-1 w-full max-w-xs rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-cyan-500/40"
                  />
                </label>
              </div>

              <button
                type="button"
                onClick={() => void saveCryptoArbitrage()}
                disabled={savingArbitrage}
                className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-500 disabled:opacity-60"
              >
                {savingArbitrage ? "Saving..." : "Save Arbitrage Settings"}
              </button>
            </div>
            </div>
          )}

          {tab === "subscriptions" && (
            <div className="space-y-2">
              {strategies.length === 0 ? (
                <p className="text-sm text-white/55">No subscriptions found.</p>
              ) : (
                strategies.map((s) => (
                  <div
                    key={s.id}
                    className="rounded-lg border border-glassBorder bg-white/[0.02] px-4 py-3 text-sm"
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-white">{s.strategyTitle}</span>
                      <span className="rounded bg-white/10 px-2 py-0.5 text-xs text-white/80">
                        {s.status}
                      </span>
                    </div>
                    <p className="mt-1 text-white/60">Multiplier: {s.multiplier}x</p>
                  </div>
                ))
              )}
            </div>
          )}

          {tab === "trades" && (
            <div className="rounded-xl border border-glassBorder bg-white/[0.02] p-4">
              <div className="mb-3 flex flex-wrap items-end gap-3">
                <label className="text-xs text-white/60">
                  Start Date
                  <input
                    type="date"
                    value={tradeStartDate}
                    onChange={(e) => setTradeStartDate(e.target.value)}
                    className="mt-1 block rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40"
                  />
                </label>
                <label className="text-xs text-white/60">
                  End Date
                  <input
                    type="date"
                    value={tradeEndDate}
                    onChange={(e) => setTradeEndDate(e.target.value)}
                    className="mt-1 block rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => void generateTradeExport()}
                  disabled={exporting}
                  className="rounded-lg border border-cyan-500/45 bg-cyan-500/15 px-3 py-2 text-xs font-medium text-cyan-200 hover:bg-cyan-500/25 disabled:opacity-60"
                >
                  {exporting ? "Generating..." : "Generate Export"}
                </button>
                <button
                  type="button"
                  onClick={() => void flushSelectedTrades()}
                  disabled={flushing || selectedTradeIds.length === 0}
                  className="rounded-lg border border-red-500/45 bg-red-500/15 px-3 py-2 text-xs font-medium text-red-200 hover:bg-red-500/25 disabled:opacity-60"
                >
                  {flushing ? "Flushing..." : `Flush Selected (${selectedTradeIds.length})`}
                </button>
                <button
                  type="button"
                  onClick={() => void flushTradeHistory()}
                  disabled={flushing}
                  className="rounded-lg border border-red-600/45 bg-red-600/15 px-3 py-2 text-xs font-medium text-red-100 hover:bg-red-600/25 disabled:opacity-60"
                >
                  Flush All Closed/Failed
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[880px] text-left text-sm">
                  <thead className="border-b border-glassBorder bg-white/[0.03] text-white/70">
                    <tr>
                      <th className="px-3 py-2 font-medium">
                        <input
                          type="checkbox"
                          checked={allFlushableSelected}
                          disabled={flushableFilteredTrades.length === 0}
                          onChange={(e) => toggleSelectAllFlushable(e.target.checked)}
                          aria-label="Select all flushable trades in view"
                          className="h-4 w-4 rounded border-glassBorder bg-black/40"
                        />
                      </th>
                      <th className="px-3 py-2 font-medium">Date</th>
                      <th className="px-3 py-2 font-medium">Symbol</th>
                      <th className="px-3 py-2 font-medium">Status</th>
                      <th className="px-3 py-2 font-medium">Side</th>
                      <th className="px-3 py-2 font-medium">Net PnL</th>
                      <th className="px-3 py-2 font-medium">Trading Fee</th>
                      <th className="px-3 py-2 font-medium">Admin Revenue</th>
                      <th className="px-3 py-2 font-medium">Close Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredTrades.length === 0 ? (
                      <tr>
                        <td colSpan={9} className="px-3 py-8 text-center text-white/45">
                          No trades found for selected range.
                        </td>
                      </tr>
                    ) : (
                      filteredTrades.map((t) => {
                        const flushable = t.status !== "OPEN";
                        return (
                          <tr key={t.id} className="border-b border-white/[0.06] last:border-0">
                            <td className="px-3 py-2">
                              <input
                                type="checkbox"
                                checked={selectedTradeIds.includes(t.id)}
                                disabled={!flushable}
                                onChange={(e) => toggleTradeSelection(t.id, e.target.checked)}
                                aria-label={`Select trade ${t.symbol}`}
                                className="h-4 w-4 rounded border-glassBorder bg-black/40 disabled:opacity-40"
                              />
                            </td>
                            <td className="px-3 py-2 text-white/60">{new Date(t.createdAt).toLocaleString()}</td>
                            <td className="px-3 py-2 text-white">{t.symbol}</td>
                            <td className="px-3 py-2 text-white/70">{t.status}</td>
                            <td className="px-3 py-2 text-white/80">{t.side}</td>
                            <td className={`px-3 py-2 ${t.pnl >= 0 ? "text-emerald-300" : "text-red-300"}`}>
                              ${t.pnl.toFixed(2)}
                            </td>
                            <td className="px-3 py-2 text-white">${t.tradingFee.toFixed(2)}</td>
                            <td className="px-3 py-2 text-white">${t.adminRevenue.toFixed(2)}</td>
                            <td className="px-3 py-2">
                              <ExitReasonBadge reason={t.exitReason} />
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {tab === "transactions" && (
            <div className="space-y-4">
              <div className="rounded-xl border border-glassBorder bg-white/[0.02] p-4">
                <h3 className="mb-3 text-sm font-medium text-white">Transactions</h3>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[740px] text-left text-sm">
                    <thead className="border-b border-glassBorder bg-white/[0.03] text-white/70">
                      <tr>
                        <th className="px-3 py-2 font-medium">Date</th>
                        <th className="px-3 py-2 font-medium">Type</th>
                        <th className="px-3 py-2 font-medium">Status</th>
                        <th className="px-3 py-2 font-medium">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {transactions.length === 0 ? (
                        <tr>
                          <td colSpan={4} className="px-3 py-8 text-center text-white/45">
                            No transactions found.
                          </td>
                        </tr>
                      ) : (
                        transactions.map((t) => (
                          <tr key={t.id} className="border-b border-white/[0.06] last:border-0">
                            <td className="px-3 py-2 text-white/60">{new Date(t.createdAt).toLocaleString()}</td>
                            <td className="px-3 py-2 text-white">{t.type}</td>
                            <td className="px-3 py-2 text-white/80">{t.status}</td>
                            <td className="px-3 py-2 text-white">${t.amount.toFixed(2)}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="rounded-xl border border-glassBorder bg-white/[0.02] p-4">
                <h3 className="mb-3 text-sm font-medium text-white">Pending Profile Update Requests</h3>
                {requests.length === 0 ? (
                  <p className="text-sm text-white/55">No pending requests.</p>
                ) : (
                  <div className="space-y-3">
                    {requests.map((r) => (
                      <div key={r.id} className="rounded-lg border border-white/10 p-3">
                        <p className="text-xs text-white/45">
                          Requested on {new Date(r.createdAt).toLocaleString()}
                        </p>
                        <div className="mt-2 grid gap-2 md:grid-cols-3">
                          <RequestField
                            label="Address"
                            current={currentProfile?.address ?? null}
                            requested={r.address}
                          />
                          <RequestField
                            label="PAN"
                            current={currentProfile?.panNumber ?? null}
                            requested={r.panNumber}
                          />
                          <RequestField
                            label="Aadhaar"
                            current={currentProfile?.aadhaarNumber ?? null}
                            requested={r.aadhaarNumber}
                          />
                        </div>
                        <div className="mt-3 flex gap-2">
                          <button
                            type="button"
                            onClick={() => void decideRequest(r.id, "approve")}
                            className="rounded-md bg-emerald-500/20 px-3 py-1.5 text-xs font-medium text-emerald-200 hover:bg-emerald-500/30"
                          >
                            Approve
                          </button>
                          <button
                            type="button"
                            onClick={() => void decideRequest(r.id, "reject")}
                            className="rounded-md bg-red-500/20 px-3 py-1.5 text-xs font-medium text-red-200 hover:bg-red-500/30"
                          >
                            Reject
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md px-3 py-1.5 ${
        active ? "bg-primary/20 text-primary" : "text-white/70 hover:bg-white/5"
      }`}
    >
      {children}
    </button>
  );
}

function InfoField({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-white/10 px-3 py-2">
      <p className="text-[11px] uppercase tracking-wider text-white/45">{label}</p>
      <p className="mt-1 text-sm text-white">{value || "—"}</p>
    </div>
  );
}

function RequestField({
  label,
  current,
  requested,
}: {
  label: string;
  current: string | null;
  requested: string | null;
}) {
  return (
    <div className="rounded-md border border-white/10 px-3 py-2">
      <p className="text-[11px] uppercase tracking-wider text-white/45">{label}</p>
      <p className="mt-1 text-xs text-white/50">Current: {current ?? "—"}</p>
      <p className="mt-1 text-sm text-cyan-200">Requested: {requested ?? "—"}</p>
    </div>
  );
}
