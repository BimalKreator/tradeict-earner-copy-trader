"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import {
  resolveActiveNavGroup,
  visibleDashboardNavGroups,
} from "@/lib/dashboardNav";

export function BottomTabBar() {
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
  const activeGroup = resolveActiveNavGroup(pathname, hash);

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 border-t border-white/10 bg-gray-950/95 backdrop-blur-md md:hidden"
      aria-label="Main navigation"
    >
      <div
        className="mx-auto flex h-14 max-w-lg items-stretch justify-around pl-[max(0px,env(safe-area-inset-left))] pr-[max(0px,env(safe-area-inset-right))]"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {groups.map((group) => {
          const Icon = group.tabIcon;
          const active = activeGroup === group.id;
          return (
            <Link
              key={group.id}
              href={group.tabHref}
              className={`flex min-h-[44px] min-w-[44px] flex-1 flex-col items-center justify-center gap-0.5 px-1 transition-colors ${
                active
                  ? "text-primary"
                  : "text-white/50 hover:text-white/75"
              }`}
              aria-current={active ? "page" : undefined}
            >
              <Icon
                className={`h-5 w-5 shrink-0 ${active ? "stroke-[2.5]" : "stroke-2"}`}
                aria-hidden
              />
              <span
                className={`max-w-full truncate text-[11px] leading-tight ${
                  active ? "font-semibold" : "font-medium"
                }`}
              >
                {group.label}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
