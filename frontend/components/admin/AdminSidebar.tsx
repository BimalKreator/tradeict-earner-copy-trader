"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

const links = [
  { href: "/admin", label: "Dashboard" },
  { href: "/admin/users", label: "Users" },
  { href: "/admin/strategies", label: "Strategies" },
  { href: "/admin/live-trades", label: "Live trades" },
  { href: "/admin/funds", label: "Funds" },
  { href: "/admin/revenue", label: "Revenue Analytics" },
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
        {links.map(({ href, label }) => {
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
              {label}
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
