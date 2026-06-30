"use client";

import {
  Briefcase,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Crown,
  GitBranch,
  Loader2,
  Lock,
  RefreshCw,
  Sparkles,
  Target,
  Timer,
  TrendingUp,
  Users,
  Wallet,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import {
  NominateMemberModal,
  NominateTeamMemberButton,
} from "@/components/partner/NominateMemberModal";
import { MilestoneTracker } from "@/components/partner/MilestoneTracker";
import { ReferralSubmissionForm } from "@/components/partner/ReferralSubmissionForm";
import { useAuth } from "@/context/AuthContext";
import { resolveApiBase } from "@/lib/apiBase";
import {
  canNominateMembers,
  isSalesTeamMember as isSalesTeamRole,
  SALES_TEAM_ROLE_LABELS,
  type SalesTeamRole,
} from "@/lib/roles";

type PartnerWallets = {
  earned: number;
  payable: number;
  withdrawable: number;
};

type PartnerMetrics = {
  referralCode: string | null;
  directAcquiredCount: number;
  networkAum: number;
  wallets: PartnerWallets;
};

type UserFinancials = {
  totalProfitGenerated: number;
  totalRevenueShareDue: number;
  totalRevenuePaid: number;
  memberCommissionEarned: number;
  memberCommissionPayable: number;
};

type NetworkNode = {
  id: string;
  name: string | null;
  email: string;
  role: string;
  nodeType: "member" | "user";
  depth: number;
  joinedAt: string | null;
  financials: UserFinancials;
  children: NetworkNode[];
};

type NetworkDetails = {
  viewerRole: string;
  tree: NetworkNode[];
  stats: {
    totalTeamMembers: number;
    totalUsers: number;
    totalProfitGenerated: number;
    totalRevenueShareDue: number;
    totalRevenuePaid: number;
    totalMemberCommissionEarned: number;
    totalMemberCommissionPayable: number;
  };
};

const usdFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return usdFmt.format(Math.max(0, n));
}

/** Signed USD for net PnL — losses display as negative values. */
function fmtSignedUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  return `${sign}${usdFmt.format(Math.abs(n))}`;
}

function pnlToneClass(n: number): string {
  if (n > 0) return "text-emerald-200/90";
  if (n < 0) return "text-red-300/90";
  return "text-white/75";
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function isLastDayOfUtcMonth(ref: Date = new Date()): boolean {
  const year = ref.getUTCFullYear();
  const month = ref.getUTCMonth();
  const day = ref.getUTCDate();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return day === lastDay;
}

function referralSignupUrl(code: string): string {
  const origin =
    typeof window !== "undefined"
      ? window.location.origin.replace(/\/$/, "")
      : (process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/$/, "") ??
        "https://tradeict.com");
  return `${origin}/signup?ref=${encodeURIComponent(code)}`;
}

function roleBadgeClass(role: string): string {
  if (role === "SENIOR_MANAGER") {
    return "bg-violet-500/15 text-violet-200 ring-violet-500/30";
  }
  if (role === "MANAGER") {
    return "bg-sky-500/15 text-sky-200 ring-sky-500/30";
  }
  if (role === "EXECUTIVE") {
    return "bg-emerald-500/15 text-emerald-200 ring-emerald-500/30";
  }
  return "bg-white/10 text-white/70 ring-white/20";
}

function roleLabel(role: string, nodeType: NetworkNode["nodeType"]): string {
  if (nodeType === "user") return "Trader";
  if (role === "SENIOR_MANAGER") return "Senior Manager";
  if (role === "MANAGER") return "Manager";
  if (role === "EXECUTIVE") return "Executive";
  return role;
}

function countDescendantUsers(node: NetworkNode): number {
  if (node.nodeType === "user") return 1;
  return node.children.reduce((sum, child) => sum + countDescendantUsers(child), 0);
}

function hasPersonalTradingActivity(financials: UserFinancials): boolean {
  return (
    financials.totalProfitGenerated !== 0 ||
    financials.totalRevenueShareDue > 0 ||
    financials.totalRevenuePaid > 0
  );
}

