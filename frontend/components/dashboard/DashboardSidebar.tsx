"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo } from "react";
import { Briefcase, X } from "lucide-react";
import { BrandLogo } from "@/components/BrandLogo";
import { useAuth } from "@/context/AuthContext";

const baseLinks = [
  { href: "/dashboard", label: "Home" },
  { href: "/dashboard/analytics", label: "Analytics" },
  { href: "/dashboard/strategies", label: "Strategies" },
  { href: "/dashboard/live-trades", label: "Live trades" },
  { href: "/dashboard/dex-arbitrage", label: "Dex Arbitrage" },
  { href: "/dashboard/arbitrage-trades", label: "Arbitrage Trades" },
  { href: "/dashboard/trades", label: "Trades" },
  { href: "/dashboard/payments", label: "Payments" },
  { href: "/dashboard/wallet", label: "Wallet" },
  { href: "/dashboard/support", label: "Support" },
  { href: "/dashboard/settings", label: "Settings" },
] as const;

const partnerLink = {
  href: "/dashboard/partner",
  label: "Partner Dashboard",
  icon: Briefcase,
} as const;

type DashboardSidebarProps = {
  mobileOpen: boolean;
  onClose: () => void;
};

export function DashboardSidebar({ mobileOpen, onClose }: DashboardSidebarProps) {
  const pathname = usePathname();
  const { isSalesTeamMember } = useAuth();

  const links = useMemo(() => {
    if (!isSalesTeamMember) return [...baseLinks];
    return [
      baseLinks[0],
      partnerLink,
      ...baseLinks.slice(1),
    ];
  }, [isSalesTeamMember]);

  useEffect(() => {
    onClose();
  }, [pathname, onClose]);

  return (
    <aside
      className={`glass-card flex h-screen w-64 shrink-0 flex-col border border-glassBorder p-6 md:sticky md:top-0 ${
        mobileOpen
          ? "max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-50 max-md:shadow-2xl"
          : "max-md:hidden"
      }`}
    >
      <div className="mb-8 flex items-start justify-between gap-2">
        <div>
          <BrandLogo href="/dashboard" width={150} height={40} />
          <p className="mt-2 text-xs font-medium text-white/50">Dashboard</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg p-2 text-white/80 transition hover:bg-white/10 hover:text-white md:hidden"
          aria-label="Close menu"
        >
          <X className="h-5 w-5" strokeWidth={2} />
        </button>
      </div>
      <nav className="flex flex-1 flex-col gap-1">
        {links.map((item) => {
          const href = item.href;
          const label = item.label;
          const Icon = "icon" in item ? item.icon : null;
          const active =
            href === "/dashboard"
              ? pathname === "/dashboard"
              : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              onClick={() => onClose()}
              className={`rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                active
                  ? "bg-primary/15 text-primary ring-1 ring-primary/40"
                  : "text-white/70 hover:bg-white/5 hover:text-white"
              }`}
            >
              <span className="inline-flex items-center gap-2">
                {Icon ? <Icon className="h-4 w-4 shrink-0" aria-hidden /> : null}
                {label}
              </span>
            </Link>
          );
        })}
      </nav>
      <p className="mt-auto pt-6 text-xs text-white/40">
        Midnight Neon · Trader
      </p>
    </aside>
  );
}
