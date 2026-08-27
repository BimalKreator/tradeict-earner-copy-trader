"use client";

import Link from "next/link";
import {
  Activity,
  Calendar,
  CircleDollarSign,
  CreditCard,
  KeyRound,
  Layers,
  Loader2,
  PlayCircle,
  TrendingUp,
  Wallet,
  ArrowDownToLine,
  Plus,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { WithdrawFundsModal } from "@/components/wallet/WithdrawFundsModal";
import {
  fmtUsd,
  fmtWalletBalance,
  fmtPct,
  formatINR,
  RATE_MISSING_MESSAGE,
  resolveUsdInrRate,
} from "@/lib/currency";
import {
  parseJsonObject,
  readFiniteNumber,
  readOptionalFiniteNumber,
  readStringArray,
} from "@/lib/safeJson";
import { resolveApiBase } from "@/lib/apiBase";
import { fetchWithTimeout, isFetchTimeoutError } from "@/lib/fetchTimeout";
import { currentIstYearMonth, isUtcInstantInIstMonth } from "@/lib/istDates";
import type { RevenueInvoiceRow } from "@/lib/revenueInvoiceTypes";

type DashboardOverview = {
  earnedPnl: number;
  earnedPnlPercent: number;
  todayPnl: number;
  todayPnlPercent: number;
  monthlyPnl: number;
  monthlyPnlPercent: number;
  grossPnlAllTime?: number;
  grossPnlMonth?: number;
  appRevenueAllTime?: number;
  appRevenueMonth?: number;
  grossBookedPnlMonth?: number;
  revenueSharingDue: number;
  availableCapital: number;
  totalBalance: number;
  availableBalance: number;
  usedBalance: number;
  activeStrategies: {
    count: number;
    names: string[];
    daysUntilNextFee: number | null;
  };
  apiStatus: "connected" | "disconnected";
  copyTradingActive: boolean;
  copyTradingPaused: boolean;
};

type WalletSummary = {
  exists: boolean;
  balance: number;
  availableBalance?: number;
  lockedBalance?: number;
  usdInrRate?: number;
};

type DeltaMoneySummary = {
  cumulativeRealized: number | null;
  highWaterMark: number | null;
  thisMonthRealized: number | null;
  /** null = invoices could not be loaded (never treat as ₹0). */
  unpaidRevenueShare: number | null;
  pnlLoaded: boolean;
  invoicesLoaded: boolean;
};

type Toast = { kind: "success" | "error"; text: string } | null;

function parseDashboardOverview(raw: unknown): DashboardOverview | null {
  const obj = parseJsonObject(raw);
  if (!obj) return null;

  const activeRaw = parseJsonObject(obj.activeStrategies);

  return {
    earnedPnl: readFiniteNumber(obj, "earnedPnl"),
    earnedPnlPercent: readFiniteNumber(obj, "earnedPnlPercent"),
    todayPnl: readFiniteNumber(obj, "todayPnl"),
    todayPnlPercent: readFiniteNumber(obj, "todayPnlPercent"),
    monthlyPnl: readFiniteNumber(obj, "monthlyPnl"),
    monthlyPnlPercent: readFiniteNumber(obj, "monthlyPnlPercent"),
    grossPnlAllTime: readOptionalFiniteNumber(obj, "grossPnlAllTime") ?? undefined,
    grossPnlMonth: readOptionalFiniteNumber(obj, "grossPnlMonth") ?? undefined,
    appRevenueAllTime: readOptionalFiniteNumber(obj, "appRevenueAllTime") ?? undefined,
    appRevenueMonth: readOptionalFiniteNumber(obj, "appRevenueMonth") ?? undefined,
    grossBookedPnlMonth: readOptionalFiniteNumber(obj, "grossBookedPnlMonth") ?? undefined,
    revenueSharingDue: readFiniteNumber(obj, "revenueSharingDue"),
    availableCapital: readFiniteNumber(obj, "availableCapital"),
    totalBalance: readFiniteNumber(obj, "totalBalance"),
    availableBalance: readFiniteNumber(obj, "availableBalance"),
    usedBalance: readFiniteNumber(obj, "usedBalance"),
    activeStrategies: {
      count: activeRaw ? readFiniteNumber(activeRaw, "count") : 0,
      names: activeRaw ? readStringArray(activeRaw, "names") : [],
      daysUntilNextFee: activeRaw
        ? readOptionalFiniteNumber(activeRaw, "daysUntilNextFee")
        : null,
    },
    apiStatus: obj.apiStatus === "connected" ? "connected" : "disconnected",
    copyTradingActive: obj.copyTradingActive === true,
    copyTradingPaused: obj.copyTradingPaused === true,
  };
}

function parseWalletSummary(raw: unknown): WalletSummary {
  const obj = parseJsonObject(raw);
  if (!obj) return { exists: false, balance: 0 };

  return {
    exists: obj.exists === true,
    balance: readFiniteNumber(obj, "balance"),
    availableBalance: readOptionalFiniteNumber(obj, "availableBalance") ?? undefined,
    lockedBalance: readOptionalFiniteNumber(obj, "lockedBalance") ?? undefined,
    usdInrRate: readOptionalFiniteNumber(obj, "usdInrRate") ?? undefined,
  };
}

function pnlTone(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "text-slate-300";
  if (n > 0) return "text-emerald-400";
  if (n < 0) return "text-red-400";
  return "text-slate-300";
}

function usdSecondaryLabel(usd: number, balance = false): string {
  return `≈ ${balance ? fmtWalletBalance(usd) : fmtUsd(usd)}`;
}

/** INR primary (large) + USD secondary (small) — single source of truth for metric cards. */
function DualCurrencyValue({
  usd,
  balance = false,
  valueClass = "text-white",
  rate,
}: {
  usd: number;
  balance?: boolean;
  valueClass?: string;
  rate?: number | null;
}) {
  const displayUsd = balance ? Math.max(0, usd) : usd;
  const fx = resolveUsdInrRate(rate);
  return (
    <div className="mt-3">
      <p className={`text-2xl font-bold tabular-nums ${valueClass}`}>
        {formatINR(displayUsd, fx)}
      </p>
      <p className="mt-1 text-sm text-slate-500 tabular-nums">
        {usdSecondaryLabel(displayUsd, balance)}
      </p>
      <p className="mt-0.5 text-[10px] text-slate-600">
        {fx != null
          ? `(at ₹${fx.toLocaleString("en-IN")}/$)`
          : RATE_MISSING_MESSAGE}
      </p>
    </div>
  );
}

export default function DashboardPage() {
  const [data, setData] = useState<DashboardOverview | null>(null);
  const [deltaMoney, setDeltaMoney] = useState<DeltaMoneySummary | null>(null);
  const [wallet, setWallet] = useState<WalletSummary | null>(null);
  const [walletLoading, setWalletLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast>(null);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [toggleBusy, setToggleBusy] = useState(false);
  const { token } = useAuth();
  const apiBase = resolveApiBase();

  const loadWallet = useCallback(async () => {
    try {
      const res = await fetchWithTimeout(`${apiBase}/wallet/me`, {
        headers: { Authorization: `Bearer ${token ?? ""}` },
        cache: "no-store",
      });
      if (!res.ok) {
        console.error("[dashboard] wallet failed", res.status);
        setWallet(null);
        return;
      }
      const parsed = parseWalletSummary(await res.json());
      setWallet(parsed);
    } catch (e) {
      console.error("[dashboard] wallet load error", e);
      setWallet(null);
    }
  }, [token, apiBase]);

  const loadDeltaMoney = useCallback(async () => {
    const headers = { Authorization: `Bearer ${token ?? ""}` };
    const [pnlRes, invRes] = await Promise.all([
      fetchWithTimeout(`${apiBase}/me/pnl/daily`, {
        headers,
        cache: "no-store",
      }).catch((e) => {
        console.error("[dashboard] daily P&L fetch error", e);
        return null;
      }),
      fetchWithTimeout(`${apiBase}/me/revenue/invoices`, {
        headers,
        cache: "no-store",
      }).catch((e) => {
        console.error("[dashboard] invoices fetch error", e);
        return null;
      }),
    ]);

    let cumulativeRealized: number | null = null;
    let highWaterMark: number | null = null;
    let thisMonthRealized: number | null = null;
    let pnlLoaded = false;

    if (pnlRes?.ok) {
      pnlLoaded = true;
      const pnlBody = (await pnlRes.json()) as {
        snapshots?: Array<{
          snapshotDate: string;
          realizedDelta: number;
          cumulativeRealized: number;
          highWaterMark: number;
        }>;
      };
      const snapshots = pnlBody.snapshots ?? [];
      const latest = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;
      const { year, month } = currentIstYearMonth();
      const monthSum = snapshots
        .filter((s) => isUtcInstantInIstMonth(s.snapshotDate, year, month))
        .reduce((sum, s) => sum + s.realizedDelta, 0);
      cumulativeRealized = latest?.cumulativeRealized ?? null;
      highWaterMark = latest?.highWaterMark ?? null;
      thisMonthRealized =
        snapshots.length > 0 || monthSum !== 0 ? monthSum : null;
    } else if (pnlRes) {
      console.error("[dashboard] daily P&L failed", pnlRes.status);
    }

    let unpaidRevenueShare: number | null = null;
    let invoicesLoaded = false;
    if (invRes?.ok) {
      invoicesLoaded = true;
      const invBody = (await invRes.json()) as {
        invoices?: RevenueInvoiceRow[];
      };
      unpaidRevenueShare = (invBody.invoices ?? [])
        .filter((inv) => inv.status === "INVOICED")
        .reduce((sum, inv) => sum + inv.collectibleAmount, 0);
    } else if (invRes) {
      console.error("[dashboard] invoices failed", invRes.status);
    }

    setDeltaMoney({
      cumulativeRealized,
      highWaterMark,
      thisMonthRealized,
      unpaidRevenueShare,
      pnlLoaded,
      invoicesLoaded,
    });
  }, [token, apiBase]);

  const loadOverview = useCallback(async () => {
    try {
      const res = await fetchWithTimeout(`${apiBase}/user/dashboard-overview`, {
        headers: { Authorization: `Bearer ${token ?? ""}` },
      });
      if (!res.ok) {
        console.error("[dashboard] overview failed", res.status);
        setData(null);
        setError("Couldn't load dashboard overview — retry");
        return;
      }
      const parsed = parseDashboardOverview(await res.json());
      if (!parsed) {
        console.error("[dashboard] overview parse failed");
        setData(null);
        setError("Couldn't load dashboard overview — retry");
        return;
      }
      setData(parsed);
      setError(null);
    } catch (e) {
      console.error("[dashboard] overview load error", e);
      setData(null);
      setError("Couldn't load dashboard overview — retry");
    }
  }, [token, apiBase]);

  const refreshApiStatus = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetchWithTimeout(`${apiBase}/user/api-status`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const body = parseJsonObject(await res.json());
      if (!body) return;
      const apiStatus =
        body.apiStatus === "connected" ? "connected" : "disconnected";
      const copyTradingPaused = body.copyTradingPaused === true;
      const copyTradingActive = body.copyTradingActive === true;
      setData((prev) =>
        prev
          ? { ...prev, apiStatus, copyTradingPaused, copyTradingActive }
          : prev,
      );
    } catch {
      // Non-blocking — overview already rendered.
    }
  }, [token, apiBase]);

  useEffect(() => {
    void (async () => {
      await Promise.all([loadOverview(), loadWallet(), loadDeltaMoney()]);
      void refreshApiStatus();
      setLoading(false);
      setWalletLoading(false);
    })();
  }, [loadOverview, loadWallet, loadDeltaMoney, refreshApiStatus]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 6000);
    return () => window.clearTimeout(t);
  }, [toast]);

  const availableWalletUsd = Math.max(
    0,
    wallet?.availableBalance ?? wallet?.balance ?? 0,
  );
  const usdInrRate = resolveUsdInrRate(wallet?.usdInrRate);

  async function toggleCopyTrading() {
    if (!data || toggleBusy) return;
    setToggleBusy(true);
    setError(null);
    try {
      const res = await fetchWithTimeout(`${apiBase}/user/copy-trading`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token ?? ""}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ paused: !data.copyTradingPaused }),
      });
      if (!res.ok) throw new Error(`Could not update copy trading (${res.status})`);
      const body = (await res.json()) as {
        copyTradingPaused: boolean;
        copyTradingActive: boolean;
        apiStatus: "connected" | "disconnected";
      };
      setData((prev) =>
        prev
          ? {
              ...prev,
              copyTradingPaused: body.copyTradingPaused,
              copyTradingActive: body.copyTradingActive,
              apiStatus: body.apiStatus,
            }
          : prev,
      );
    } catch (e) {
      setError(
        isFetchTimeoutError(e)
          ? e.message
          : e instanceof Error
            ? e.message
            : "Failed to update copy trading",
      );
    } finally {
      setToggleBusy(false);
    }
  }

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">
          Dashboard
        </h1>
        <p className="mt-1 text-sm text-slate-400">
          Your Delta copy-trading account at a glance.
        </p>
      </header>

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {toast ? (
        <div
          className={`rounded-xl border px-4 py-3 text-sm ${
            toast.kind === "success"
              ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-100"
              : "border-red-500/40 bg-red-500/10 text-red-100"
          }`}
          role="status"
        >
          {toast.text}
        </div>
      ) : null}

      {!loading && data && (data.activeStrategies?.count ?? 0) === 0 ? (
        <div className="rounded-xl border border-primary/30 bg-primary/10 px-4 py-4 sm:px-5">
          <p className="text-sm text-primary-100">
            You don&apos;t have an active strategy.{" "}
            <Link
              href="/dashboard/strategies"
              className="font-semibold text-white underline-offset-2 hover:underline"
            >
              Click here to explore and subscribe
            </Link>
            .
          </p>
        </div>
      ) : null}

      <section className="rounded-xl border border-slate-800 bg-slate-900 p-5 shadow-lg shadow-black/20">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="rounded-lg border border-sky-500/30 bg-sky-500/10 p-2.5">
              <CircleDollarSign className="h-5 w-5 text-sky-400" aria-hidden />
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-wider text-slate-400">
                Available wallet balance
              </p>
              {walletLoading ? (
                <div className="mt-2 flex items-center gap-2 text-sm text-slate-400">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  Loading…
                </div>
              ) : (
                <>
                  <p className="mt-1 text-3xl font-semibold tabular-nums text-white">
                    {formatINR(availableWalletUsd, usdInrRate)}
                  </p>
                  <p className="mt-1 text-sm tabular-nums text-slate-500">
                    ≈ {fmtWalletBalance(availableWalletUsd)}
                  </p>
                </>
              )}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              href="/dashboard/payments"
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition hover:bg-primary/90"
            >
              <Plus className="h-4 w-4" aria-hidden />
              Add Funds
            </Link>
            <button
              type="button"
              onClick={() => setWithdrawOpen(true)}
              disabled={walletLoading}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800/80 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-50"
            >
              <ArrowDownToLine className="h-4 w-4" aria-hidden />
              Withdraw Funds
            </button>
          </div>
        </div>
      </section>

      <WithdrawFundsModal
        open={withdrawOpen}
        apiBase={apiBase}
        token={token}
        availableBalance={availableWalletUsd}
        onClose={() => setWithdrawOpen(false)}
        onSuccess={(message) => {
          setToast({ kind: "success", text: message });
          setWalletLoading(true);
          void loadWallet()
            .catch(() => {
              setToast({
                kind: "error",
                text: "Withdrawal submitted but wallet balance could not be refreshed.",
              });
            })
            .finally(() => setWalletLoading(false));
        }}
        onError={(message) => setToast({ kind: "error", text: message })}
      />

      <DashboardSection
        title="Delta Exchange Trading"
        subtitle="Live copy-trading performance and account health."
      >
        {loading ? (
          <div className="flex justify-center rounded-xl border border-slate-800 bg-slate-900 py-20">
            <Loader2 className="h-8 w-8 animate-spin text-cyan-400" />
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              icon={<TrendingUp className="h-5 w-5 text-emerald-400" />}
              label="Cumulative realized P&L"
              currencyUsd={
                deltaMoney?.pnlLoaded
                  ? deltaMoney.cumulativeRealized
                  : null
              }
              loadFailed={deltaMoney == null || !deltaMoney.pnlLoaded}
              sub={
                <Link
                  href="/dashboard/performance"
                  className="text-xs text-cyan-400/90 hover:text-cyan-300"
                >
                  View full performance →
                </Link>
              }
              valueClass={pnlTone(
                deltaMoney?.pnlLoaded ? deltaMoney.cumulativeRealized : null,
              )}
              fxRate={usdInrRate}
            />

            <MetricCard
              icon={<Calendar className="h-5 w-5 text-violet-400" />}
              label="This month's realized"
              currencyUsd={
                deltaMoney?.pnlLoaded ? deltaMoney.thisMonthRealized : null
              }
              loadFailed={deltaMoney == null || !deltaMoney.pnlLoaded}
              sub={
                <span className="text-slate-500">
                  From your Delta account (IST month)
                </span>
              }
              valueClass={pnlTone(
                deltaMoney?.pnlLoaded ? deltaMoney.thisMonthRealized : null,
              )}
              fxRate={usdInrRate}
            />

            <MetricCard
              icon={<Activity className="h-5 w-5 text-cyan-400" />}
              label="High-water mark"
              currencyUsd={
                deltaMoney?.pnlLoaded ? deltaMoney.highWaterMark : null
              }
              loadFailed={deltaMoney == null || !deltaMoney.pnlLoaded}
              sub={
                <span className="text-slate-500">
                  Lifetime best cumulative realized P&L
                </span>
              }
              valueClass="text-white"
              fxRate={usdInrRate}
            />

            <MetricCard
              icon={<CreditCard className="h-5 w-5 text-amber-400" />}
              label="Unpaid profit share"
              currencyUsd={
                deltaMoney?.invoicesLoaded
                  ? deltaMoney.unpaidRevenueShare
                  : null
              }
              loadFailed={deltaMoney == null || !deltaMoney.invoicesLoaded}
              sub={
                deltaMoney?.invoicesLoaded !== true ? (
                  <span className="text-slate-500">Couldn&apos;t load</span>
                ) : (deltaMoney.unpaidRevenueShare ?? 0) > 0 ? (
                  <div className="flex flex-col gap-2">
                    <span className="text-xs text-slate-500">
                      Monthly invoices from Delta pipeline
                    </span>
                    <Link
                      href="/dashboard/performance"
                      className="inline-flex w-fit items-center rounded-md bg-amber-500/20 px-3 py-1.5 text-xs font-semibold text-amber-200 ring-1 ring-amber-500/40 transition hover:bg-amber-500/30"
                    >
                      Pay on Performance
                    </Link>
                  </div>
                ) : (
                  <span className="text-slate-500">No unpaid profit-share invoices</span>
                )
              }
              valueClass="text-amber-300"
              fxRate={usdInrRate}
            />

            <MetricCard
              icon={<Wallet className="h-5 w-5 text-sky-400" />}
              label="Total Delta Balance"
              currencyUsd={data ? data.totalBalance : null}
              loadFailed={!data}
              currencyAsBalance
              sub={
                data ? (
                <div className="space-y-2 border-t border-slate-800/80 pt-2">
                  <BalanceSubRow
                    label="Available"
                    usd={Math.max(0, data.availableBalance ?? data.availableCapital)}
                    fxRate={usdInrRate}
                  />
                  <BalanceSubRow
                    label="In active trades"
                    usd={Math.max(0, data.usedBalance)}
                    fxRate={usdInrRate}
                  />
                </div>
                ) : (
                  <span className="text-slate-500">Couldn&apos;t load</span>
                )
              }
              valueClass="text-white"
              fxRate={usdInrRate}
            />

            <MetricCard
              icon={<Layers className="h-5 w-5 text-indigo-400" />}
              label="Active Strategies"
              value={data ? String(data.activeStrategies?.count ?? 0) : undefined}
              loadFailed={!data}
              sub={
                !data ? (
                  <span className="text-slate-500">Couldn&apos;t load</span>
                ) : (data.activeStrategies?.count ?? 0) > 0 ? (
                  <div className="space-y-1">
                    {data.activeStrategies?.daysUntilNextFee != null ? (
                      <p className="text-xs font-medium text-indigo-300/90">
                        {data.activeStrategies.daysUntilNextFee} day
                        {data.activeStrategies.daysUntilNextFee === 1 ? "" : "s"}{" "}
                        until next subscription fee
                      </p>
                    ) : null}
                    {(data.activeStrategies?.names ?? []).length > 0 ? (
                      <p className="text-xs leading-relaxed text-slate-400">
                        {(data.activeStrategies?.names ?? []).join(" · ")}
                      </p>
                    ) : null}
                  </div>
                ) : (
                  <span className="text-slate-500">None deployed</span>
                )
              }
              valueClass="text-3xl text-white"
            />

            <MetricCard
              icon={<KeyRound className="h-5 w-5 text-slate-300" />}
              label="API Status"
              value={
                data
                  ? data.apiStatus === "connected"
                    ? "Connected"
                    : "Disconnected"
                  : undefined
              }
              loadFailed={!data}
              sub={
                data ? (
                <StatusDot
                  connected={data.apiStatus === "connected"}
                  label={
                    data.apiStatus === "connected"
                      ? "Delta keys verified"
                      : "Check API keys in settings"
                  }
                />
                ) : (
                  <span className="text-slate-500">Couldn&apos;t load</span>
                )
              }
              valueClass={
                data?.apiStatus === "connected" ? "text-emerald-400" : "text-red-400"
              }
            />

            <MetricCard
              icon={<PlayCircle className="h-5 w-5 text-cyan-400" />}
              label="Copy Trading"
              value={
                data
                  ? data.copyTradingActive
                    ? "Active"
                    : data.copyTradingPaused
                      ? "Paused"
                      : "Not deployed"
                  : undefined
              }
              loadFailed={!data}
              sub={
                data ? (
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs text-slate-500">
                    {data.copyTradingPaused
                      ? "Paused globally"
                      : data.copyTradingActive
                        ? "Mirroring master trades"
                        : data.apiStatus !== "connected"
                          ? "Connect API to resume"
                          : "Deploy a strategy to start"}
                  </span>
                  <ToggleSwitch
                    checked={data.copyTradingActive}
                    disabled={
                      toggleBusy ||
                      (!data.copyTradingActive && !data.copyTradingPaused)
                    }
                    onChange={() => void toggleCopyTrading()}
                  />
                </div>
                ) : (
                  <span className="text-slate-500">Couldn&apos;t load</span>
                )
              }
              valueClass={data?.copyTradingActive ? "text-emerald-400" : "text-slate-400"}
            />
          </div>
        )}
      </DashboardSection>
    </div>
  );
}

