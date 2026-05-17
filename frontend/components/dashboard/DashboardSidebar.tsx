"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { X } from "lucide-react";

const links = [
  { href: "/dashboard", label: "Home" },
  { href: "/dashboard/analytics", label: "Analytics" },
  { href: "/dashboard/strategies", label: "Strategies" },
  { href: "/dashboard/live-trades", label: "Live trades" },
  { href: "/dashboard/dex-arbitrage", label: "Dex Arbitrage" },
  { href: "/dashboard/trades", label: "Trades" },
  { href: "/dashboard/payments", label: "Payments" },
  { href: "/dashboard/wallet", label: "Wallet" },
  { href: "/dashboard/settings", label: "Settings" },
];

type DashboardSidebarProps = {
  mobileOpen: boolean;
  onClose: () => void;
};

export function DashboardSidebar({ mobileOpen, onClose }: DashboardSidebarProps) {
  const pathname = usePathname();

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
          <p className="text-xs font-medium uppercase tracking-widest text-primary">
            TradeICT
          </p>
          <h1 className="mt-1 text-lg font-semibold text-white">Dashboard</h1>
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
        {links.map(({ href, label }) => {
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
              {label}
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
