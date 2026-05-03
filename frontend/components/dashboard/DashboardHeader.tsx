"use client";

import { useRouter } from "next/navigation";
import { Menu } from "lucide-react";

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
        <button
          type="button"
          onClick={handleLogout}
          className="rounded-lg border border-glassBorder bg-white/[0.04] px-4 py-2 text-sm font-medium text-white/90 transition hover:bg-white/10 hover:text-white"
        >
          Logout
        </button>
      </div>
    </header>
  );
}
