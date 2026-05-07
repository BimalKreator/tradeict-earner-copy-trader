"use client";

import { NotificationBell } from "@/components/common/NotificationBell";

export function AdminHeader() {
  return (
    <header className="mb-6 flex items-center justify-between rounded-xl border border-glassBorder bg-white/[0.03] px-4 py-3">
      <div>
        <p className="text-xs uppercase tracking-wider text-white/45">Admin Console</p>
        <p className="text-sm font-medium text-white">Operations & Moderation</p>
      </div>
      <NotificationBell />
    </header>
  );
}