function DashboardSection({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold tracking-tight text-white md:text-xl">
          {title}
        </h2>
        <p className="mt-1 text-sm text-slate-400">{subtitle}</p>
      </div>
      {children}
    </section>
  );
}

function MetricCard({
  icon,
  label,
  value,
  currencyUsd,
  currencyAsBalance = false,
  secondaryValue,
  sub,
  valueClass = "text-white",
  fxRate,
  loadFailed = false,
}: {
  icon: ReactNode;
  label: string;
  value?: string;
  /** number = known amount; null/undefined with loadFailed = unknown. */
  currencyUsd?: number | null;
  currencyAsBalance?: boolean;
  secondaryValue?: ReactNode;
  sub: ReactNode;
  valueClass?: string;
  fxRate?: number | null;
  loadFailed?: boolean;
}) {
  const hasCurrency =
    typeof currencyUsd === "number" && Number.isFinite(currencyUsd);
  const showUnknown = loadFailed || (!hasCurrency && currencyUsd === null);

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900 p-5 shadow-lg shadow-black/20">
      <div className="flex items-center gap-2 text-slate-400">
        {icon}
        <p className="text-xs font-medium uppercase tracking-wider">{label}</p>
      </div>
      {showUnknown ? (
        <div className="mt-3">
          <p className="text-2xl font-semibold tabular-nums text-slate-400">—</p>
          <p className="mt-1 text-xs text-slate-500">Couldn&apos;t load</p>
        </div>
      ) : hasCurrency ? (
        <DualCurrencyValue
          usd={currencyUsd}
          balance={currencyAsBalance}
          valueClass={valueClass}
          rate={fxRate}
        />
      ) : (
        <>
          <p className={`mt-3 text-2xl font-semibold tabular-nums ${valueClass}`}>
            {value ?? "—"}
          </p>
          {secondaryValue ? <div className="mt-1">{secondaryValue}</div> : null}
        </>
      )}
      <div className="mt-2 text-sm">{sub}</div>
    </div>
  );
}

