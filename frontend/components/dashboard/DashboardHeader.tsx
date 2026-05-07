"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Menu, User } from "lucide-react";
import { NotificationBell } from "@/components/common/NotificationBell";

type DashboardHeaderProps = {
  onMenuClick: () => void;
  mobileNavOpen: boolean;
};

export function DashboardHeader({ onMenuClick, mobileNavOpen }: DashboardHeaderProps) {
  const router = useRouter();

  function handleLogout() {
    localStorage.removeItem("token");
    router.push("/login");
  }

  return (
    <header className="glass-nav sticky top-0 z-40 px-6 py-4 md:px-8 lg:px-10">
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            onClick={onMenuClick}
            className="shrink-0 rounded-lg border border-glassBorder bg-white/[0.04] p-2 text-white/90 transition hover:bg-white/10 md:hidden"
            aria-label={mobileNavOpen ? "Close menu" : "Open menu"}
            aria-expanded={mobileNavOpen}
          >
            <Menu className="h-5 w-5" strokeWidth={2} />
          </button>
          <div className="min-w-0">
            <span className="text-xs font-medium uppercase tracking-widest text-primary">
              TradeICT
            </span>
            <p className="text-lg font-semibold leading-tight text-white">
              TradeICT Earner
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <NotificationBell />
          <Link
            href="/dashboard/profile"
            className="inline-flex items-center gap-2 rounded-lg border border-glassBorder bg-white/[0.04] px-4 py-2 text-sm font-medium text-white/90 transition hover:bg-white/10 hover:text-white"
          >
            <User className="h-4 w-4 opacity-90" aria-hidden />
            Profile
          </Link>
          <button
            type="button"
            onClick={handleLogout}
            className="rounded-lg border border-glassBorder bg-white/[0.04] px-4 py-2 text-sm font-medium text-white/90 transition hover:bg-white/10 hover:text-white"
          >
            Logout
          </button>
        </div>
      </div>
    </header>
  );
}