function WalletCard({
  title,
  amount,
  description,
  icon,
  accent,
  action,
}: {
  title: string;
  amount: number;
  description: string;
  icon: ReactNode;
  accent: "amber" | "sky" | "emerald";
  action?: ReactNode;
}) {
  const accentMap = {
    amber: {
      ring: "ring-amber-500/25",
      glow: "from-amber-500/20 via-amber-500/5 to-transparent",
      icon: "bg-amber-500/15 text-amber-300",
      value: "text-amber-100",
    },
    sky: {
      ring: "ring-sky-500/25",
      glow: "from-sky-500/20 via-sky-500/5 to-transparent",
      icon: "bg-sky-500/15 text-sky-300",
      value: "text-sky-100",
    },
    emerald: {
      ring: "ring-emerald-500/25",
      glow: "from-emerald-500/20 via-emerald-500/5 to-transparent",
      icon: "bg-emerald-500/15 text-emerald-300",
      value: "text-emerald-100",
    },
  }[accent];

  return (
    <article
      className={`relative overflow-hidden rounded-2xl border border-glassBorder bg-gradient-to-br ${accentMap.glow} p-5 shadow-lg ring-1 ${accentMap.ring} sm:p-6`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-white/45">
            {title}
          </p>
          <p
            className={`mt-2 text-3xl font-semibold tabular-nums tracking-tight ${accentMap.value}`}
          >
            {fmtUsd(amount)}
          </p>
        </div>
        <div className={`rounded-xl p-2.5 ${accentMap.icon}`}>{icon}</div>
      </div>
      <p className="mt-4 text-sm leading-relaxed text-white/50">{description}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </article>
  );
}

function StatCard({
  label,
  value,
  sub,
  icon,
}: {
  label: string;
  value: string;
  sub: string;
  icon: ReactNode;
}) {
  return (
    <div className="glass-card flex items-start gap-4 border border-glassBorder p-5 sm:p-6">
      <div className="rounded-xl border border-primary/30 bg-primary/10 p-3 text-primary">
        {icon}
      </div>
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-white/45">
          {label}
        </p>
        <p className="mt-1 text-2xl font-semibold tabular-nums text-white">
          {value}
        </p>
        <p className="mt-1 text-sm text-white/45">{sub}</p>
      </div>
    </div>
  );
}

function UserFinancialCells({ financials }: { financials: UserFinancials }) {
  return (
    <>
      <td className={`hidden whitespace-nowrap px-4 py-3 text-right tabular-nums lg:table-cell xl:px-5 ${pnlToneClass(financials.totalProfitGenerated)}`}>
        {fmtSignedUsd(financials.totalProfitGenerated)}
      </td>
      <td className="hidden whitespace-nowrap px-4 py-3 text-right tabular-nums text-white/75 lg:table-cell xl:px-5">
        {fmtUsd(financials.totalRevenueShareDue)}
      </td>
      <td className="hidden whitespace-nowrap px-4 py-3 text-right tabular-nums text-emerald-200/90 lg:table-cell xl:px-5">
        {fmtUsd(financials.totalRevenuePaid)}
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums xl:px-5">
        <span className="text-amber-200/90">
          {fmtUsd(financials.memberCommissionEarned)}
        </span>
        <span className="text-white/30"> / </span>
        <span className="text-sky-200/90">
          {fmtUsd(financials.memberCommissionPayable)}
        </span>
      </td>
    </>
  );
}

function NetworkHierarchyRow({
  node,
  defaultExpanded,
}: {
  node: NetworkNode;
  defaultExpanded: boolean;
}) {
  const hasChildren = node.children.length > 0;
  const [expanded, setExpanded] = useState(defaultExpanded);
  const indent = node.depth * 18;

  return (
    <>
      <tr className="border-b border-glassBorder/60 transition hover:bg-white/[0.02]">
        <td className="px-4 py-3.5 xl:px-5" style={{ paddingLeft: `${16 + indent}px` }}>
          <div className="flex min-w-0 items-center gap-2">
            {hasChildren ? (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="shrink-0 rounded-md p-1 text-white/45 transition hover:bg-white/10 hover:text-white"
                aria-expanded={expanded}
                aria-label={expanded ? "Collapse" : "Expand"}
              >
                {expanded ? (
                  <ChevronDown className="h-4 w-4" aria-hidden />
                ) : (
                  <ChevronRight className="h-4 w-4" aria-hidden />
                )}
              </button>
            ) : (
              <span className="inline-block w-6 shrink-0" aria-hidden />
            )}
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="truncate font-medium text-white">
                  {node.name?.trim() || node.email}
                </p>
                <span
                  className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ${roleBadgeClass(node.role)}`}
                >
                  {roleLabel(node.role, node.nodeType)}
                </span>
              </div>
              {node.name?.trim() ? (
                <p className="mt-0.5 truncate text-xs text-white/40">{node.email}</p>
              ) : null}
              {node.nodeType === "member" ? (
                <p className="mt-1 text-[11px] text-white/35">
                  {countDescendantUsers(node)} referred trader
                  {countDescendantUsers(node) === 1 ? "" : "s"} in branch
                  {hasChildren
                    ? ` · ${node.children.length} direct report${node.children.length === 1 ? "" : "s"}`
                    : ""}
                  {hasPersonalTradingActivity(node.financials)
                    ? " · personal trading account"
                    : ""}
                </p>
              ) : (
                <p className="mt-1 text-[11px] text-white/35">
                  Joined {fmtDate(node.joinedAt)}
                </p>
              )}
            </div>
          </div>
        </td>

        <UserFinancialCells financials={node.financials} />
      </tr>

      {hasChildren && expanded
        ? node.children.map((child) => (
            <NetworkHierarchyRow
              key={child.id}
              node={child}
              defaultExpanded={child.depth < 1}
            />
          ))
        : null}
    </>
  );
}

export default function PartnerDashboardPage() {
  const apiBase = useMemo(() => resolveApiBase(), []);
  const { user, token, isSalesTeamMember, salesTeamRole, refreshUser } = useAuth();

  const [metrics, setMetrics] = useState<PartnerMetrics | null>(null);
  const [network, setNetwork] = useState<NetworkDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [payoutBusy, setPayoutBusy] = useState(false);
  const [toast, setToast] = useState<{ type: "ok" | "err"; text: string } | null>(
    null,
  );
  const [nominateOpen, setNominateOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"overview" | "growth">("overview");
  const [milestoneRefreshKey, setMilestoneRefreshKey] = useState(0);

  /** Senior Managers & Managers only — never hide when header already shows Senior Manager/Manager. */
  const canNominate = useMemo(() => {
    if (salesTeamRole === "SENIOR_MANAGER" || salesTeamRole === "MANAGER") {
      return true;
    }
    if (canNominateMembers(user?.role) || canNominateMembers(network?.viewerRole)) {
      return true;
    }
    return false;
  }, [salesTeamRole, user?.role, network?.viewerRole]);

  const payoutWindowOpen = isLastDayOfUtcMonth();
  const canRequestPayout =
    (metrics?.wallets.withdrawable ?? 0) > 0 && payoutWindowOpen;

  const designation =
    salesTeamRole != null
      ? SALES_TEAM_ROLE_LABELS[salesTeamRole]
      : user?.role && isSalesTeamRole(user.role)
        ? SALES_TEAM_ROLE_LABELS[user.role as SalesTeamRole]
        : "Partner";

  const hierarchyHint = useMemo(() => {
    const role = (network?.viewerRole ?? salesTeamRole) as SalesTeamRole | undefined;
    if (role === "SENIOR_MANAGER") {
      return "Managers → Executives → Traders across your full downline";
    }
    if (role === "MANAGER") {
      return "Your Executives and their traders, plus your direct referrals";
    }
    if (role === "EXECUTIVE") {
      return "Traders who signed up with your referral code";
    }
    return "Your partner network";
  }, [network?.viewerRole, salesTeamRole]);

  const loadData = useCallback(async () => {
    if (!token) throw new Error("Not signed in");

    const headers = { Authorization: `Bearer ${token}` };
    const [metricsRes, networkRes] = await Promise.all([
      fetch(`${apiBase}/user/partner/metrics`, { headers }),
      fetch(`${apiBase}/user/partner/network-details`, { headers }),
    ]);

    if (!metricsRes.ok) {
      throw new Error(
        metricsRes.status === 403
          ? "Partner access required"
          : `Failed to load partner metrics (${metricsRes.status})`,
      );
    }
    if (!networkRes.ok) {
      throw new Error(
        networkRes.status === 403
          ? "Partner access required"
          : `Failed to load network details (${networkRes.status})`,
      );
    }

    setMetrics((await metricsRes.json()) as PartnerMetrics);
    setNetwork((await networkRes.json()) as NetworkDetails);
  }, [apiBase, token]);

  useEffect(() => {
    if (token) {
      void refreshUser();
    }
  }, [token, refreshUser]);

  useEffect(() => {
    if (!isSalesTeamMember || !token) {
      setLoading(false);
      return;
    }
    void (async () => {
      try {
        await loadData();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load partner data");
      } finally {
        setLoading(false);
      }
    })();
  }, [isSalesTeamMember, token, loadData]);

  async function handleRefresh() {
    setRefreshing(true);
    setError(null);
    try {
      await loadData();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Refresh failed");
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(t);
  }, [toast]);

  async function requestPayout() {
    if (!token || payoutBusy || !canRequestPayout) return;
    setPayoutBusy(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/user/partner/request-payout`, {
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
            : `Payout request failed (${res.status})`;
        throw new Error(msg);
      }
      setToast({
        type: "ok",
        text: "Payout request submitted. Our team will process it shortly.",
      });
      await loadData();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Payout request failed";
      setToast({ type: "err", text: msg });
      setError(msg);
    } finally {
      setPayoutBusy(false);
    }
  }

  async function copyReferralLink() {
    const code = metrics?.referralCode;
    if (!code) return;
    const url = referralSignupUrl(code);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2200);
    } catch {
      setError("Could not copy link — try selecting the URL manually.");
    }
  }

  if (!isSalesTeamMember) {
    return (
      <div className="mx-auto max-w-lg rounded-xl border border-amber-500/30 bg-amber-500/10 px-6 py-8 text-center">
        <p className="text-sm text-amber-100">
          Partner Dashboard is available only to TradeICT Earner sales team members.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-4">
          <div className="rounded-2xl border border-violet-500/30 bg-gradient-to-br from-violet-500/20 to-primary/10 p-3.5 shadow-lg shadow-violet-950/30">
            <Briefcase className="h-7 w-7 text-violet-200" aria-hidden />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">
                Partner Portal
              </h1>
              <span className="inline-flex items-center gap-1 rounded-full bg-violet-500/15 px-2.5 py-0.5 text-xs font-medium text-violet-200 ring-1 ring-violet-500/30">
                <Crown className="h-3 w-3" aria-hidden />
                Exclusive
              </span>
            </div>
            <p className="mt-1 text-sm text-white/50">
              {designation}
              {user?.name ? ` · ${user.name}` : ""}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 self-start">
          {canNominate ? (
            <NominateTeamMemberButton
              variant="secondary"
              onClick={() => setNominateOpen(true)}
            />
          ) : null}
          <button
            type="button"
            onClick={() => void handleRefresh()}
            disabled={loading || refreshing}
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-glassBorder bg-white/[0.04] px-4 py-2.5 text-sm font-medium text-white/80 transition hover:bg-white/[0.08] disabled:opacity-50"
          >
            <RefreshCw
              className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`}
              aria-hidden
            />
            Refresh
          </button>
        </div>
      </header>

      {toast ? (
        <div
          className={`rounded-xl border px-4 py-3 text-sm ${
            toast.type === "ok"
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-100"
              : "border-red-500/30 bg-red-500/10 text-red-200"
          }`}
        >
          {toast.text}
        </div>
      ) : null}

      {error && !toast ? (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2 rounded-xl border border-glassBorder bg-white/[0.03] p-1">
        <button
          type="button"
          onClick={() => setActiveTab("overview")}
          className={`inline-flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition sm:flex-none ${
            activeTab === "overview"
              ? "bg-primary/15 text-primary ring-1 ring-primary/40"
              : "text-white/60 hover:bg-white/5 hover:text-white"
          }`}
        >
          <Wallet className="h-4 w-4" aria-hidden />
          Overview
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("growth")}
          className={`inline-flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition sm:flex-none ${
            activeTab === "growth"
              ? "bg-primary/15 text-primary ring-1 ring-primary/40"
              : "text-white/60 hover:bg-white/5 hover:text-white"
          }`}
        >
          <Target className="h-4 w-4" aria-hidden />
          Milestones & Referrals
        </button>
      </div>

      {activeTab === "growth" ? (
        <section className="space-y-8">
          <MilestoneTracker
            key={milestoneRefreshKey}
            apiBase={apiBase}
            token={token}
          />
          <ReferralSubmissionForm
            apiBase={apiBase}
            token={token}
            refreshKey={milestoneRefreshKey}
            onSubmitted={() => setMilestoneRefreshKey((k) => k + 1)}
          />
        </section>
      ) : null}

      {activeTab === "overview" ? (
        <>
      {loading ? (
        <div className="flex justify-center rounded-2xl border border-glassBorder py-24">
          <Loader2 className="h-9 w-9 animate-spin text-primary" aria-label="Loading" />
        </div>
      ) : metrics ? (
        <>
          <section>
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-white/40">
              Commission wallets
            </h2>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <WalletCard
                title="Earned Revenue"
                amount={metrics.wallets.earned}
                description="Locked while traders owe revenue share. Moves to Payable when they pay their invoice."
                icon={<Lock className="h-5 w-5" aria-hidden />}
                accent="amber"
              />
              <WalletCard
                title="Payable Revenue"
                amount={metrics.wallets.payable}
                description="Trader paid — maturing through the 30-day unlock window before withdrawal."
                icon={<Timer className="h-5 w-5" aria-hidden />}
                accent="sky"
              />
              <WalletCard
                title="Withdrawable Revenue"
                amount={metrics.wallets.withdrawable}
                description="Ready for payout. Request on the last UTC day of each month."
                icon={<Wallet className="h-5 w-5" aria-hidden />}
                accent="emerald"
                action={
                  <div className="group relative">
                    <button
                      type="button"
                      onClick={() => void requestPayout()}
                      disabled={!canRequestPayout || payoutBusy}
                      title={
                        !payoutWindowOpen
                          ? "Available on the last day of the month"
                          : metrics.wallets.withdrawable <= 0
                            ? "No withdrawable balance"
                            : undefined
                      }
                      className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-500/20 px-4 py-2.5 text-sm font-semibold text-emerald-100 ring-1 ring-emerald-500/35 transition hover:bg-emerald-500/30 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {payoutBusy ? (
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                      ) : null}
                      Request Payout
                    </button>
                    {!canRequestPayout ? (
                      <p className="mt-2 text-center text-[11px] text-white/35">
                        {!payoutWindowOpen
                          ? "Available on the last day of the month"
                          : "No withdrawable balance yet"}
                      </p>
                    ) : null}
                  </div>
                }
              />
            </div>
          </section>

          <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label="Team members"
              value={String(network?.stats.totalTeamMembers ?? 0)}
              sub="Managers & executives in your downline"
              icon={<GitBranch className="h-6 w-6" aria-hidden />}
            />
            <StatCard
              label="Network traders"
              value={String(network?.stats.totalUsers ?? metrics.directAcquiredCount)}
              sub="All acquired users in your hierarchy"
              icon={<Users className="h-6 w-6" aria-hidden />}
            />
            <StatCard
              label="Network AUM"
              value={fmtUsd(metrics.networkAum)}
              sub="Live Delta balances across direct referrals"
              icon={<TrendingUp className="h-6 w-6" aria-hidden />}
            />
            <StatCard
              label="Your commission"
              value={`${fmtUsd(
                metrics?.wallets.earned ??
                  network?.stats.totalMemberCommissionEarned ??
                  0,
              )} / ${fmtUsd(
                metrics != null
                  ? metrics.wallets.payable + metrics.wallets.withdrawable
                  : (network?.stats.totalMemberCommissionPayable ?? 0),
              )}`}
              sub="Earned (EARNED) / Payable (PAYABLE + WITHDRAWABLE)"
              icon={<Wallet className="h-6 w-6" aria-hidden />}
            />
          </section>

          <section className="relative overflow-hidden rounded-2xl border border-primary/25 bg-gradient-to-r from-primary/15 via-violet-500/10 to-transparent p-6 shadow-xl sm:p-8">
            <div
              className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-primary/20 blur-3xl"
              aria-hidden
            />
            <div className="relative flex flex-col gap-6">
              <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold uppercase tracking-widest text-primary/80">
                    Your referral link
                  </p>
                  <p className="mt-2 font-mono text-lg font-medium text-white sm:text-xl">
                    {metrics.referralCode ?? "—"}
                  </p>
                  <p className="mt-2 max-w-xl text-sm text-white/50">
                    Share this code with traders. When they sign up and subscribe, you
                    earn commission on their revenue share.
                  </p>
                  {metrics.referralCode ? (
                    <p className="mt-3 truncate font-mono text-xs text-white/35">
                      {referralSignupUrl(metrics.referralCode)}
                    </p>
                  ) : null}
                </div>
                <div className="flex w-full flex-col gap-3 sm:w-auto sm:min-w-[280px]">
                  <button
                    type="button"
                    onClick={() => void copyReferralLink()}
                    disabled={!metrics.referralCode}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-primary/25 transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {copied ? (
                      <>
                        <Check className="h-4 w-4" aria-hidden />
                        Copied!
                      </>
                    ) : (
                      <>
                        <Copy className="h-4 w-4" aria-hidden />
                        Copy Link
                      </>
                    )}
                  </button>
                  {canNominate ? (
                    <NominateTeamMemberButton
                      className="w-full"
                      onClick={() => setNominateOpen(true)}
                    />
                  ) : null}
                </div>
              </div>

              {canNominate ? (
                <div className="relative rounded-xl border border-violet-500/25 bg-violet-500/10 px-4 py-4 sm:px-5">
                  <p className="text-sm font-medium text-violet-100">
                    Grow your downline
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-white/50">
                    Nominate any registered user for admin approval.
                    An admin will review and approve the upgrade.
                  </p>
                </div>
              ) : null}
            </div>
          </section>

          <section className="glass-card overflow-hidden border border-glassBorder">
            <div className="border-b border-glassBorder bg-white/[0.03] px-5 py-4 sm:px-6">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-white">
                    Network Hierarchy & Revenue
                  </h2>
                  <p className="mt-0.5 text-sm text-white/45">{hierarchyHint}</p>
                </div>
                <div className="flex flex-col gap-3 sm:items-end">
                  {canNominate ? (
                    <NominateTeamMemberButton
                      variant="secondary"
                      className="shrink-0 self-start sm:self-auto"
                      onClick={() => setNominateOpen(true)}
                    />
                  ) : null}
                  {network ? (
                  <div className="flex flex-wrap gap-3 text-xs text-white/45">
                    <span>
                      Gross profit:{" "}
                      <span
                        className={`font-medium tabular-nums ${pnlToneClass(network.stats.totalProfitGenerated)}`}
                      >
                        {fmtSignedUsd(network.stats.totalProfitGenerated)}
                      </span>
                    </span>
                    <span>
                      App revenue:{" "}
                      <span className="font-medium tabular-nums text-white/70">
                        {fmtUsd(network.stats.totalRevenueShareDue)}
                      </span>
                    </span>
                    <span>
                      Paid:{" "}
                      <span className="font-medium tabular-nums text-emerald-200/90">
                        {fmtUsd(network.stats.totalRevenuePaid)}
                      </span>
                    </span>
                  </div>
                ) : null}
                </div>
              </div>
            </div>

            {!network || network.tree.length === 0 ? (
              <div className="px-6 py-14 text-center text-sm text-white/45">
                No network traders yet. Share your referral link to grow your hierarchy.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-[920px] w-full text-left text-sm">
                  <thead className="border-b border-glassBorder bg-white/[0.02] text-[11px] uppercase tracking-wider text-white/40">
                    <tr>
                      <th className="px-4 py-3 font-medium xl:px-5">Member / Trader</th>
                      <th className="hidden px-4 py-3 text-right font-medium lg:table-cell xl:px-5">
                        Gross Profit
                      </th>
                      <th className="hidden px-4 py-3 text-right font-medium lg:table-cell xl:px-5">
                        App Revenue
                      </th>
                      <th className="hidden px-4 py-3 text-right font-medium lg:table-cell xl:px-5">
                        Revenue Paid
                      </th>
                      <th className="px-4 py-3 text-right font-medium xl:px-5">
                        Your Commission
                        <span className="mt-0.5 block text-[10px] font-normal normal-case tracking-normal text-white/30">
                          Earned / Payable
                        </span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {network.tree.map((root) => (
                      <NetworkHierarchyRow
                        key={root.id}
                        node={root}
                        defaultExpanded
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      ) : null}
        </>
      ) : null}

      <NominateMemberModal
        open={nominateOpen}
        apiBase={apiBase}
        token={token}
        onClose={() => setNominateOpen(false)}
        onSuccess={(text) => setToast({ type: "ok", text })}
        onError={(text) => setToast({ type: "err", text })}
      />
    </div>
  );
}
