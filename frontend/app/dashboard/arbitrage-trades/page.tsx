"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/context/AuthContext";

export default function ArbitrageTradesPage() {
  const router = useRouter();
  const { isLoading, user } = useAuth();
  const hasAccess = user?.arbAccess === true;

  useEffect(() => {
    if (!isLoading && !hasAccess) {
      router.replace("/dashboard");
    }
  }, [isLoading, hasAccess, router]);

  if (isLoading || !hasAccess) {
    return (
      <div className="flex justify-center py-24">
        <Loader2 className="h-8 w-8 animate-spin text-cyan-400" aria-hidden />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl space-y-8">
      <h1 className="text-2xl font-semibold text-white">Arbitrage Trades</h1>
      <p className="text-slate-400">Arbitrage trade history — coming soon.</p>
    </div>
  );
}
