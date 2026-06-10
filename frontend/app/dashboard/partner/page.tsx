"use client";

import { Briefcase } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { SALES_TEAM_ROLE_LABELS } from "@/lib/roles";

export default function PartnerDashboardPlaceholderPage() {
  const { user, isSalesTeamMember, salesTeamRole } = useAuth();

  if (!isSalesTeamMember) {
    return (
      <div className="mx-auto max-w-lg rounded-xl border border-amber-500/30 bg-amber-500/10 px-6 py-8 text-center">
        <p className="text-sm text-amber-100">
          Partner Dashboard is available only to TradeICT Earner sales team members.
        </p>
      </div>
    );
  }

  const designation =
    salesTeamRole != null ? SALES_TEAM_ROLE_LABELS[salesTeamRole] : "Partner";

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header className="flex items-start gap-4">
        <div className="rounded-xl border border-primary/30 bg-primary/10 p-3">
          <Briefcase className="h-7 w-7 text-primary" aria-hidden />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">
            Partner Dashboard
          </h1>
          <p className="mt-1 text-sm text-white/55">
            {designation}
            {user?.name ? ` · ${user.name}` : ""}
          </p>
        </div>
      </header>

      <div className="glass-card border border-glassBorder px-8 py-14 text-center">
        <p className="text-lg font-medium text-white/90">
          Partner Dashboard — Coming in Phase 8
        </p>
        <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-white/50">
          Network analytics, commission wallets, referral tools, and downline stats
          will appear here soon.
        </p>
      </div>
    </div>
  );
}
