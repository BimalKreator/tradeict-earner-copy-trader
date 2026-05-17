"use client";

import { DexArbitrageTable } from "@/components/DexArbitrageTable";
import { GitCompare } from "lucide-react";

export default function DexArbitragePage() {
  return (
    <div className="mx-auto max-w-7xl space-y-8">
      <header className="flex items-start gap-3">
        <div className="rounded-xl border border-slate-800 bg-slate-900 p-3">
          <GitCompare className="h-6 w-6 text-cyan-400" aria-hidden />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">
            Dex Arbitrage
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Compare prices across major DEXs and spot cross-venue spreads for the top 100 tokens.
          </p>
        </div>
      </header>
      <DexArbitrageTable />
    </div>
  );
}
