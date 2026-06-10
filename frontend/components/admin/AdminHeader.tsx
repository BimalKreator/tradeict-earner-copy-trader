"use client";

import { NotificationBell } from "@/components/common/NotificationBell";
import { Menu } from "lucide-react";

type AdminHeaderProps = {
  onMenuClick: () => void;
};

export function AdminHeader({ onMenuClick }: AdminHeaderProps) {
  return (
    <header className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-glassBorder bg-white/[0.03] px-3 py-2.5 sm:mb-6 sm:px-4 sm:py-3">
      <div className="flex min-w-0 items-center gap-3">
        <button
          type="button"
          aria-label="Open navigation menu"
          onClick={onMenuClick}
          className="shrink-0 rounded-lg border border-white/15 bg-white/[0.06] p-2.5 text-white/90 transition hover:bg-white/10 md:hidden"
        >
          <Menu className="h-5 w-5" aria-hidden />
        </button>
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wider text-white/45">
            Admin Console
          </p>
          <p className="truncate text-sm font-medium text-white">
            Operations & Moderation
          </p>
        </div>
      </div>
      <NotificationBell />
    </header>
  );
}
