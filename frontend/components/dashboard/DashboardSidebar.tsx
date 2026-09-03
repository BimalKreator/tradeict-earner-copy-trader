"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { BrandLogo } from "@/components/BrandLogo";
import { useAuth } from "@/context/AuthContext";
import {
  isNavLinkActive,
  visibleDashboardNavGroups,
} from "@/lib/dashboardNav";

export function DashboardSidebar() {
  const pathname = usePathname();
  const { isSalesTeamMember, user } = useAuth();
  const [hash, setHash] = useState("");

  useEffect(() => {
    const syncHash = () => setHash(window.location.hash);
    syncHash();
    window.addEventListener("hashchange", syncHash);
    return () => window.removeEventListener("hashchange", syncHash);
  }, [pathname]);

  const groups = visibleDashboardNavGroups(
    isSalesTeamMember,
    user?.arbAccess === true,
  );

  return (
    <aside className="glass-card hidden h-screen w-64 shrink-0 flex-col border border-glassBorder p-6 md:sticky md:top-0 md:flex">
      <div className="mb-8">
        <BrandLogo href="/dashboard" width={150} height={40} />
        <p className="mt-2 text-xs font-medium text-white/50">Dashboard</p>
      </div>
      <nav className="flex flex-1 flex-col gap-5 overflow-y-auto">
        {groups.map((group) => (
          <div key={group.id}>
            <p className="px-3 text-[11px] font-semibold uppercase tracking-wider text-white/40">
              {group.label}
            </p>
            <ul className="mt-1.5 flex flex-col gap-0.5">
              {group.links.map((link) => {
                const active = isNavLinkActive(pathname, hash, link.href);
                return (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      className={`block rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                        active
                          ? "bg-primary/15 text-primary ring-1 ring-primary/40"
                          : "text-white/70 hover:bg-white/5 hover:text-white"
                      }`}
                    >
                      {link.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
      <p className="mt-auto pt-6 text-xs text-white/40">Midnight Neon · Trader</p>
    </aside>
  );
}
