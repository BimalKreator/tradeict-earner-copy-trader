"use client";

import { Award, Loader2, Save } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { resolveApiBase } from "@/lib/apiBase";
import { SALES_TEAM_ROLE_LABELS, type SalesTeamRole } from "@/lib/roles";

type TierLevel = SalesTeamRole;

type TierConfigForm = {
  id: string;
  tierLevel: TierLevel;
  directCommissionRate: string;
  teamCommissionRate: string;
  networkCommissionRate: string;
  minReferralsRequired: string;
  benefitsText: string;
};

const TIER_ORDER: TierLevel[] = ["EXECUTIVE", "MANAGER", "SENIOR_MANAGER"];

const TIER_CARD_ACCENT: Record<TierLevel, string> = {
  EXECUTIVE: "border-sky-500/30 bg-sky-500/5",
  MANAGER: "border-amber-500/30 bg-amber-500/5",
  SENIOR_MANAGER: "border-violet-500/30 bg-violet-500/5",
};

function benefitsToText(benefits: string[]): string {
  return benefits.join("\n");
}

function textToBenefits(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function mapApiTier(row: {
  id?: string;
  tierLevel: TierLevel;
  directCommissionRate: number;
  teamCommissionRate: number;
  networkCommissionRate: number;
  minReferralsRequired: number;
  benefits?: string[];
}): TierConfigForm {
  return {
    id: row.id ?? "",
    tierLevel: row.tierLevel,
    directCommissionRate: String(row.directCommissionRate),
    teamCommissionRate: String(row.teamCommissionRate),
    networkCommissionRate: String(row.networkCommissionRate),
    minReferralsRequired: String(row.minReferralsRequired),
    benefitsText: benefitsToText(row.benefits ?? []),
  };
}

function authHeaders(token: string | null): HeadersInit {
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export default function AdminTierSettingsPage() {
  const apiBase = useMemo(() => resolveApiBase(), []);
  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;

  const [tiers, setTiers] = useState<TierConfigForm[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) {
      setError("Not signed in");
      return;
    }
    const res = await fetch(`${apiBase}/admin/tier-config`, {
      headers: authHeaders(token),
    });
    if (!res.ok) {
      throw new Error(`Failed to load tier config (${res.status})`);
    }
    const data = (await res.json()) as {
      tiers: Array<{
        id: string;
        tierLevel: TierLevel;
        directCommissionRate: number;
        teamCommissionRate: number;
        networkCommissionRate: number;
        minReferralsRequired: number;
        benefits: string[];
      }>;
    };

    const mapped = (data.tiers ?? []).map(mapApiTier);
    const byLevel = new Map(mapped.map((t) => [t.tierLevel, t]));
    setTiers(
      TIER_ORDER.map(
        (level) =>
          byLevel.get(level) ??
          mapApiTier({
            tierLevel: level,
            directCommissionRate: 5,
            teamCommissionRate: 2,
            networkCommissionRate: 1,
            minReferralsRequired: level === "EXECUTIVE" ? 0 : 10,
            benefits: [],
          }),
      ),
    );
  }, [apiBase, token]);

  useEffect(() => {
    void (async () => {
      try {
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load tier settings");
      } finally {
        setLoading(false);
      }
    })();
  }, [load]);

  useEffect(() => {
    if (!success) return;
    const t = window.setTimeout(() => setSuccess(null), 3500);
    return () => window.clearTimeout(t);
  }, [success]);

  function updateTier(level: TierLevel, patch: Partial<TierConfigForm>) {
    setTiers((prev) =>
      prev.map((t) => (t.tierLevel === level ? { ...t, ...patch } : t)),
    );
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!token || saving) return;
    setSaving(true);
    setError(null);
    setSuccess(null);

    try {
      const payload = {
        tiers: tiers.map((t) => ({
          tierLevel: t.tierLevel,
          directCommissionRate: Number.parseFloat(t.directCommissionRate),
          teamCommissionRate: Number.parseFloat(t.teamCommissionRate),
          networkCommissionRate: Number.parseFloat(t.networkCommissionRate),
          minReferralsRequired: Number.parseInt(t.minReferralsRequired, 10),
          benefits: textToBenefits(t.benefitsText),
        })),
      };

      const res = await fetch(`${apiBase}/admin/tier-config`, {
        method: "PUT",
        headers: authHeaders(token),
        body: JSON.stringify(payload),
      });
      const body: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg =
          typeof body === "object" &&
          body !== null &&
          "error" in body &&
          typeof (body as { error?: unknown }).error === "string"
            ? (body as { error: string }).error
            : `Save failed (${res.status})`;
        throw new Error(msg);
      }

      if (
        typeof body === "object" &&
        body !== null &&
        "tiers" in body &&
        Array.isArray((body as { tiers: unknown }).tiers)
      ) {
        const saved = (body as { tiers: Parameters<typeof mapApiTier>[0][] }).tiers;
        setTiers(saved.map(mapApiTier));
      } else {
        await load();
      }

      setSuccess("Tier settings saved successfully.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex items-start gap-4">
        <div className="rounded-xl border border-violet-500/30 bg-violet-500/10 p-3">
          <Award className="h-7 w-7 text-violet-300" aria-hidden />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">
            Tier Settings
          </h1>
          <p className="mt-1 text-sm text-white/50">
            Commission rates, referral milestones, and benefits for each partner tier
          </p>
        </div>
      </header>

      {success ? (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">
          {success}
        </div>
      ) : null}

      {error ? (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-primary" aria-label="Loading" />
        </div>
      ) : (
        <form onSubmit={(e) => void handleSave(e)} className="space-y-6">
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
            {tiers.map((tier) => (
              <div
                key={tier.tierLevel}
                className={`glass-card rounded-xl border p-5 ${TIER_CARD_ACCENT[tier.tierLevel]}`}
              >
                <h2 className="text-lg font-semibold text-white">
                  {SALES_TEAM_ROLE_LABELS[tier.tierLevel]}
                </h2>
                <p className="mt-1 text-xs text-white/45">
                  Promotion requires{" "}
                  <span className="font-medium text-white/70">
                    {tier.minReferralsRequired || "0"}
                  </span>{" "}
                  active direct referrals (when upgrading to this tier)
                </p>

                <div className="mt-5 space-y-4">
                  <label className="block">
                    <span className="text-xs font-medium text-white/55">
                      Direct commission (%)
                    </span>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      step={0.01}
                      value={tier.directCommissionRate}
                      onChange={(e) =>
                        updateTier(tier.tierLevel, {
                          directCommissionRate: e.target.value,
                        })
                      }
                      className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40"
                    />
                  </label>

                  <label className="block">
                    <span className="text-xs font-medium text-white/55">
                      Team commission (%)
                    </span>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      step={0.01}
                      value={tier.teamCommissionRate}
                      onChange={(e) =>
                        updateTier(tier.tierLevel, {
                          teamCommissionRate: e.target.value,
                        })
                      }
                      className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40"
                    />
                  </label>

                  <label className="block">
                    <span className="text-xs font-medium text-white/55">
                      Network commission (%)
                    </span>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      step={0.01}
                      value={tier.networkCommissionRate}
                      onChange={(e) =>
                        updateTier(tier.tierLevel, {
                          networkCommissionRate: e.target.value,
                        })
                      }
                      className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40"
                    />
                  </label>

                  <label className="block">
                    <span className="text-xs font-medium text-white/55">
                      Min referrals required
                    </span>
                    <input
                      type="number"
                      min={0}
                      step={1}
                      value={tier.minReferralsRequired}
                      onChange={(e) =>
                        updateTier(tier.tierLevel, {
                          minReferralsRequired: e.target.value,
                        })
                      }
                      className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40"
                    />
                  </label>

                  <label className="block">
                    <span className="text-xs font-medium text-white/55">
                      Benefits (one per line or comma-separated)
                    </span>
                    <textarea
                      rows={4}
                      value={tier.benefitsText}
                      onChange={(e) =>
                        updateTier(tier.tierLevel, { benefitsText: e.target.value })
                      }
                      placeholder="Direct client commissions&#10;Partner dashboard access"
                      className="mt-1 w-full resize-y rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40"
                    />
                  </label>
                </div>
              </div>
            ))}
          </div>

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-2 rounded-xl border border-primary/40 bg-primary/15 px-5 py-2.5 text-sm font-semibold text-primary transition hover:bg-primary/25 disabled:opacity-50"
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Save className="h-4 w-4" aria-hidden />
              )}
              Save all tiers
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
