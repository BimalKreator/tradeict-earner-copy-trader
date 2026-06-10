"use client";

import {
  Briefcase,
  Check,
  Copy,
  Crown,
  Loader2,
  Lock,
  RefreshCw,
  Timer,
  TrendingUp,
  Users,
  Wallet,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { resolveApiBase } from "@/lib/apiBase";
import { SALES_TEAM_ROLE_LABELS } from "@/lib/roles";

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

type DirectUser = {
  id: string;
  name: string | null;
  email: string;
  joinedAt: string;
  strategyStatus: string;
  currentBalance: number | null;
  deltaConnected: boolean;
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

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function referralSignupUrl(code: string): string {
  const origin =
    typeof window !== "undefined"
      ? window.location.origin.replace(/\/$/, "")
      : (process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/$/, "") ??
        "https://tradeict.com");
  return `${origin}/signup?ref=${encodeURIComponent(code)}`;
}

function WalletCard({
  title,
  amount,
  description,
  icon,
  accent,
}: {
  title: string;
  amount: number;
  description: string;
  icon: ReactNode;
  accent: "amber" | "sky" | "emerald";
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

export default function PartnerDashboardPage() {
  const apiBase = useMemo(() => resolveApiBase(), []);
  const { user, token, isSalesTeamMember, salesTeamRole } = useAuth();

  const [metrics, setMetrics] = useState<PartnerMetrics | null>(null);
  const [directUsers, setDirectUsers] = useState<DirectUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const designation =
    salesTeamRole != null ? SALES_TEAM_ROLE_LABELS[salesTeamRole] : "Partner";

  const loadData = useCallback(async () => {
    if (!token) throw new Error("Not signed in");

    const headers = { Authorization: `Bearer ${token}` };
    const [metricsRes, usersRes] = await Promise.all([
      fetch(`${apiBase}/user/partner/metrics`, { headers }),
      fetch(`${apiBase}/user/partner/direct-users`, { headers }),
    ]);

    if (!metricsRes.ok) {
      throw new Error(
        metricsRes.status === 403
          ? "Partner access required"
          : `Failed to load partner metrics (${metricsRes.status})`,
      );
    }
    if (!usersRes.ok) {
      throw new Error(`Failed to load direct users (${usersRes.status})`);
    }

    setMetrics((await metricsRes.json()) as PartnerMetrics);
    const usersBody = (await usersRes.json()) as { users: DirectUser[] };
    setDirectUsers(usersBody.users ?? []);
  }, [apiBase, token]);

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

        <button
          type="button"
          onClick={() => void handleRefresh()}
          disabled={loading || refreshing}
          className="inline-flex items-center justify-center gap-2 self-start rounded-xl border border-glassBorder bg-white/[0.04] px-4 py-2.5 text-sm font-medium text-white/80 transition hover:bg-white/[0.08] disabled:opacity-50"
        >
          <RefreshCw
            className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`}
            aria-hidden
          />
          Refresh
        </button>
      </header>

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center rounded-2xl border border-glassBorder py-24">
          <Loader2 className="h-9 w-9 animate-spin text-primary" aria-label="Loading" />
        </div>
      ) : metrics ? (
        <>
          <section className="relative overflow-hidden rounded-2xl border border-primary/25 bg-gradient-to-r from-primary/15 via-violet-500/10 to-transparent p-6 shadow-xl sm:p-8">
            <div
              className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-primary/20 blur-3xl"
              aria-hidden
            />
            <div className="relative flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
              <div>
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
              </div>
              <button
                type="button"
                onClick={() => void copyReferralLink()}
                disabled={!metrics.referralCode}
                className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-primary px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-primary/25 transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
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
            </div>
            {metrics.referralCode ? (
              <p className="relative mt-4 truncate font-mono text-xs text-white/35">
                {referralSignupUrl(metrics.referralCode)}
              </p>
            ) : null}
          </section>

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
                description="Ready for payout. Withdrawal requests will be available in a future update."
                icon={<Wallet className="h-5 w-5" aria-hidden />}
                accent="emerald"
              />
            </div>
          </section>

          <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <StatCard
              label="Direct users acquired"
              value={String(metrics.directAcquiredCount)}
              sub="Traders who signed up with your referral code"
              icon={<Users className="h-6 w-6" aria-hidden />}
            />
            <StatCard
              label="Network AUM"
              value={fmtUsd(metrics.networkAum)}
              sub="Live Delta balances across your direct referrals"
              icon={<TrendingUp className="h-6 w-6" aria-hidden />}
            />
          </section>

          <section className="glass-card overflow-hidden border border-glassBorder">
            <div className="border-b border-glassBorder bg-white/[0.03] px-5 py-4 sm:px-6">
              <h2 className="text-lg font-semibold text-white">Direct users</h2>
              <p className="mt-0.5 text-sm text-white/45">
                Everyone who joined through your referral link
              </p>
            </div>

            {directUsers.length === 0 ? (
              <div className="px-6 py-14 text-center text-sm text-white/45">
                No direct referrals yet. Share your link to start building your network.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-left text-sm">
                  <thead className="border-b border-glassBorder bg-white/[0.02] text-xs uppercase tracking-wider text-white/40">
                    <tr>
                      <th className="px-5 py-3 font-medium sm:px-6">User</th>
                      <th className="px-5 py-3 font-medium sm:px-6">Joined</th>
                      <th className="px-5 py-3 font-medium sm:px-6">Strategy</th>
                      <th className="px-5 py-3 font-medium text-right sm:px-6">
                        Delta balance
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-glassBorder/80">
                    {directUsers.map((row) => (
                      <tr
                        key={row.id}
                        className="transition hover:bg-white/[0.02]"
                      >
                        <td className="px-5 py-4 sm:px-6">
                          <p className="font-medium text-white">
                            {row.name?.trim() || "—"}
                          </p>
                          <p className="mt-0.5 text-xs text-white/45">{row.email}</p>
                        </td>
                        <td className="whitespace-nowrap px-5 py-4 text-white/70 sm:px-6">
                          {fmtDate(row.joinedAt)}
                        </td>
                        <td className="max-w-[200px] px-5 py-4 text-white/65 sm:max-w-xs sm:px-6">
                          {row.strategyStatus}
                        </td>
                        <td className="whitespace-nowrap px-5 py-4 text-right tabular-nums sm:px-6">
                          {row.currentBalance != null ? (
                            <span className="text-white">{fmtUsd(row.currentBalance)}</span>
                          ) : row.deltaConnected ? (
                            <span className="text-white/35">Unavailable</span>
                          ) : (
                            <span className="text-white/35">Not connected</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
