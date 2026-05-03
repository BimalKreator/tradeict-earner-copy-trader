"use client";

import { useCallback, useEffect, useState } from "react";
import { DashboardHeader } from "@/components/dashboard/DashboardHeader";
import { DashboardSidebar } from "@/components/dashboard/DashboardSidebar";

export function DashboardShell({ children }: Readonly<{ children: React.ReactNode }>) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const closeMobileNav = useCallback(() => setMobileNavOpen(false), []);
  const toggleMobileNav = useCallback(() => setMobileNavOpen((open) => !open), []);

  useEffect(() => {
    if (!mobileNavOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") closeMobileNav();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mobileNavOpen, closeMobileNav]);

  return (
    <div className="flex min-h-screen bg-background">
      {mobileNavOpen ? (
        <div
          className="fixed inset-0 z-[45] bg-black/60 md:hidden"
          onClick={closeMobileNav}
          aria-hidden
        />
      ) : null}
      <DashboardSidebar mobileOpen={mobileNavOpen} onClose={closeMobileNav} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <DashboardHeader onMenuClick={toggleMobileNav} mobileNavOpen={mobileNavOpen} />
        <main className="flex-1 overflow-auto p-6 md:p-8 lg:p-10">
          <div className="mx-auto max-w-6xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
