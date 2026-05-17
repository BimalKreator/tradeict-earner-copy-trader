"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  BarChart3,
  Download,
  FolderOpen,
  LayoutDashboard,
  LineChart,
  Settings,
  Users,
  Wallet,
} from "lucide-react";

const links = [
  { href: "/admin", label: "Dashboard", icon: LayoutDashboard },
  { href: "/admin/trade-history", label: "Trade History", icon: BarChart3 },
  { href: "/admin/strategies", label: "Strategies", icon: LineChart },
  { href: "/admin/live-trades", label: "Live trades", icon: Users },
  { href: "/admin/funds", label: "Funds", icon: Wallet },
  { href: "/admin/revenue", label: "Revenue Analytics", icon: Download },
  { href: "/admin/downloads", label: "Downloads", icon: FolderOpen },
  { href: "/admin/settings", label: "Settings", icon: Settings },
];

export function AdminSidebar() {
  const pathname = usePathname();
  const router = useRouter();

  function handleLogout() {
    localStorage.removeItem("token");
    router.replace("/login");
  }

  return (
    <aside className="glass-card flex h-screen w-64 shrink-0 flex-col border border-glassBorder p-6 md:sticky md:top-0">
      <div className="mb-8">
        <p className="text-xs font-medium uppercase tracking-widest text-primary">
          TradeICT
        </p>
        <h1 className="mt-1 text-lg font-semibold text-white">Admin Panel</h1>
      </div>
      <nav className="flex flex-1 flex-col gap-1">
        {links.map(({ href, label, icon: Icon }) => {
          const active =
            href === "/admin"
              ? pathname === "/admin"
              : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
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
          onClick={handleLogout}
          className="w-full rounded-lg border border-white/15 bg-white/[0.04] px-3 py-2.5 text-sm font-medium text-white/80 transition hover:bg-white/10 hover:text-white"
        >
          Logout
        </button>
        <p className="text-xs text-white/40">Midnight Neon · Admin</p>
      </div>
    </aside>
  );
}
