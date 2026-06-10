"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { BrandLogo } from "@/components/BrandLogo";
import { useAuth } from "@/context/AuthContext";
import {
  Banknote,
  BarChart3,
  Bell,
  ChevronDown,
  Download,
  FolderOpen,
  GitBranch,
  GitCompare,
  LayoutDashboard,
  LineChart,
  MessageSquare,
  Radio,
  Settings,
  Tag,
  Users,
  UsersRound,
  Wallet,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
};

type NavGroup = {
  id: string;
  label: string;
  items: NavItem[];
};

const navGroups: NavGroup[] = [
  {
    id: "overview",
    label: "Overview",
    items: [{ href: "/admin", label: "Dashboard", icon: LayoutDashboard }],
  },
  {
    id: "trading",
    label: "Trading & Operations",
    items: [
      { href: "/admin/live-trades", label: "Live Trades", icon: Radio },
      { href: "/admin/trade-history", label: "Trade History", icon: BarChart3 },
      { href: "/admin/dex-arbitrage", label: "Dex Arbitrage", icon: GitCompare },
      { href: "/admin/strategies", label: "Strategies", icon: LineChart },
    ],
  },
  {
    id: "users",
    label: "User Management",
    items: [
      { href: "/admin/users", label: "Users", icon: Users },
      { href: "/admin/members", label: "Members", icon: UsersRound },
      { href: "/admin/network", label: "Network Tree", icon: GitBranch },
    ],
  },
  {
    id: "financials",
    label: "Financials",
    items: [
      { href: "/admin/revenue", label: "Revenue Analytics", icon: Download },
      { href: "/admin/payouts", label: "Payouts", icon: Banknote },
      { href: "/admin/funds", label: "Funds", icon: Wallet },
      { href: "/admin/coupons", label: "Coupons", icon: Tag },
    ],
  },
  {
    id: "system",
    label: "System",
    items: [
      { href: "/admin/support", label: "Support", icon: MessageSquare },
      { href: "/admin/notifications", label: "Notifications", icon: Bell },
      { href: "/admin/downloads", label: "Downloads", icon: FolderOpen },
      { href: "/admin/settings", label: "Settings", icon: Settings },
    ],
  },
];

function isLinkActive(pathname: string, href: string): boolean {
  if (href === "/admin") return pathname === "/admin";
  if (href === "/admin/strategies") return pathname === "/admin/strategies";
  return pathname.startsWith(href);
}

function groupHasActive(pathname: string, items: NavItem[]): boolean {
  return items.some((item) => isLinkActive(pathname, item.href));
}

function buildInitialExpanded(pathname: string): Record<string, boolean> {
  const state: Record<string, boolean> = {};
  for (const group of navGroups) {
    state[group.id] =
      group.id === "overview" || groupHasActive(pathname, group.items);
  }
  return state;
}

type AdminSidebarProps = {
  isMobileOpen: boolean;
  onClose: () => void;
};

export function AdminSidebar({ isMobileOpen, onClose }: AdminSidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { logout } = useAuth();
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() =>
    buildInitialExpanded(pathname),
  );

  useEffect(() => {
    setExpanded((prev) => {
      const next = { ...prev };
      for (const group of navGroups) {
        if (groupHasActive(pathname, group.items)) {
          next[group.id] = true;
        }
      }
      return next;
    });
  }, [pathname]);

  async function handleLogout() {
    onClose();
    await logout();
    router.replace("/login");
  }

  function toggleGroup(id: string) {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  return (
    <aside
      className={`glass-card fixed inset-y-0 left-0 z-50 flex h-screen w-64 max-w-[85vw] shrink-0 flex-col border border-glassBorder p-4 shadow-2xl transition-transform duration-200 ease-out sm:p-5 md:sticky md:top-0 md:z-auto md:max-w-none md:translate-x-0 md:p-6 md:shadow-none md:transition-none ${
        isMobileOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
      }`}
    >
      <div className="mb-6 flex items-start justify-between gap-2 md:mb-8">
        <div className="min-w-0">
          <BrandLogo href="/admin" width={150} height={40} />
          <p className="mt-2 text-xs font-medium text-white/50">Admin Panel</p>
        </div>
        <button
          type="button"
          aria-label="Close menu"
          onClick={onClose}
          className="shrink-0 rounded-lg border border-white/10 p-2 text-white/70 transition hover:bg-white/10 hover:text-white md:hidden"
        >
          <X className="h-5 w-5" aria-hidden />
        </button>
      </div>

      <nav className="flex flex-1 flex-col gap-2 overflow-y-auto overscroll-contain pr-0.5">
        {navGroups.map((group) => {
          const isOpen = expanded[group.id] ?? false;
          const activeInGroup = groupHasActive(pathname, group.items);

          return (
            <div key={group.id} className="min-w-0">
              <button
                type="button"
                onClick={() => toggleGroup(group.id)}
                aria-expanded={isOpen}
                className={`flex w-full items-center justify-between gap-2 rounded-lg px-2 py-2 text-left text-[11px] font-semibold uppercase tracking-wider transition hover:bg-white/[0.04] ${
                  activeInGroup ? "text-primary/90" : "text-white/40"
                }`}
              >
                <span>{group.label}</span>
                <ChevronDown
                  className={`h-3.5 w-3.5 shrink-0 transition-transform duration-200 ${
                    isOpen ? "rotate-0" : "-rotate-90"
                  }`}
                  aria-hidden
                />
              </button>

              {isOpen ? (
                <ul className="mt-0.5 space-y-0.5 border-l border-white/[0.06] pl-2">
                  {group.items.map(({ href, label, icon: Icon }) => {
                    const active = isLinkActive(pathname, href);
                    return (
                      <li key={href}>
                        <Link
                          href={href}
                          onClick={onClose}
                          className={`block rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                            active
                              ? "bg-primary/15 text-primary ring-1 ring-primary/40"
                              : "text-white/70 hover:bg-white/5 hover:text-white"
                          }`}
                        >
                          <span className="inline-flex items-center gap-2">
                            <Icon className="h-4 w-4 shrink-0" aria-hidden />
                            <span className="truncate">{label}</span>
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </div>
          );
        })}
      </nav>

      <div className="mt-auto space-y-3 border-t border-white/[0.06] pt-4 md:pt-6">
        <button
          type="button"
          onClick={() => void handleLogout()}
          className="w-full rounded-lg border border-white/15 bg-white/[0.04] px-3 py-2.5 text-sm font-medium text-white/80 transition hover:bg-white/10 hover:text-white"
        >
          Logout
        </button>
        <p className="text-xs text-white/40">Midnight Neon · Admin</p>
      </div>
    </aside>
  );
}
