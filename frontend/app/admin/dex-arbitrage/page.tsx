"use client";

import { DexArbitrageTable } from "@/components/DexArbitrageTable";
import { GitCompare } from "lucide-react";

export default function AdminDexArbitragePage() {
  return (
    <div className="mx-auto max-w-7xl space-y-8">
      <header className="flex items-start gap-3">
        <div className="rounded-xl border border-glassBorder bg-white/[0.03] p-3">
          <GitCompare className="h-6 w-6 text-cyan-400" aria-hidden />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">
            Dex Arbitrage
          </h1>
          <p className="mt-1 text-sm text-white/55">
            Monitor cross-DEX spreads for the top 100 tokens. Data is cached to respect API rate
            limits.
          </p>
        </div>
      </header>
      <DexArbitrageTable />
    </div>
  );
}