function BalanceSubRow({
  label,
  usd,
  fxRate,
}: {
  label: string;
  usd: number;
  fxRate?: number | null;
}) {
  const safeUsd = Math.max(0, usd);
  return (
    <div className="text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="text-slate-500">{label}</span>
        <span className="font-bold tabular-nums text-slate-200">
          {formatINR(safeUsd, fxRate)}
        </span>
      </div>
      <p className="mt-0.5 text-right text-[11px] tabular-nums text-slate-500">
        {usdSecondaryLabel(safeUsd, true)}
      </p>
    </div>
  );
}

function StatusDot({
  connected,
  label,
}: {
  connected: boolean;
  label: string;
}) {
  return (
    <div className="flex items-center gap-2 text-xs text-slate-400">
      <span
        className={`relative inline-flex h-2.5 w-2.5 rounded-full ${
          connected ? "bg-emerald-500" : "bg-red-500"
        }`}
      >
        {connected && (
          <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400 opacity-75" />
        )}
      </span>
      {label}
    </div>
  );
}

function ToggleSwitch({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={onChange}
      className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${
        checked ? "bg-emerald-500/80" : "bg-slate-700"
      } ${disabled ? "opacity-50" : ""}`}
    >
      <span
        className={`absolute top-0.5 left-0.5 h-6 w-6 rounded-full bg-white shadow transition-transform ${
          checked ? "translate-x-5" : "translate-x-0"
        }`}
      />
    </button>
  );
}
