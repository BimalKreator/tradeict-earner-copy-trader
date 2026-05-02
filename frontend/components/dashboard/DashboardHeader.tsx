"use client";

import { useRouter } from "next/navigation";

export function DashboardHeader() {
  const router = useRouter();

  function handleLogout() {
    localStorage.removeItem("token");
    router.push("/login");
  }

  return (
    <header className="glass-card sticky top-0 z-40 border-b border-glassBorder px-4 py-4 md:px-8">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
        <div>
          <span className="text-xs font-medium uppercase tracking-widest text-primary">
            TradeICT
          </span>
          <p className="text-lg font-semibold leading-tight text-white">
            TradeICT Earner
          </p>
        </div>
        <button
          type="button"
          onClick={handleLogout}
          className="rounded-lg border border-glassBorder bg-white/[0.04] px-4 py-2 text-sm font-medium text-white/90 transition hover:bg-white/10 hover:text-white"
        >
          Logout
        </button>
      </div>
    </header>
  );
}
