"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { BrandLogo } from "@/components/BrandLogo";
import { useAuth } from "@/context/AuthContext";
import {
  BarChart3,
  Download,
  FolderOpen,
  GitCompare,
  GitBranch,
  LayoutDashboard,
  LineChart,
  Bell,
  MessageSquare,
  Radio,
  Settings,
  Tag,
  Users,
  Wallet,
  X,
} from "lucide-react";

const links = [
  { href: "/admin", label: "Dashboard", icon: LayoutDashboard },
  { href: "/admin/trade-history", label: "Trade History", icon: BarChart3 },
  { href: "/admin/users", label: "Users", icon: Users },
  { href: "/admin/strategies", label: "Strategies", icon: LineChart },
  {
    href: "/admin/strategies/future-hedge",
    label: "Future Hedge",
    icon: GitBranch,
  },
  { href: "/admin/coupons", label: "Coupons", icon: Tag },
  { href: "/admin/notifications", label: "Notifications", icon: Bell },
  { href: "/admin/support", label: "Support", icon: MessageSquare },
  { href: "/admin/live-trades", label: "Live trades", icon: Radio },
  { href: "/admin/dex-arbitrage", label: "Dex Arbitrage", icon: GitCompare },
  { href: "/admin/funds", label: "Funds", icon: Wallet },
  { href: "/admin/revenue", label: "Revenue Analytics", icon: Download },
  { href: "/admin/downloads", label: "Downloads", icon: FolderOpen },
  { href: "/admin/settings", label: "Settings", icon: Settings },
];

type AdminSidebarProps = {
  isMobileOpen: boolean;
  onClose: () => void;
};

export function AdminSidebar({ isMobileOpen, onClose }: AdminSidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { logout } = useAuth();

  async function handleLogout() {
    onClose();
    await logout();
    router.replace("/login");
  }

  return (
    <aside
      className={`glass-card fixed inset-y-0 left-0 z-50 flex h-screen w-64 max-w-[85vw] shrink-0 flex-col border border-glassBorder p-6 shadow-2xl transition-transform duration-200 ease-out md:sticky md:top-0 md:z-auto md:max-w-none md:translate-x-0 md:shadow-none md:transition-none ${
        isMobileOpen ? "translate-x-0" : "-translate-x-full"
      }`}
    >
      <div className="mb-8 flex items-start justify-between gap-2">
        <div>
          <BrandLogo href="/admin" width={150} height={40} />
          <p className="mt-2 text-xs font-medium text-white/50">Admin Panel</p>
        </div>
        <button
          type="button"
          aria-label="Close menu"
          onClick={onClose}
          className="rounded-lg border border-white/10 p-2 text-white/70 transition hover:bg-white/10 hover:text-white md:hidden"
        >
          <X className="h-5 w-5" aria-hidden />
        </button>
      </div>
      <nav className="flex flex-1 flex-col gap-1 overflow-y-auto">
        {links.map(({ href, label, icon: Icon }) => {
          const active =
            href === "/admin"
              ? pathname === "/admin"
              : href === "/admin/strategies"
                ? pathname === "/admin/strategies"
                : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              onClick={onClose}
              className={`rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                active
                  ? "bg-primary/15 text-primary ring-1 ring-primary/40"
                  : "text-white/70 hover:bg-white/5 hover:text-white"
              }`}
            >
              <span className="inline-flex items-center gap-2">
                <Icon className="h-4 w-4" />
                {label}
              </span>
            </Link>
          );
        })}
      </nav>
      <div className="mt-auto space-y-3 pt-6">
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
