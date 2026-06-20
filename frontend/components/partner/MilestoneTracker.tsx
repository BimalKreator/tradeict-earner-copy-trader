"use client";

import {
  Award,
  Bike,
  Car,
  CheckCircle2,
  DollarSign,
  Gift,
  Laptop,
  Loader2,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { SALES_TEAM_ROLE_LABELS, type SalesTeamRole } from "@/lib/roles";

export type PartnerTierInfo = {
  currentRole: SalesTeamRole;
  activeDirectReferrals: number;
  nextTier: SalesTeamRole | null;
  nextTierMinReferrals: number | null;
  tiers: Array<{
    tierLevel: SalesTeamRole;
    directCommissionRate: number;
    teamCommissionRate: number;
    networkCommissionRate: number;
    minReferralsRequired: number;
    benefits: string[];
  }>;
};

type TierCardStatus = "unlocked" | "in_progress" | "locked";

const TIER_RANK: Record<SalesTeamRole, number> = {
  EXECUTIVE: 0,
  MANAGER: 1,
  SENIOR_MANAGER: 2,
};

const STATUS_STYLES: Record<
  TierCardStatus,
  { card: string; badge: string; badgeLabel: string }
> = {
  unlocked: {
    card: "border-emerald-500/40 bg-emerald-500/[0.07] ring-emerald-500/20",
    badge: "bg-emerald-500/15 text-emerald-200 ring-emerald-500/35",
    badgeLabel: "Unlocked",
  },
  in_progress: {
    card: "border-primary/45 bg-primary/[0.08] ring-primary/30 shadow-lg shadow-primary/10",
    badge: "bg-primary/15 text-primary ring-primary/40",
    badgeLabel: "In Progress",
  },
  locked: {
    card: "border-white/10 bg-white/[0.02] opacity-75 ring-white/5",
    badge: "bg-white/10 text-white/45 ring-white/15",
    badgeLabel: "Locked",
  },
};

function benefitIcon(text: string, index: number) {
  const lower = text.toLowerCase();
  if (lower.includes("laptop")) return Laptop;
  if (lower.includes("motor") || lower.includes("car")) return Car;
  if (lower.includes("bike") || lower.includes("cycle")) return Bike;
  if (lower.includes("commission") || lower.includes("revenue") || lower.includes("$")) {
    return DollarSign;
  }
  if (lower.includes("gift") || lower.includes("reward") || lower.includes("incentive")) {
    return Gift;
  }
  return [Award, Sparkles, Gift, DollarSign][index % 4]!;
}

function tierStatus(
  tier: SalesTeamRole,
  currentRole: SalesTeamRole,
  nextTier: SalesTeamRole | null,
): TierCardStatus {
  const tierRank = TIER_RANK[tier];
  const currentRank = TIER_RANK[currentRole];
  if (tierRank <= currentRank) return "unlocked";
  if (nextTier && tier === nextTier) return "in_progress";
  return "locked";
}

type MilestoneTrackerProps = {
  apiBase: string;
  token: string | null;
};

export function MilestoneTracker({ apiBase, token }: MilestoneTrackerProps) {
  const [info, setInfo] = useState<PartnerTierInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) {
      setError("Not signed in");
      return;
    }
    const res = await fetch(`${apiBase}/user/partner/tier-info`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(
        res.status === 403
          ? "Partner access required"
          : `Failed to load tier info (${res.status})`,
      );
    }
    setInfo((await res.json()) as PartnerTierInfo);
  }, [apiBase, token]);

  useEffect(() => {
    void (async () => {
      try {
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load milestones");
      } finally {
        setLoading(false);
      }
    })();
  }, [load]);

  const progress = useMemo(() => {
    if (!info?.nextTier || info.nextTierMinReferrals == null) {
      return { pct: 100, label: "Top tier achieved", current: info?.activeDirectReferrals ?? 0, target: 0 };
    }
    const target = Math.max(1, info.nextTierMinReferrals);
    const current = info.activeDirectReferrals;
    const pct = Math.min(100, Math.round((current / target) * 100));
    return {
      pct,
      current,
      target,
      label: `${current} / ${target} active referrals to become ${SALES_TEAM_ROLE_LABELS[info.nextTier]}`,
    };
  }, [info]);

  if (loading) {
    return (
      <div className="flex justify-center rounded-2xl border border-glassBorder py-16">
        <Loader2 className="h-8 w-8 animate-spin text-primary" aria-label="Loading milestones" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
        {error}
      </div>
    );
  }

  if (!info) return null;

  const sortedTiers = [...info.tiers].sort(
    (a, b) => TIER_RANK[a.tierLevel] - TIER_RANK[b.tierLevel],
  );

  return (
    <div className="space-y-6">
      <div className="relative overflow-hidden rounded-2xl border border-primary/25 bg-gradient-to-br from-primary/10 via-violet-500/5 to-transparent p-6 sm:p-8">
        <div
          className="pointer-events-none absolute -right-20 top-0 h-40 w-40 rounded-full bg-primary/20 blur-3xl"
          aria-hidden
        />
        <div className="relative">
          <div className="flex flex-wrap items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" aria-hidden />
            <h2 className="text-lg font-semibold text-white">Your milestone journey</h2>
            <span
              className={`ml-auto inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ${STATUS_STYLES.unlocked.badge}`}
            >
              {SALES_TEAM_ROLE_LABELS[info.currentRole]}
            </span>
          </div>
          <p className="mt-2 text-sm text-white/50">
            Active referrals = traders you referred with an active strategy subscription.
          </p>

          <div className="mt-6">
            <div className="mb-2 flex items-end justify-between gap-3 text-sm">
              <span className="font-medium text-white/80">{progress.label}</span>
              <span className="tabular-nums text-primary">{progress.pct}%</span>
            </div>
            <div className="h-3 overflow-hidden rounded-full bg-white/10 ring-1 ring-white/10">
              <div
                className="h-full rounded-full bg-gradient-to-r from-primary via-violet-400 to-emerald-400 transition-all duration-700 ease-out"
                style={{ width: `${progress.pct}%` }}
              />
            </div>
            {info.nextTier ? (
              <p className="mt-2 text-xs text-white/40">
                Next level:{" "}
                <span className="font-medium text-white/60">
                  {SALES_TEAM_ROLE_LABELS[info.nextTier]}
                </span>
              </p>
            ) : (
              <p className="mt-2 text-xs text-emerald-300/80">
                You&apos;ve reached the highest partner tier — keep growing your network!
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {sortedTiers.map((tier) => {
          const status = tierStatus(tier.tierLevel, info.currentRole, info.nextTier);
          const styles = STATUS_STYLES[status];
          return (
            <article
              key={tier.tierLevel}
              className={`relative flex flex-col rounded-2xl border p-5 ring-1 transition ${styles.card}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h3 className="text-base font-semibold text-white">
                    {SALES_TEAM_ROLE_LABELS[tier.tierLevel]}
                  </h3>
                  <p className="mt-1 text-xs text-white/45">
                    {tier.minReferralsRequired > 0
                      ? `${tier.minReferralsRequired}+ active referrals`
                      : "Entry tier"}
                  </p>
                </div>
                <span
                  className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ${styles.badge}`}
                >
                  {status === "unlocked" ? (
                    <CheckCircle2 className="h-3 w-3" aria-hidden />
                  ) : null}
                  {styles.badgeLabel}
                </span>
              </div>

              <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                <div className="rounded-lg bg-black/25 px-2 py-2">
                  <p className="text-[10px] uppercase text-white/40">Direct</p>
                  <p className="mt-0.5 text-sm font-semibold tabular-nums text-white">
                    {tier.directCommissionRate}%
                  </p>
                </div>
                <div className="rounded-lg bg-black/25 px-2 py-2">
                  <p className="text-[10px] uppercase text-white/40">Team</p>
                  <p className="mt-0.5 text-sm font-semibold tabular-nums text-white">
                    {tier.teamCommissionRate}%
                  </p>
                </div>
                <div className="rounded-lg bg-black/25 px-2 py-2">
                  <p className="text-[10px] uppercase text-white/40">Network</p>
                  <p className="mt-0.5 text-sm font-semibold tabular-nums text-white">
                    {tier.networkCommissionRate}%
                  </p>
                </div>
              </div>

              <ul className="mt-4 flex-1 space-y-2.5">
                {tier.benefits.length === 0 ? (
                  <li className="text-xs text-white/35">Benefits coming soon</li>
                ) : (
                  tier.benefits.map((benefit, idx) => {
                    const Icon = benefitIcon(benefit, idx);
                    return (
                      <li
                        key={`${tier.tierLevel}-${idx}`}
                        className="flex items-start gap-2.5 text-sm text-white/75"
                      >
                        <span
                          className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${
                            status === "locked"
                              ? "bg-white/5 text-white/30"
                              : status === "in_progress"
                                ? "bg-primary/15 text-primary"
                                : "bg-emerald-500/15 text-emerald-300"
                          }`}
                        >
                          <Icon className="h-3.5 w-3.5" aria-hidden />
                        </span>
                        <span className="leading-snug">{benefit}</span>
                      </li>
                    );
                  })
                )}
              </ul>
            </article>
          );
        })}
      </div>
    </div>
  );
}
