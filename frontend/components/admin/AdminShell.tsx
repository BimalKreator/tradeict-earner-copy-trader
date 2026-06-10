"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { AdminHeader } from "@/components/admin/AdminHeader";
import { AdminSidebar } from "@/components/admin/AdminSidebar";

export function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [isMobileOpen, setIsMobileOpen] = useState(false);

  const closeMobile = useCallback(() => setIsMobileOpen(false), []);
  const openMobile = useCallback(() => setIsMobileOpen(true), []);

  useEffect(() => {
    closeMobile();
  }, [pathname, closeMobile]);

  useEffect(() => {
    if (!isMobileOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [isMobileOpen]);

  return (
    <div className="flex min-h-screen w-full max-w-[100vw] overflow-x-hidden bg-background">
      <AdminSidebar isMobileOpen={isMobileOpen} onClose={closeMobile} />

      {isMobileOpen ? (
        <button
          type="button"
          aria-label="Close navigation menu"
          className="fixed inset-0 z-40 bg-black/70 backdrop-blur-[2px] md:hidden"
          onClick={closeMobile}
        />
      ) : null}

      <main className="min-w-0 flex-1 w-full max-w-full overflow-x-hidden overflow-y-auto p-4 sm:p-6 md:p-8 lg:p-10">
        <div className="mx-auto w-full min-w-0 max-w-full">
          <AdminHeader onMenuClick={openMobile} />
          <div className="admin-content w-full min-w-0 max-w-full overflow-x-hidden">
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}
