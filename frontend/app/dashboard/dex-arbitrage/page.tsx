"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { DexArbitrageTable } from "@/components/DexArbitrageTable";

export default function DexArbitragePage() {
  const router = useRouter();
  const { isLoading, user } = useAuth();
  const hasAccess = user?.arbAccess === true;

  useEffect(() => {
    if (!isLoading && !hasAccess) {
      router.replace("/dashboard");
    }
  }, [isLoading, hasAccess, router]);

  if (isLoading) {
    return (
      <div className="flex justify-center py-24">
        <Loader2 className="h-8 w-8 animate-spin text-cyan-400" aria-hidden />
      </div>
    );
  }

  if (!hasAccess) {
    return (
      <div className="flex justify-center py-24">
        <Loader2 className="h-8 w-8 animate-spin text-cyan-400" aria-hidden />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-white">Dex Arbitrage</h1>
        <p className="mt-1 text-sm text-slate-400">
          Live cross-DEX price spreads for monitored tokens.
        </p>
      </div>
      <DexArbitrageTable />
    </div>
  );
}
