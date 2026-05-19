"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { LayoutGrid, LogOut, Menu, User, X } from "lucide-react";
import { NotificationBell } from "@/components/common/NotificationBell";

const API_BASE = process.env.NEXT_PUBLIC_API_URL;

type MeUser = {
  name: string | null;
  email: string;
};

type DashboardHeaderProps = {
  onMenuClick: () => void;
  mobileNavOpen: boolean;
};

function displayNameFromUser(user: MeUser | null): string {
  if (!user) return "User";
  const name = user.name?.trim();
  if (name) return name;
  const local = user.email.split("@")[0]?.trim();
  return local || "User";
}

export function DashboardHeader({ onMenuClick, mobileNavOpen }: DashboardHeaderProps) {
  const router = useRouter();
  const menuRef = useRef<HTMLDivElement>(null);
  const [user, setUser] = useState<MeUser | null>(null);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);

  const greetingName = displayNameFromUser(user);

  const loadUser = useCallback(async () => {
    const token =
      typeof window !== "undefined" ? localStorage.getItem("token") : null;
    if (!token) return;
    try {
      const res = await fetch(`${API_BASE}/user/me`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = (await res.json()) as MeUser;
      if (typeof data.email === "string") {
        setUser({
          name: typeof data.name === "string" ? data.name : null,
          email: data.email,
        });
      }
    } catch {
      /* keep fallback greeting */
    }
  }, []);

  useEffect(() => {
    void loadUser();
  }, [loadUser]);

  useEffect(() => {
    if (!accountMenuOpen) return;
    function onPointerDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setAccountMenuOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setAccountMenuOpen(false);
    }
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [accountMenuOpen]);

  async function handleLogout() {
    const token =
      typeof window !== "undefined" ? localStorage.getItem("token") : null;
    try {
      await fetch(`${API_BASE}/auth/logout`, {
        method: "POST",
        credentials: "include",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
    } catch {
      /* proceed with client logout */
    }
    localStorage.removeItem("token");
    setAccountMenuOpen(false);
    router.push("/login");
  }

  function openSidebarFromMenu() {
    setAccountMenuOpen(false);
    onMenuClick();
  }

  return (
    <header className="sticky top-0 z-40 border-b border-white/10 bg-gray-950/95 px-4 py-3 shadow-sm backdrop-blur-md md:px-8 lg:px-10">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1 pr-2">
          <p className="truncate text-base font-semibold tracking-tight text-white sm:text-lg">
            Hello{" "}
            <span className="text-primary">{greetingName}</span>
            <span className="text-white">!</span>
          </p>
          <p className="mt-0.5 hidden truncate text-xs text-white/45 sm:block">
            {user?.email ?? "Your trading dashboard"}
          </p>
        </div>

        <div className="hidden shrink-0 items-center gap-4 md:flex">
          <NotificationBell />
          <Link
            href="/dashboard/profile"
            className="inline-flex items-center gap-2 rounded-lg border border-glassBorder bg-white/[0.04] px-4 py-2 text-sm font-medium text-white/90 transition hover:bg-white/10 hover:text-white"
          >
            <User className="h-4 w-4 opacity-90" aria-hidden />
            Profile
          </Link>
          <button
            type="button"
            onClick={handleLogout}
            className="rounded-lg border border-glassBorder bg-white/[0.04] px-4 py-2 text-sm font-medium text-white/90 transition hover:bg-white/10 hover:text-white"
          >
            Logout
          </button>
        </div>

        <div ref={menuRef} className="relative shrink-0 md:hidden">
          <button
            type="button"
            onClick={() => setAccountMenuOpen((open) => !open)}
            className="rounded-lg border border-glassBorder bg-white/[0.04] p-2.5 text-white/90 transition hover:bg-white/10"
            aria-label={accountMenuOpen ? "Close menu" : "Open account menu"}
            aria-expanded={accountMenuOpen}
          >
            {accountMenuOpen ? (
              <X className="h-5 w-5" strokeWidth={2} />
            ) : (
              <Menu className="h-5 w-5" strokeWidth={2} />
            )}
          </button>

          {accountMenuOpen ? (
            <div
              className="absolute right-0 z-50 mt-2 w-[min(100vw-2rem,20rem)] overflow-hidden rounded-xl border border-glassBorder bg-gray-950 shadow-2xl shadow-black/50"
              role="menu"
            >
              <div className="border-b border-white/10 px-4 py-3">
                <p className="truncate text-sm font-medium text-white">{greetingName}</p>
                <p className="truncate text-xs text-white/50">{user?.email}</p>
              </div>

              <div className="flex flex-col gap-1 p-2">
                <button
                  type="button"
                  role="menuitem"
                  onClick={openSidebarFromMenu}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium text-white/90 transition hover:bg-white/10"
                >
                  <LayoutGrid className="h-4 w-4 shrink-0 text-primary" aria-hidden />
                  Navigation
                </button>

                <div
                  role="menuitem"
                  className="flex items-center justify-between gap-3 rounded-lg px-3 py-2.5 hover:bg-white/10"
                >
                  <span className="text-sm font-medium text-white/90">Notifications</span>
                  <NotificationBell />
                </div>

                <Link
                  href="/dashboard/profile"
                  role="menuitem"
                  onClick={() => setAccountMenuOpen(false)}
                  className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-white/90 transition hover:bg-white/10"
                >
                  <User className="h-4 w-4 shrink-0 text-primary" aria-hidden />
                  My Profile
                </Link>

                <button
                  type="button"
                  role="menuitem"
                  onClick={handleLogout}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium text-red-300 transition hover:bg-red-500/10"
                >
                  <LogOut className="h-4 w-4 shrink-0" aria-hidden />
                  Logout
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}
